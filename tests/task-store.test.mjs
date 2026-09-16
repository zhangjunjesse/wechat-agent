import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { TaskStore, MAX_REPORT_TOPICS } from '../src/services/task-store.mjs'

function makeStore() {
  const file = path.join(os.tmpdir(), `tsk-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  return { file, store: new TaskStore({ file }) }
}

test('user task CRUD is owner-scoped', () => {
  const { file, store } = makeStore()
  try {
    store.createUserTask({ name: '每日总结', schedule: 'daily@22:00', instruction: '回顾今天', ownerUserId: 'u1' })
    const mine = store.listUserTasks('u1')
    assert.equal(mine.length, 1)
    assert.equal(mine[0].name, '每日总结')
    assert.equal(mine[0].scope, 'user')
    assert.equal(store.listUserTasks('u2').length, 0)
    // duplicate name rejected
    assert.throws(() => store.createUserTask({ name: '每日总结', schedule: 'daily@22:00', instruction: 'x', ownerUserId: 'u1' }), /已存在/)
    // bad schedule rejected
    assert.throws(() => store.createUserTask({ name: '坏任务', schedule: 'nope', instruction: 'x', ownerUserId: 'u1' }), /非法调度/)
    // delete only by owner
    assert.equal(store.deleteUserTask({ ownerUserId: 'u2', name: '每日总结' }), false)
    assert.equal(store.deleteUserTask({ ownerUserId: 'u1', name: '每日总结' }), true)
    assert.equal(store.listUserTasks('u1').length, 0)
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

test('global tasks: subscribe/unsubscribe isolation and config upsert keeps subscribers', () => {
  const { file, store } = makeStore()
  try {
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', instruction: '早报v1' }])
    assert.equal(store.listGlobalTasks().length, 1)
    store.subscribe('每日早报', 'u1')
    store.subscribe('每日早报', 'u2')
    assert.equal(store.isSubscribed('每日早报', 'u1'), true)
    assert.equal(store.isSubscribed('每日早报', 'u2'), true)
    assert.equal(store.isSubscribed('每日早报', 'u3'), false)
    // config reload updates schedule/instruction but preserves subscribers
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@07:30', instruction: '早报v2' }])
    const t = store.listGlobalTasks()[0]
    assert.equal(t.schedule, 'daily@07:30')
    assert.equal(t.instruction, '早报v2')
    assert.deepEqual(t.subscribers, ['u1', 'u2'])
    // unsubscribe only affects the caller
    assert.equal(store.unsubscribe('每日早报', 'u1'), true)
    assert.equal(store.isSubscribed('每日早报', 'u1'), false)
    assert.equal(store.isSubscribed('每日早报', 'u2'), true)
    assert.throws(() => store.subscribe('不存在', 'u1'), /不存在/)
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

test('markRun records last run and error', () => {
  const { file, store } = makeStore()
  try {
    const t = store.createUserTask({ name: 'x', schedule: 'daily@08:00', instruction: 'i', ownerUserId: 'u1' })
    store.markRun(t.id, 1234567, 'boom')
    const after = store.getTask(t.id)
    assert.equal(after.lastRunAt, 1234567)
    assert.equal(after.lastError, 'boom')
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

// ADR-0026：失败重试状态。生产事故——8:00 报告因 402 失败，lastRunAt 照样被推
// 进"今天"，调度器据此算出"下次 = 明天"，没人推动重试。新状态机把
// "尝试"和"结算"分开：markAttemptFailed 不动 lastRunAt（任务仍"到期"，供
// 调度器节流重试），markRun 才是结算（成功，或重试耗尽放弃），并把
// attemptCount 归零迎接下一周期。
test('markAttemptFailed advances attempt state without settling; markRun settles and resets it', () => {
  const { file, store } = makeStore()
  try {
    const t = store.createUserTask({ name: 'x', schedule: 'daily@08:00', instruction: 'i', ownerUserId: 'u1' })
    assert.equal(store.getTask(t.id).attemptCount, 0)
    assert.equal(store.getTask(t.id).lastAttemptAt, 0)

    store.markAttemptFailed(t.id, 1000, '402 Insufficient Balance')
    let after = store.getTask(t.id)
    assert.equal(after.attemptCount, 1)
    assert.equal(after.lastAttemptAt, 1000)
    assert.equal(after.lastError, '402 Insufficient Balance')
    assert.equal(after.lastRunAt, 0) // 未结算：调度锚点不动，任务仍"到期"

    store.markAttemptFailed(t.id, 2000, '402 Insufficient Balance')
    after = store.getTask(t.id)
    assert.equal(after.attemptCount, 2)
    assert.equal(after.lastAttemptAt, 2000)

    // 结算（无论成功还是重试耗尽放弃）：lastRunAt 推进，attemptCount 归零
    store.markRun(t.id, 3000, '')
    after = store.getTask(t.id)
    assert.equal(after.lastRunAt, 3000)
    assert.equal(after.attemptCount, 0)
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

// ADR-0028：报告任务的重试单元状态（跨 tick 持久化）。retry_units 记录本结算
// 周期内还在等重试的生成单元（公共版 userId=''/topic='' 或某个 (用户,主题)）
// 及各自尝试次数；setReportRetryUnits 覆写，markRun（整体结算）必须一并清空
// ——否则昨天的失败单元会泄漏进明天的新周期。
test('setReportRetryUnits persists per-unit retry state and markRun clears it', () => {
  const { file, store } = makeStore()
  try {
    const t = store.createUserTask({ name: 'x', schedule: 'daily@08:00', instruction: 'i', ownerUserId: 'u1' })
    assert.deepEqual(store.getTask(t.id).retryUnits, []) // 迁移默认：空数组

    store.setReportRetryUnits(t.id, [{ userId: 'u1', topic: 'AI', attempts: 1 }, { userId: '', topic: '', attempts: 2 }])
    let after = store.getTask(t.id)
    assert.equal(after.retryUnits.length, 2)
    assert.deepEqual(after.retryUnits[0], { userId: 'u1', topic: 'AI', attempts: 1 })
    assert.deepEqual(after.retryUnits[1], { userId: '', topic: '', attempts: 2 }) // 公共版单元的表示法

    // 覆写为空数组 = 没有单元再等重试
    store.setReportRetryUnits(t.id, [])
    assert.deepEqual(store.getTask(t.id).retryUnits, [])

    // 整体结算时清空（双保险：即使调度器忘了先覆写）
    store.setReportRetryUnits(t.id, [{ userId: 'u1', topic: 'AI', attempts: 3 }])
    store.markRun(t.id, 3000, '')
    assert.deepEqual(store.getTask(t.id).retryUnits, [])
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

test('kind/cover fields persist for report tasks', () => {
  const { file, store } = makeStore()
  try {
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', instruction: 'x', kind: 'report', cover: true }])
    const t = store.getTask('global-每日早报')
    assert.equal(t.kind, 'report')
    assert.equal(t.cover, true)
    // 默认 plain / 无封面
    store.loadGlobalTasks([{ name: '每日总结', schedule: 'daily@22:00', instruction: 'y' }])
    assert.equal(store.getTask('global-每日总结').kind, 'plain')
    assert.equal(store.getTask('global-每日总结').cover, false)
    // 用户任务永远是 plain
    const u = store.createUserTask({ name: 'z', schedule: 'daily@08:00', instruction: 'i', ownerUserId: 'u1' })
    assert.equal(u.kind, 'plain')
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

test('loadGlobalTasks migrates a legacy table without kind/cover columns', () => {
  const file = path.join(os.tmpdir(), `tsk-old-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  // 模拟线上旧 schema（无 kind/cover 列）
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, name TEXT NOT NULL, schedule TEXT NOT NULL,
      instruction TEXT NOT NULL DEFAULT '', owner_user_id TEXT,
      subscribers TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 0, last_run_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '', UNIQUE(scope, name)
    );
  `)
  db.close()
  const store = new TaskStore({ file }) // 构造时自动补列
  try {
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', instruction: 'x', kind: 'report', cover: true }])
    const t = store.getTask('global-每日早报')
    assert.equal(t.kind, 'report')
    assert.equal(t.cover, true)
    assert.equal(t.instruction, 'x')
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

test('report topics are per-user isolated and require subscription', () => {
  const { file, store } = makeStore()
  try {
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', instruction: 'x', kind: 'report' }])
    // 未订阅不能设置主题
    assert.throws(() => store.setReportTopics({ globalName: '每日早报', userId: 'u1', topics: ['AI'] }), /未订阅/)
    assert.throws(() => store.setReportTopics({ globalName: '不存在', userId: 'u1', topics: ['AI'] }), /不存在/)
    store.subscribe('每日早报', 'u1')
    store.subscribe('每日早报', 'u2')
    // u1 设主题，u2 不受影响
    assert.deepEqual(store.setReportTopics({ globalName: '每日早报', userId: 'u1', topics: ['AI', '芯片'] }), ['AI', '芯片'])
    assert.deepEqual(store.getReportTopics('每日早报', 'u1'), ['AI', '芯片'])
    assert.deepEqual(store.getReportTopics('每日早报', 'u2'), []) // 隔离：u2 看不到 u1 的主题
    // 替代式更新 + 空数组清除
    assert.deepEqual(store.setReportTopics({ globalName: '每日早报', userId: 'u1', topics: ['新能源'] }), ['新能源'])
    assert.deepEqual(store.setReportTopics({ globalName: '每日早报', userId: 'u1', topics: [] }), [])
    assert.deepEqual(store.getReportTopics('每日早报', 'u1'), [])
    // 批量读取（调度器分组用）：只返回设了主题的用户
    store.setReportTopics({ globalName: '每日早报', userId: 'u1', topics: ['AI'] })
    store.setReportTopics({ globalName: '每日早报', userId: 'u2', topics: ['机器人'] })
    assert.deepEqual(store.reportTopicsByTask('每日早报'), { u1: ['AI'], u2: ['机器人'] })
    assert.deepEqual(store.listReportTopics('u1'), [{ taskName: '每日早报', topics: ['AI'] }])
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

// ADR-0027：每个主题当天都独立出一份海报+推送，主题数 = 每天推送条数，上限
// 不能太宽——曾经代码上限 10 与工具文案承诺的"1-5 个"不一致，这里订正并锁死。
test('report topics are capped at MAX_REPORT_TOPICS (ADR-0027: each topic = one daily push)', () => {
  const { file, store } = makeStore()
  try {
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', instruction: 'x', kind: 'report' }])
    store.subscribe('每日早报', 'u1')
    const many = ['AI', '芯片', '新能源', '机器人', '元宇宙', '生物科技', '量子计算']
    const cleaned = store.setReportTopics({ globalName: '每日早报', userId: 'u1', topics: many })
    assert.equal(cleaned.length, MAX_REPORT_TOPICS)
    assert.deepEqual(cleaned, many.slice(0, MAX_REPORT_TOPICS))
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

test('guide events record shown/converted and stats aggregate the funnel', () => {
  const { file, store } = makeStore()
  try {
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', instruction: 'x', kind: 'report' }])
    store.subscribe('每日早报', 'u1')
    store.subscribe('每日早报', 'u2')
    // 曝光：订阅回执 + 推送（u1 两次、u2 一次）
    store.recordGuideEvent({ userId: 'u1', event: 'guide_shown', entry: 'subscribe', taskName: '每日早报' })
    store.recordGuideEvent({ userId: 'u1', event: 'guide_shown', entry: 'push', taskName: '每日早报' })
    store.recordGuideEvent({ userId: 'u2', event: 'guide_shown', entry: 'push', taskName: '每日早报' })
    // 转化：u1 设主题（对话入口）
    store.setReportTopics({ globalName: '每日早报', userId: 'u1', topics: ['AI'] })
    store.recordGuideEvent({ userId: 'u1', event: 'guide_converted', entry: 'chat', taskName: '每日早报' })
    const s = store.guideStats()
    assert.equal(s.subscribed, 2)
    assert.equal(s.shown, 2) // 2 个用户收到过引导
    assert.equal(s.converted, 1)
    assert.deepEqual(s.byEntry, { subscribe: 1, push: 2 })
    assert.ok(s.convertHours != null && s.convertHours >= 0)
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

// ---- ADR-0031：公共任务改名迁移 ----
// upsert 键是 `global-<name>`，所以改名 = 新建一条空任务 + 把老任务连同全部
// 订阅者晾在库里继续被调度。`renamedFrom` 让"这条就是原来那条"能在声明式配置
// 里被表达出来。

test('renamedFrom migrates subscribers and scheduling anchors, and drops the old row', () => {
  const { file, store } = makeStore()
  try {
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', kind: 'report', cover: true, instruction: '早报v1', createdAt: 1000 }])
    store.subscribe('每日早报', 'u1')
    store.subscribe('每日早报', 'u2')
    store.setReportTopics({ globalName: '每日早报', userId: 'u1', topics: ['AI', '芯片'] })
    store.recordGuideEvent({ userId: 'u1', event: 'guide_shown', entry: 'push', taskName: '每日早报' })
    store.markRun('global-每日早报', 5000, '')

    store.loadGlobalTasks([{ name: '每日资讯', renamedFrom: '每日早报', schedule: 'daily@08:00', kind: 'report', cover: true, instruction: '资讯v2', createdAt: 9999 }])

    // 旧任务彻底消失（否则它会带着订阅者继续每天推送）
    assert.equal(store.getTask('global-每日早报'), null)
    assert.equal(store.listGlobalTasks().length, 1)

    const t = store.getTask('global-每日资讯')
    assert.equal(t.name, '每日资讯')
    assert.deepEqual(t.subscribers, ['u1', 'u2']) // 订阅关系完整保留
    assert.equal(t.createdAt, 1000)               // 不假装自己是今天才存在的
    assert.equal(t.lastRunAt, 5000)               // 调度锚点保留，改名当天不重复触发
    assert.equal(t.instruction, '资讯v2')          // 配置侧字段以配置为准
    assert.equal(t.kind, 'report')
    assert.equal(t.cover, true)

    // 附属表按 task_name 关联，跟着改名
    assert.deepEqual(store.getReportTopics('每日资讯', 'u1'), ['AI', '芯片'])
    assert.deepEqual(store.getReportTopics('每日早报', 'u1'), [])
    assert.deepEqual(store.listReportTopics('u1'), [{ taskName: '每日资讯', topics: ['AI', '芯片'] }])
    assert.equal(store.guideStats().shown, 1)
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

test('the rename migration is idempotent across repeated startups', () => {
  const { file, store } = makeStore()
  try {
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', instruction: 'v1', createdAt: 1000 }])
    store.subscribe('每日早报', 'u1')
    const config = [{ name: '每日资讯', renamedFrom: '每日早报', schedule: 'daily@08:00', instruction: 'v2', createdAt: 9999 }]

    store.loadGlobalTasks(config)
    store.subscribe('每日资讯', 'u9') // 改名后新来的订阅者
    // 每次启动都会跑一遍：第二、三次必须是 no-op，不能吃掉新订阅者
    store.loadGlobalTasks(config)
    store.loadGlobalTasks(config)

    const t = store.getTask('global-每日资讯')
    assert.deepEqual(t.subscribers, ['u1', 'u9'])
    assert.equal(t.createdAt, 1000)
    assert.equal(store.listGlobalTasks().length, 1)
    assert.equal(store.renameGlobalTask('每日早报', '每日资讯'), false) // 旧行早就没了
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

test('renaming onto an existing task merges the two subscriber sets instead of losing one', () => {
  const { file, store } = makeStore()
  try {
    store.loadGlobalTasks([
      { name: '每日早报', schedule: 'daily@08:00', instruction: 'old', createdAt: 1000 },
      { name: '每日资讯', schedule: 'daily@08:00', instruction: 'new', createdAt: 8000 },
    ])
    store.subscribe('每日早报', 'u1')
    store.subscribe('每日早报', 'shared')
    store.subscribe('每日资讯', 'u2')
    store.subscribe('每日资讯', 'shared')
    store.setReportTopics({ globalName: '每日早报', userId: 'u1', topics: ['旧主题'] })
    store.setReportTopics({ globalName: '每日早报', userId: 'shared', topics: ['旧的'] })
    store.setReportTopics({ globalName: '每日资讯', userId: 'shared', topics: ['新的'] })
    store.markRun('global-每日早报', 5000, '')
    store.markRun('global-每日资讯', 7000, '')

    assert.equal(store.renameGlobalTask('每日早报', '每日资讯'), true)

    const t = store.getTask('global-每日资讯')
    assert.equal(store.getTask('global-每日早报'), null)
    assert.deepEqual(t.subscribers.sort(), ['shared', 'u1', 'u2']) // 并集去重
    assert.equal(t.createdAt, 1000) // 更早的那个
    assert.equal(t.lastRunAt, 7000) // 更晚的那个
    // 撞主键时新名下已有的设置胜出；旧行不留孤儿
    assert.deepEqual(store.getReportTopics('每日资讯', 'shared'), ['新的'])
    assert.deepEqual(store.getReportTopics('每日资讯', 'u1'), ['旧主题'])
    assert.deepEqual(store.listReportTopics('u1'), [{ taskName: '每日资讯', topics: ['旧主题'] }])
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

test('renameGlobalTask is a no-op for unknown, empty or identical names', () => {
  const { file, store } = makeStore()
  try {
    store.loadGlobalTasks([{ name: '每日资讯', schedule: 'daily@08:00', instruction: 'v', createdAt: 1000 }])
    store.subscribe('每日资讯', 'u1')
    assert.equal(store.renameGlobalTask('从未存在过', '每日资讯'), false)
    assert.equal(store.renameGlobalTask('', '每日资讯'), false)
    assert.equal(store.renameGlobalTask('每日资讯', ''), false)
    assert.equal(store.renameGlobalTask('每日资讯', '每日资讯'), false)
    assert.deepEqual(store.getTask('global-每日资讯').subscribers, ['u1'])
    // 配置里 renamedFrom 指向一个从未部署过的旧名 → 正常建新任务
    store.loadGlobalTasks([{ name: '全新任务', renamedFrom: '不存在的老任务', schedule: 'daily@09:00', instruction: 'x' }])
    assert.equal(store.getTask('global-全新任务').name, '全新任务')
    assert.deepEqual(store.getTask('global-全新任务').subscribers, [])
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

test('global task kinds come from a whitelist so a new kind is not silently downgraded', () => {
  const { file, store } = makeStore()
  try {
    store.loadGlobalTasks([
      { name: '资讯', schedule: 'daily@08:00', kind: 'report', instruction: 'a' },
      { name: '微信日报', schedule: 'daily@21:30', kind: 'wechat-digest', instruction: 'b' },
      { name: '普通', schedule: 'daily@10:00', instruction: 'c' },
      { name: '拼错了', schedule: 'daily@11:00', kind: 'reportt', instruction: 'd' },
    ])
    const byName = Object.fromEntries(store.listGlobalTasks().map((t) => [t.name, t.kind]))
    assert.equal(byName['资讯'], 'report')
    assert.equal(byName['微信日报'], 'wechat-digest') // 不被降级成 plain
    assert.equal(byName['普通'], 'plain')
    assert.equal(byName['拼错了'], 'plain')           // 未知 kind 降级，不炸
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})
