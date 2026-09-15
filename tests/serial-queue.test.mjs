import test from 'node:test'
import assert from 'node:assert/strict'
import { createSerialQueue } from '../src/llm/serial-queue.mjs'

test('serial queue runs async fns one at a time, in order', async () => {
  const q = createSerialQueue()
  const order = []
  const delay = (ms) => new Promise((r) => setTimeout(r, ms))
  const results = await Promise.all([
    q(async () => { await delay(30); order.push('a'); return 'A' }),
    q(async () => { await delay(5); order.push('b'); return 'B' }),
    q(async () => { order.push('c'); return 'C' }),
  ])
  assert.deepEqual(results, ['A', 'B', 'C'])
  assert.deepEqual(order, ['a', 'b', 'c']) // 串行：即使 a 更慢也在 b/c 之前完成
})

test('a failing fn does not block subsequent queued fns', async () => {
  const q = createSerialQueue()
  const a = q(async () => { throw new Error('boom') })
  const b = q(async () => 'ok')
  await assert.rejects(() => a, /boom/)
  assert.equal(await b, 'ok')
})
