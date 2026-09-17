import test from 'node:test'
import assert from 'node:assert/strict'
import { wrapClientForDeepSeek, wrapClientForModel, isDeepSeekModel } from '../src/llm/deepseek-thinking-client.mjs'

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

test('injection aligns to the TAIL: history assistant messages stay untouched, this-run tool-call gets the reasoning', async () => {
  // 生产事故回归（232 条消息 400）：113 条历史 assistant + 本轮 tool_calls 消息。
  // 早期实现从第一条 assistant 开始填 → reasoning 错填到最早的历史消息 → 本轮
  // tool_calls 消息缺 reasoning_content → DeepSeek 400。
  const { client, calls } = fakeClient({ respond: () => completionWithReasoning('R1') })
  const { client: wrapped, reset } = wrapClientForDeepSeek(client)
  reset()
  const history = []
  for (let i = 0; i < 113; i++) {
    history.push({ role: 'user', content: `u${i}` })
    history.push({ role: 'assistant', content: `a${i}` })
  }
  // run 内第一轮：只有历史 + 新问题，不注入
  await wrapped.chat.completions.create({ messages: [...history, { role: 'user', content: '新问题' }] })
  assert.ok(!calls[0].body.messages.some((m) => 'reasoning_content' in m), '历史请求不应被注入')
  // run 内第二轮：请求尾部多了一条本轮 tool_calls 消息 → reasoning 必须注入到它
  const toolCallMsg = { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lark_read_doc', arguments: '{}' } }], index: 0 }
  await wrapped.chat.completions.create({
    messages: [...history, { role: 'user', content: '新问题' }, toolCallMsg, { role: 'tool', tool_call_id: 'call_1', content: '结果' }],
  })
  const sent = calls[1].body.messages
  const assistants = sent.filter((m) => m.role === 'assistant')
  assert.ok(!('reasoning_content' in assistants[0]), '最早的历史 assistant 不应被注入')
  assert.ok(!('reasoning_content' in assistants[1]), '其余历史也不应被注入')
  const mine = assistants[assistants.length - 1]
  assert.equal(mine.reasoning_content, 'R1')
  assert.ok(mine.tool_calls, '注入不应破坏 tool_calls')
})

test('every tool_calls message gets reasoning_content even when the cache has fewer entries or is empty', async () => {
  // 生产事故（第二轮）：一轮 run 内有 2 条 tool_calls 消息，但某轮响应没有 reasoning
  // → rc 比本轮 tool_calls 消息少 → 数量对齐漏掉较早那条 → 400。
  const { client, calls } = fakeClient({ respond: () => completionWithReasoning('R1') })
  const { client: wrapped, reset } = wrapClientForDeepSeek(client)
  reset()
  const tc1 = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }] }
  const tc2 = { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } }] }

  // 缓存为空 + 请求里已有 tool_calls 消息 → 也要补上（否则 400）
  await wrapped.chat.completions.create({ messages: [{ role: 'user', content: 'u' }, tc1, { role: 'tool', tool_call_id: 'c1', content: 'r' }] })
  const first = calls[0].body.messages.filter((m) => m.role === 'assistant')
  assert.ok(first.every((m) => typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0), 'rc 为空时 tool_calls 消息也要补齐 reasoning_content')

  // 缓存只有 1 条，但请求里有 2 条本轮 tool_calls 消息 → 两条都必须带
  await wrapped.chat.completions.create({
    messages: [{ role: 'user', content: 'u' }, tc1, { role: 'tool', tool_call_id: 'c1', content: 'r' }, tc2, { role: 'tool', tool_call_id: 'c2', content: 'r2' }],
  })
  const second = calls[1].body.messages.filter((m) => m.role === 'assistant')
  assert.equal(second.length, 2)
  for (const m of second) {
    assert.equal(typeof m.reasoning_content, 'string')
    assert.ok(m.reasoning_content.length > 0, '每条 tool_calls 消息都必须有 reasoning_content')
  }
  assert.equal(second[second.length - 1].reasoning_content, 'R1') // 最后一条拿到真实值
})

test('a tool_calls message carrying reasoning_content: null is still filled (SDK providerData case)', async () => {
  // SDK 的 OpenAIChatCompletionsModel 会在 tool_call 消息上带 reasoning_content: null；
  // 用 `'reasoning_content' in m` 判断会放过它 → DeepSeek 400（生产第三轮复现）。
  const { client, calls } = fakeClient({ respond: () => completionWithReasoning('R') })
  const { client: wrapped, reset } = wrapClientForDeepSeek(client)
  reset()
  const tcNull = { role: 'assistant', content: null, reasoning_content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }] }
  await wrapped.chat.completions.create({ messages: [{ role: 'user', content: 'u' }, tcNull, { role: 'tool', tool_call_id: 'c1', content: 'r' }] })
  const sent = calls[0].body.messages.find((m) => m.role === 'assistant')
  assert.ok(typeof sent.reasoning_content === 'string' && sent.reasoning_content.length > 0, `null 必须被填充，实际: ${JSON.stringify(sent.reasoning_content)}`)
  assert.ok(sent.tool_calls)
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

