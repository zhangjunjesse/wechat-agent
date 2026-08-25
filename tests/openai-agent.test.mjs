import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { OpenAICompatibleAgent } from '../src/llm/openai-compatible-agent.mjs'
import { SessionStore } from '../src/services/session-store.mjs'
import { MemoryStore } from '../src/services/memory-store.mjs'

test('agent sends isolated user history and nickname context', async () => {
  const calls = []
  const file = path.join(os.tmpdir(), `oa-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const mfile = path.join(os.tmpdir(), `oam-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  try {
    const store = new SessionStore({ file })
    const mstore = new MemoryStore({ file: mfile })
    const agent = new OpenAICompatibleAgent({
      apiKey: 'test', sessionStore: store, memoryStore: mstore,
      contextProvider: async (id) => ({ nickname: id === 'a' ? '张三' : '李四' }),
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body)
        calls.push(body)
        // memory-extractor requests (single user message with the extract prompt) return []
        if (body.messages.length === 1 && /记忆提取器/.test(body.messages[0].content)) return { ok: true, json: async () => ({ choices: [{ message: { content: '[]' } }] }) }
        return { ok: true, json: async () => ({ choices: [{ message: { content: '收到' } }] }) }
      },
    })
    await agent.respond({ userId: 'a', text: '你好', profile: { nickname: '张三', wxid: 'wx-a' } })
    await agent.respond({ userId: 'b', text: '你好', profile: { nickname: '李四', wxid: 'wx-b' } })
    // Wait for the best-effort async absorb to settle so calls are complete.
    await new Promise((r) => setTimeout(r, 50))
    const mainCalls = calls.filter((b) => !(b.messages.length === 1 && /记忆提取器/.test(b.messages[0].content)))
    assert.ok(mainCalls.length >= 2)
    assert.match(mainCalls[0].messages[0].content, /张三/)
    assert.match(mainCalls[1].messages[0].content, /李四/)
    // user 'b' transcript is isolated: exactly one user turn in its main call
    assert.equal(mainCalls[1].messages.filter((m) => m.role === 'user').length, 1)
  } finally {
    try { fs.rmSync(file, { force: true }) } catch (e) {}
    try { fs.rmSync(mfile, { force: true }) } catch (e) {}
  }
})
