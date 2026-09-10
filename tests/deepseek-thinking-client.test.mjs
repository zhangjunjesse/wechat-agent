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