test('concurrent cache resets no longer cause a 400: tool_calls always end up with reasoning_content', async () => {
  // 先前版本：并发 run 的 reset() 会清掉 run A 未消费的缓存 → run A 的 tool_calls 消息
  // 缺 reasoning_content → DeepSeek 400（AgentsSdkAgent 因此加了串行队列）。
  // 现在兜底逻辑保证：**任何 tool_calls 消息最终都会带上 reasoning_content**，
  // 因此即便缓存被并发清空也不会 400（串行队列仍然保留，用于减少缓存错位）。
  const delay = (ms) => new Promise((r) => setTimeout(r, ms))
  const { client, calls } = fakeClient({
    respond: async () => { await delay(10); return completionWithReasoning(`think-${calls.length}`) },
  })
  const { client: wrapped, reset } = wrapClientForDeepSeek(client)
  reset()
  const a1 = wrapped.chat.completions.create({ messages: [{ role: 'user', content: 'a1' }] })
  const bReset = reset() // 模拟并发 run B 开始，清空缓存
  const b1 = wrapped.chat.completions.create({ messages: [{ role: 'user', content: 'b1' }] })
  const a2 = wrapped.chat.completions.create({ messages: [{ role: 'assistant', content: 'aa', tool_calls: [{ id: 't', type: 'function', function: { name: 'f', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 't', content: 'r' }, { role: 'user', content: 'a2' }] })
  await Promise.all([a1, bReset, b1, a2])
  const a2Call = calls.find((c) => c.body.messages.some((m) => m.role === 'assistant' && m.content === 'aa'))
  const assistant = a2Call.body.messages.find((m) => m.role === 'assistant')
  assert.ok(typeof assistant.reasoning_content === 'string' && assistant.reasoning_content.length > 0, 'tool_calls 消息必须带上 reasoning_content（兜底防 400）')
  assert.ok(assistant.tool_calls, '不得破坏 tool_calls')
})

/* ---- 按模型名 gate（ADR-0033） -------------------------------------------- */

test('isDeepSeekModel 只认 DeepSeek 系模型名', () => {
  for (const m of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'DeepSeek-Chat', 'openrouter/deepseek-chat']) {
    assert.equal(isDeepSeekModel(m), true, `${m} 应被认作 DeepSeek`)
  }
  for (const m of ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra', 'claude-opus-5', 'claude-fable-5', '', null, undefined]) {
    assert.equal(isDeepSeekModel(m), false, `${JSON.stringify(m)} 不应被认作 DeepSeek`)
  }
})

test('非 DeepSeek 模型：请求体里不含 reasoning_content（拿到的就是原始 client）', async () => {
  const { client, calls } = fakeClient({ respond: () => completionWithReasoning('R1') })
  const { client: gated, reset, wrapped } = wrapClientForModel(client, 'gpt-5.6-sol')
  assert.equal(wrapped, false)
  assert.equal(gated, client, '非 DeepSeek 模型应拿到原始 client 本身，不是"包装但不注入"')
  reset() // no-op，不得抛

  const tc = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }] }
  await gated.chat.completions.create({ messages: [{ role: 'user', content: 'u1' }] })
  // 第二轮：上一轮响应带了 reasoning_content，且本轮有 tool_calls 消息——
  // 这正是 DeepSeek 分支会注入的场景，非 DeepSeek 分支必须一个字节都不加。
  await gated.chat.completions.create({ messages: [{ role: 'user', content: 'u1' }, tc, { role: 'tool', tool_call_id: 'c1', content: 'r' }] })
  reset()

  for (const call of calls) {
    for (const m of call.body.messages) {
      assert.equal('reasoning_content' in m, false, `非 DeepSeek 请求体不得出现 reasoning_content：${JSON.stringify(m)}`)
    }
  }
})

test('DeepSeek 模型：wrapClientForModel 与直接 wrapClientForDeepSeek 行为一致（现有行为零变化）', async () => {
  const { client, calls } = fakeClient({ respond: () => completionWithReasoning('R1') })
  const { client: gated, reset, wrapped } = wrapClientForModel(client, 'deepseek-v4-flash')
  assert.equal(wrapped, true)
  reset()
  const tc = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }] }
  await gated.chat.completions.create({ messages: [{ role: 'user', content: 'u1' }] })
  await gated.chat.completions.create({ messages: [{ role: 'user', content: 'u1' }, tc, { role: 'tool', tool_call_id: 'c1', content: 'r' }] })
  const sent = calls[1].body.messages.find((m) => m.role === 'assistant')
  assert.equal(sent.reasoning_content, 'R1')
  assert.ok(sent.tool_calls)
})

test('wrapClientForModel 的 reset 对非 DeepSeek 是 no-op 且不影响原 client', async () => {
  const { client } = fakeClient({ respond: () => completionWithReasoning('R') })
  const before = client.chat.completions.create
  const { reset } = wrapClientForModel(client, 'claude-opus-5')
  assert.equal(client.chat.completions.create, before, '非 DeepSeek 分支不得改写 client.chat.completions.create')
  assert.doesNotThrow(() => reset())
})
