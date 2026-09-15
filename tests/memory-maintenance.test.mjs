import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { MemoryStore } from '../src/services/memory-store.mjs'
import { MemoryMaintenance, IDLE_THRESHOLD_MS } from '../src/services/memory-maintenance.mjs'

const DAY = 86400000
const NOW = Date.now()
const tmpFile = () => path.join(os.tmpdir(), `mnt-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
const cleanup = (file) => { try { fs.rmSync(file, { force: true }) } catch (e) {} }

/** 造 n 张 active 卡片（默认满足 minCards 门槛）。 */
function seed(store, n = 10, over = {}) {
  const ids = []
  for (let i = 0; i < n; i++) ids.push(store.insert('u1', { category: 'fact', content: `事实条目编号${i}`, ...over }).id)
  return ids
}

test('runUser walks the full pipeline and records a maintenance summary', async () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    seed(store)
    const calls = []
    const maintenance = new MemoryMaintenance({
      store,
      clusterer: { compress: async () => { calls.push('cluster'); return { merged: 2, skipped: 1 } } },
      generalizer: { generalize: async () => { calls.push('generalize'); return { generalized: 1 } } },
      profiler: { generate: async () => { calls.push('profile'); return { ok: true, version: 1 } } },
    })
    const result = await maintenance.runUser('u1', NOW)
    assert.deepEqual(calls, ['cluster', 'generalize', 'profile'])
    assert.equal(result.scored, 10)                    // 第一层评分跑过
    assert.equal(result.merged, 2)
    assert.equal(result.generalized, 1)
    assert.equal(result.profile, 'ok')
    assert.deepEqual(result.errors, [])
    const state = store.getMaintenance('u1')
    assert.equal(state.lastRunAt, NOW)
    assert.match(state.lastResult, /merged=2/)
    assert.match(state.lastResult, /generalized=1/)
  } finally { cleanup(file) }
})

test('runUser isolates step failures and still records the run', async () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    seed(store)
    const errors = []
    const maintenance = new MemoryMaintenance({
      store,
      clusterer: { compress: async () => { throw new Error('cluster down') } },
      generalizer: { generalize: async () => ({ generalized: 0 }) },
      profiler: { generate: async () => ({ ok: false, reason: 'too few cards (3 < 5)' }) },
      onError: (error) => errors.push(error.message),
    })
    const result = await maintenance.runUser('u1', NOW)
    assert.match(result.errors[0], /cluster: cluster down/)
    assert.equal(result.generalized, 0)                // 后续步骤照常执行
    assert.equal(result.profile, 'too few cards (3 < 5)')
    assert.equal(store.getMaintenance('u1').lastRunAt, NOW)
    assert.equal(errors.length, 1)                     // onError 被通知
  } finally { cleanup(file) }
})

test('isDue: active users wait 24h, idle users wait 7 days, small stores are skipped', () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    seed(store, 10)
    const maintenance = new MemoryMaintenance({ store })
    assert.equal(maintenance.isDue('u1', NOW), true)                       // 从未跑过 → 到期
    store.markMaintenanceRun('u1', NOW, 'ok')
    store.touchChange('u1', NOW)                                           // 活跃
    assert.equal(maintenance.isDue('u1', NOW + 12 * 3600 * 1000), false)   // 活跃：24h 内不跑
    assert.equal(maintenance.isDue('u1', NOW + 25 * 3600 * 1000), true)

    // 不活跃（>IDLE_THRESHOLD 无写入）→ 按 7 天兜底
    const stale = NOW + IDLE_THRESHOLD_MS + DAY
    assert.equal(maintenance.isDue('u1', stale + 12 * 3600 * 1000), false)
    assert.equal(maintenance.isDue('u1', stale + 8 * DAY), true)

    // 卡片太少 → 不跑
    const small = tmpFile()
    try {
      const s2 = new MemoryStore({ file: small })
      seed(s2, 3)
      assert.equal(new MemoryMaintenance({ store: s2 }).isDue('u1', NOW), false)
    } finally { cleanup(small) }
  } finally { cleanup(file) }
})

test('sweep visits only due users and never overlaps runs', async () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    seed(store, 10)
    for (let i = 0; i < 10; i++) store.insert('u2', { category: 'fact', content: `另一用户条目${i}` })
    store.markMaintenanceRun('u2', NOW, 'ok')          // u2 刚跑过 → 不到期
    const visited = []
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const maintenance = new MemoryMaintenance({
      store,
      clusterer: {
        compress: async (_store, userId) => {
          visited.push(userId)
          if (userId === 'u1') await gate                 // 卡住第一个用户
          return { merged: 0, skipped: 0 }
        },
      },
    })
    const first = maintenance.sweep()                    // 应只处理 u1（u2 未到期）
    const second = maintenance.sweep()                   // 并发调用 → 直接返回，不重入
    assert.deepEqual(await second, [])
    release()
    const results = await first
    assert.deepEqual(visited, ['u1'])
    assert.equal(results.length, 1)
    assert.equal(results[0].userId, 'u1')
  } finally { cleanup(file) }
})

test('maintenance skips all LLM steps when no helper is configured', async () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    seed(store)
    const maintenance = new MemoryMaintenance({ store })   // 只有评分+归档
    const result = await maintenance.runUser('u1', NOW)
    assert.equal(result.scored, 10)
    assert.equal(result.merged, 0)
    assert.equal(result.generalized, 0)
    assert.equal(result.profile, null)
    assert.deepEqual(result.errors, [])
  } finally { cleanup(file) }
})
