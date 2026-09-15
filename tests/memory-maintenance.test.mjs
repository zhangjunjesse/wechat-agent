import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { MemoryStore } from '../src/services/memory-store.mjs'
import { MemoryMaintenance, IDLE_THRESHOLD_MS } from '../src/services/memory-maintenance.mjs'
import { MemoryClusterer } from '../src/llm/memory-cluster.mjs'

const DAY = 86400000
const NOW = Date.now()
const tmpFile = () => path.join(os.tmpdir(), `mnt-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
const cleanup = (file) => { try { fs.rmSync(file, { force: true }) } catch (e) {} }

/** 造 n 张 active 卡片（默认满足 minCards 门槛）；prefix 用于避免内容去重。 */
function seed(store, n = 10, prefix = '事实条目编号', over = {}) {
  const ids = []
  for (let i = 0; i < n; i++) ids.push(store.insert('u1', { category: 'fact', content: `${prefix}${i}`, ...over }).id)
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
    // 顺序：泛化先于聚类——两层吃同一批原料（相似事件），聚类会吃掉泛化的样本
    assert.deepEqual(calls, ['generalize', 'cluster', 'profile'])
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

test('profile drift triggers an early rebuild (with cooldown) — A1', () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    seed(store, 10)
    store.upsertProfile('u1', '【工作背景】旧档案', 10, NOW)      // 档案来源 = 10 条
    store.markMaintenanceRun('u1', NOW, 'ok')                     // 刚跑过 → 时间维度未到期
    const maintenance = new MemoryMaintenance({ store, profileDriftThreshold: 3, profileDriftCooldownMs: 3600 * 1000 })

    assert.equal(maintenance.profileDrift('u1'), 0)
    assert.equal(maintenance.isDue('u1', NOW + 2 * 3600 * 1000), false)   // 无漂移 → 仍按 24h
    assert.equal(maintenance.profileDrift('nobody'), 0)                   // 无档案不算漂移

    seed(store, 3, '新增条目')                                     // 卡片变化 3 条 ≥ 阈值
    assert.equal(maintenance.profileDrift('u1'), 3)
    assert.equal(maintenance.isDue('u1', NOW + 60 * 1000), false)         // 冷却内不重复触发
    assert.equal(maintenance.isDue('u1', NOW + 2 * 3600 * 1000), true)    // 冷却过后提前重建

    // 重建档案后漂移归零，回到时间维度
    store.upsertProfile('u1', '【工作背景】新档案', store.listActive('u1').length, NOW + 2 * 3600 * 1000)
    store.markMaintenanceRun('u1', NOW + 2 * 3600 * 1000, 'ok')
    assert.equal(maintenance.profileDrift('u1'), 0)
    assert.equal(maintenance.isDue('u1', NOW + 3 * 3600 * 1000), false)
  } finally { cleanup(file) }
})

test('cards written while maintenance runs are not touched by that run (snapshot semantics) — A2', async () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    const a = store.insert('u1', { category: 'fact', content: '8月28日跟进行员信息同步模板获取' })
    const b = store.insert('u1', { category: 'fact', content: '8月28日跟进行员信息同步模板文件获取' })
    seed(store, 8, '填充条目')
    const NEW_CARD = '维护期间新写入的卡片'
    // 真实 MemoryClusterer 路径：在 LLM await 间隙插入新卡（模拟 absorb 并发写入）
    const clusterer = new MemoryClusterer({
      complete: async () => {
        store.insert('u1', { category: 'fact', content: NEW_CARD })
        return JSON.stringify([{ groupId: 'g1', cardIds: [a.id, b.id], content: '8月28日跟进行员信息同步模板与模板文件获取' }])
      },
    })
    const maintenance = new MemoryMaintenance({ store, clusterer })
    const before = store.listActive('u1').length
    const result = await maintenance.runUser('u1', NOW)

    assert.equal(result.merged, 1)
    assert.equal(result.snapshotSize, before)                       // 快照 = 维护开始时的 active 数
    const fresh = store.listActive('u1').find((c) => c.content === NEW_CARD)
    assert.ok(fresh, '维护期间写入的卡片必须保持 active（留给下一轮）')
    assert.equal(store.listArchived('u1').some((x) => String(x.card?.content) === NEW_CARD), false)
    assert.equal(store.listActive('u1').length, before - 2 + 1 + 1)  // 合并掉 2 条 + 1 张合并卡 + 1 张新卡
    assert.equal(store.get('u1', a.id).status, 'merged')
  } finally { cleanup(file) }
})

test('maintenance log records what happened, not just counts — A3', async () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    const a = store.insert('u1', { category: 'fact', content: '8月28日跟进行员信息同步模板获取' })
    const b = store.insert('u1', { category: 'fact', content: '8月28日跟进行员信息同步模板文件获取' })
    seed(store, 8, '填充条目')
    const clusterer = new MemoryClusterer({
      complete: async () => JSON.stringify([{ groupId: 'g1', cardIds: [a.id, b.id], content: '8月28日跟进行员信息同步模板与模板文件获取' }]),
    })
    const maintenance = new MemoryMaintenance({ store, clusterer })
    const result = await maintenance.runUser('u1', NOW)

    const log = JSON.parse(store.getMaintenance('u1').lastResult)
    assert.match(log.summary, /merged=1/)                            // 旧断言（人读摘要）依然成立
    assert.equal(log.merged.length, 1)                               // 明细：合并了什么
    assert.match(log.merged[0].content, /行员信息同步/)
    assert.equal(log.snapshotSize, result.snapshotSize)
    assert.deepEqual(log.errors, [])
    assert.ok(Array.isArray(log.skipped))
    assert.equal(result.details.merged.length, 1)
  } finally { cleanup(file) }
})

test('maintenance log captures skipped reasons and errors for traceability — A3', async () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    seed(store, 10)
    const maintenance = new MemoryMaintenance({
      store,
      clusterer: { compress: async () => { throw new Error('cluster down') } },
    })
    await maintenance.runUser('u1', NOW)
    const log = JSON.parse(store.getMaintenance('u1').lastResult)
    assert.match(log.errors.join(' '), /cluster: cluster down/)
    assert.match(log.summary, /scored=10/)
  } finally { cleanup(file) }
})
