import test from 'node:test'
import assert from 'node:assert/strict'
import { createProgressNotifier } from '../src/services/progress-notifier.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function harness({ ackDelayMs = 20, intervalMs = 30, maxHeartbeats = 3 } = {}) {
  const sent = []
  const provider = { sendText: async (a) => { sent.push(a.text); return {} } }
  const channel = { providerBotId: 'bot', toProviderUserId: 'u1', contextToken: 'tok' }
  const notifier = createProgressNotifier({ provider, channel, ackDelayMs, intervalMs, maxHeartbeats })
  return { sent, notifier }
}

test('short tasks get no ack (no interruption)', async () => {
  const { sent, notifier } = harness()
  notifier.start()
  await sleep(5) // 任务很快完成
  notifier.stop()
  await sleep(40)
  assert.deepEqual(sent, [])
})

test('long tasks get an ack then periodic heartbeats, capped', async () => {
  const { sent, notifier } = harness({ ackDelayMs: 10, intervalMs: 25, maxHeartbeats: 2 })
  notifier.start()
  await sleep(200) // 模拟长任务
  notifier.stop()
  assert.ok(sent.length >= 2, `expected ack + heartbeats, got ${sent.length}`)
  assert.match(sent[0], /收到，正在处理/)
  assert.match(sent[1], /仍在处理/)
  assert.ok(sent.length <= 3, `heartbeats must be capped: ${sent.length}`) // ack + 2 heartbeats
})

test('stop() silences pending ack and heartbeats', async () => {
  const { sent, notifier } = harness({ ackDelayMs: 20, intervalMs: 20 })
  notifier.start()
  await sleep(5)
  notifier.stop()
  await sleep(80)
  assert.deepEqual(sent, [])
})

test('no channel token → never sends (web chat / unbound user)', async () => {
  const sent = []
  const provider = { sendText: async (a) => { sent.push(a.text); return {} } }
  const notifier = createProgressNotifier({ provider, channel: { providerBotId: 'b', toProviderUserId: 'u', contextToken: '' }, ackDelayMs: 5, intervalMs: 10 })
  notifier.start()
  await sleep(50)
  notifier.stop()
  assert.deepEqual(sent, [])
})

test('ackDelayMs <= 0 disables the notifier entirely (ADR-0037: chat path default)', async () => {
  for (const ackDelayMs of [0, -1]) {
    const { sent, notifier } = harness({ ackDelayMs, intervalMs: 5, maxHeartbeats: 3 })
    notifier.start()
    await sleep(60)
    notifier.stop()
    assert.equal(sent.length, 0, `ackDelayMs=${ackDelayMs} 必须彻底静默，实际发了 ${sent.length} 条`)
  }
})
