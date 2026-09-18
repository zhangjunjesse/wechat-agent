import test from 'node:test'
import assert from 'node:assert/strict'
import { MessageRouter } from '../src/services/message-router.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function setup({ agent, progress = { ackDelayMs: 5, intervalMs: 10_000 } } = {}) {
  const sent = []
  const provider = { sendText: async (a) => { sent.push(a); return { providerMessageId: `out-${sent.length}` } } }
  const bindings = [{ providerBotId: 'bot-1', userId: 'u1', profile: { providerUserId: 'wx-1' } }]
  const router = new MessageRouter({ bindings, provider, agent, allowPeerUsers: false, requireVerified: false, progress })
  return { sent, router }
}

const inbound = (text) => ({ providerBotId: 'bot-1', providerMessageId: `m-${text}`, providerUserId: 'wx-1', text, contextToken: 'tok-1' })

test('a failing agent turn notifies the user instead of failing silently, without leaking the raw error', async () => {
  // 2026-09-18 事故整改：用户不该看到 "402 litellm.APIError: ..." 这类原始报错——
  // 只看到口语化的一句话，原始异常信息只进服务端日志（failure-messaging.mjs）。
  const { sent, router } = setup({ agent: { respond: async () => { throw new Error('boom: model exploded') } } })
  await assert.rejects(() => router.handleInbound(inbound('你好')), /boom/)
  const texts = sent.map((s) => s.text)
  assert.ok(texts.some((t) => /⚠️/.test(t)), `expected error notice, got: ${JSON.stringify(texts)}`)
  assert.ok(texts.every((t) => !/boom: model exploded/.test(t)), '原始异常信息不应发给用户')
})

test('a slow turn gets an ack while working, then the result (long-task experience)', async () => {
  const { sent, router } = setup({
    agent: { respond: async () => { await sleep(60); return { text: '结果：42' } } },
  })
  const result = await router.handleInbound(inbound('算一下'))
  assert.equal(result.text, '结果：42')
  const texts = sent.map((s) => s.text)
  assert.ok(texts.some((t) => /收到，正在处理/.test(t)), `expected ack, got: ${JSON.stringify(texts)}`)
  assert.equal(texts[texts.length - 1], '结果：42') // 结果最后到
})

test('a fast turn has no ack (short tasks are not interrupted)', async () => {
  const { sent, router } = setup({ agent: { respond: async () => ({ text: '现在 17:00' }) } })
  await router.handleInbound(inbound('现在几点'))
  await sleep(30)
  const texts = sent.map((s) => s.text)
  assert.deepEqual(texts, ['现在 17:00'])
})

test('by default a slow turn sends NO ack — only the result (ADR-0037)', async () => {
  // 负向保证：不传 progress（= 生产装配路径，createApp 不传）时，哪怕这一轮很慢，
  // 用户也只收到答案一条。实测基线 8-9 秒压在旧 8 秒阈值上，每句闲聊都被 ack。
  const sent = []
  const provider = { sendText: async (a) => { sent.push(a); return { providerMessageId: `out-${sent.length}` } } }
  const bindings = [{ providerBotId: 'bot-1', userId: 'u1', profile: { providerUserId: 'wx-1' } }]
  const router = new MessageRouter({
    bindings, provider, allowPeerUsers: false, requireVerified: false,
    agent: { respond: async () => { await sleep(60); return { text: '结果：42' } } },
  })
  const result = await router.handleInbound(inbound('算一下'))
  assert.equal(result.text, '结果：42')
  assert.deepEqual(sent.map((s) => s.text), ['结果：42'], '默认不该有 ack/心跳')
})

test('CHAT_PROGRESS_ACK_MS can bring the ack back at a higher threshold', async () => {
  const prev = process.env.CHAT_PROGRESS_ACK_MS
  process.env.CHAT_PROGRESS_ACK_MS = '5'
  try {
    const sent = []
    const provider = { sendText: async (a) => { sent.push(a); return { providerMessageId: `out-${sent.length}` } } }
    const bindings = [{ providerBotId: 'bot-1', userId: 'u1', profile: { providerUserId: 'wx-1' } }]
    const router = new MessageRouter({
      bindings, provider, allowPeerUsers: false, requireVerified: false,
      agent: { respond: async () => { await sleep(60); return { text: '结果：42' } } },
    })
    await router.handleInbound(inbound('算一下'))
    assert.ok(sent.some((s) => /收到，正在处理/.test(s.text)), '显式开启时机制仍在')
  } finally {
    if (prev === undefined) delete process.env.CHAT_PROGRESS_ACK_MS
    else process.env.CHAT_PROGRESS_ACK_MS = prev
  }
})
