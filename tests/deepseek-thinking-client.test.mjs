import test from 'node:test'
import assert from 'node:assert/strict'
import { wrapClientForDeepSeek } from '../src/llm/deepseek-thinking-client.mjs'

/** Build a fake OpenAI client whose chat.completions.create records the
 * request body and returns a controllable chat completion response. */
function fakeClient({ respond }) {
  const calls = []
  const completions = {
    create: async (body, options) => {
      calls.push({ body, options })
      return respond(body)
    },
  }
  return { client: { chat: { completions } }, calls }
}

function completionWithReasoning(reasoning) {
  return { choices: [{ message: { role: 'assistant', content: 'ok', reasoning_content: reasoning } }] }
}

test('caches reasoning_content from responses and injects it back in order', async () => {
  const { client, calls } = fakeClient({ respond: () => completionWithReasoning(`think-${calls.length}`) })
  const { client: wrapped, reset } = wrapClientForDeepSeek(client)
  reset()

  // Turn 1: no history yet — nothing injected, response caches reasoning #1
  await wrapped.chat.completions.create({ messages: [{ role: 'user', content: 'u1' }] })
  // Turn 2: one assistant message in history — gets reasoning #1 injected
  await wrapped.chat.completions.create({ messages: [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1', tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 't1', content: 'r1' }, { role: 'user', content: 'u2' }] })
  // Turn 3: two assistant messages in history — injected #1 and #2 in order
  await wrapped.chat.completions.create({ messages: [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2', tool_calls: [{ id: 't2', type: 'function', function: { name: 'g', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 't2', content: 'r2' }, { role: 'user', content: 'u3' }] })

  const msgs = (i) => calls[i].body.messages
  assert.equal(msgs(0).length, 1) // no injection on first call
  assert.equal(msgs(1).filter((m) => m.role === 'assistant')[0].reasoning_content, 'think-1')
  const turn3 = msgs(2).filter((m) => m.role === 'assistant')
  assert.deepEqual(turn3.map((m) => m.reasoning_content), ['think-1', 'think-2'])
})

test('does not double-inject when the message already carries reasoning_content', async () => {
  const { client, calls } = fakeClient({ respond: () => completionWithReasoning('fresh') })
  const { client: wrapped, reset } = wrapClientForDeepSeek(client)
  reset()
  await wrapped.chat.completions.create({ messages: [{ role: 'user', content: 'u' }] }) // cache 'fresh'
  await wrapped.chat.completions.create({ messages: [{ role: 'assistant', content: 'a', reasoning_content: 'already-there' }, { role: 'user', content: 'u2' }] })
  const assistant = calls[1].body.messages.find((m) => m.role === 'assistant')
  assert.equal(assistant.reasoning_content, 'already-there')
})

test('reset clears the cache so a new run starts clean', async () => {
  const { client } = fakeClient({ respond: () => completionWithReasoning('stale') })
  const { client: wrapped, reset } = wrapClientForDeepSeek(client)
  reset()
  await wrapped.chat.completions.create({ messages: [{ role: 'user', content: 'u' }] })
  reset()
  const body = { messages: [{ role: 'assistant', content: 'a' }, { role: 'user', content: 'u2' }] }
  await wrapped.chat.completions.create(body)
  const assistant = body.messages.find((m) => m.role === 'assistant')
  assert.equal('reasoning_content' in assistant, false)
})

test('responses without reasoning_content do not extend the cache', async () => {
  const { client, calls } = fakeClient({ respond: () => ({ choices: [{ message: { role: 'assistant', content: 'plain' } }] }) })
  const { client: wrapped, reset } = wrapClientForDeepSeek(client)
  reset()
  await wrapped.chat.completions.create({ messages: [{ role: 'user', content: 'u' }] })
  await wrapped.chat.completions.create({ messages: [{ role: 'assistant', content: 'a' }, { role: 'user', content: 'u2' }] })
  const assistant = calls[1].body.messages.find((m) => m.role === 'assistant')
  assert.equal('reasoning_content' in assistant, false)
})

test('concurrent runs can misalign the shared reasoning cache — must be serialized at the caller', async () => {
  // 演示：两个 run 并发时，run B 的 reset() 会清掉 run A 尚未消费的缓存，
  // 导致 run A 下一轮 assistant 消息拿不到 reasoning_content（DeepSeek 400）。
  // AgentsSdkAgent.respond 已用 createSerialQueue 串行化 run，避免此场景。
  const delay = (ms) => new Promise((r) => setTimeout(r, ms))
  const { client, calls } = fakeClient({
    respond: async () => { await delay(10); return completionWithReasoning(`think-${calls.length}`) },
  })
  const { client: wrapped, reset } = wrapClientForDeepSeek(client)
  reset()
  // run A turn1 还在飞 → run B 开始（reset 清缓存）→ run A turn2 的 assistant 消息将缺 reasoning
  const a1 = wrapped.chat.completions.create({ messages: [{ role: 'user', content: 'a1' }] })
  const bReset = reset()
  const b1 = wrapped.chat.completions.create({ messages: [{ role: 'user', content: 'b1' }] })
  const a2 = wrapped.chat.completions.create({ messages: [{ role: 'assistant', content: 'aa', tool_calls: [{ id: 't', type: 'function', function: { name: 'f', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 't', content: 'r' }, { role: 'user', content: 'a2' }] })
  await Promise.all([a1, bReset, b1, a2])
  const a2Assistant = calls.find((c) => c.body.messages.some((m) => m.role === 'assistant' && m.content === 'aa'))
  // 并发下 run A 的 turn2 未拿到缓存注入（'reasoning_content' in m === false）→ 正是 400 根因
  assert.equal('reasoning_content' in a2Assistant.body.messages.find((m) => m.role === 'assistant'), false)
})
