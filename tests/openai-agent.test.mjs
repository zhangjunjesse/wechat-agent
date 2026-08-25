import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenAICompatibleAgent } from '../src/llm/openai-compatible-agent.mjs'

test('agent sends isolated user history and nickname context', async () => {
  const calls = []
  const agent = new OpenAICompatibleAgent({ apiKey: 'test', contextProvider: async (id) => ({ nickname: id === 'a' ? '张三' : '李四' }), fetchImpl: async (_url, options) => { calls.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ choices: [{ message: { content: '收到' } }] }) } } })
  await agent.respond({ userId: 'a', text: '你好', profile: { nickname: '张三', wxid: 'wx-a' } }); await agent.respond({ userId: 'b', text: '你好', profile: { nickname: '李四', wxid: 'wx-b' } })
  assert.match(calls[0].messages[0].content, /张三/); assert.match(calls[1].messages[0].content, /李四/); assert.equal(calls[1].messages.filter((m) => m.role === 'user').length, 1)
})
