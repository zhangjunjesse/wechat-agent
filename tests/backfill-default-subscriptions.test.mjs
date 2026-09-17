import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { TaskStore } from '../src/services/task-store.mjs'
import { DEFAULT_SUBSCRIPTIONS } from '../src/app.mjs'
import { DEFAULT_BACKFILL_TASKS, classifyProfile, planBackfill, applyBackfill } from '../scripts/backfill-default-subscriptions.mjs'

// ADR-0031（2026-09-17 变更）："所有人默认订阅微信日报和微信周报"，存量用户靠
// 这个脚本一次性回填，绝不能挂到启动流程——挂上去就等于退订功能永久失效。
// 这份测试的核心不是"能不能订阅成功"（那是 TaskStore.subscribe 自己的职责），
// 而是钉死三条更容易做错的语义：默认不碰「每日资讯」、按 ilinkUserId 去重、
// 以及全篇最关键的一条——已经被回填过又主动退订的人，重跑脚本绝不会把他们
// 订阅回去。

function setup(t) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const file = path.join(os.tmpdir(), `bfd-${stamp}.db`)
  const taskStore = new TaskStore({ file })
  t.after(() => { taskStore.close(); fs.rmSync(file, { force: true }) })
  taskStore.loadGlobalTasks([
    { name: '每日资讯', schedule: 'daily@08:00', kind: 'report', instruction: 'x' },
    { name: '微信日报', schedule: 'daily@21:30', kind: 'wechat-digest', instruction: 'x' },
    { name: '微信周报', schedule: 'weekly@7@20:00', kind: 'wechat-digest', instruction: 'x' },
  ])
  return taskStore
}

const verified = (over = {}) => ({ userId: 'u1', nickname: '张三', verifiedAt: '2026-09-16T00:00:00.000Z', ilinkUserId: 'ilink-zhang@im.wechat', ...over })

test('DEFAULT_BACKFILL_TASKS excludes 每日资讯 (its backfill is owned by the ADR-0031 rename migration, not this script)', () => {
  assert.deepEqual(DEFAULT_BACKFILL_TASKS, ['微信日报', '微信周报'])
  assert.ok(DEFAULT_SUBSCRIPTIONS.includes('每日资讯')) // 确认它确实被过滤掉了，不是本来就没有
})

test('classifyProfile: verified profile with ilinkUserId is eligible', () => {
  const r = classifyProfile(verified())
  assert.equal(r.eligible, true)
  assert.equal(r.key, 'ilink-zhang@im.wechat')
})

test('classifyProfile: unverified profile (no verifiedAt) is excluded', () => {
  const r = classifyProfile({ userId: 'u2', nickname: 'x', ilinkUserId: 'ilink-x' })
  assert.equal(r.eligible, false)
  assert.match(r.reason, /未核验/)
})

test('classifyProfile: synthetic/test profiles without ilinkUserId are excluded (test-user, repro, repro2)', () => {
  for (const userId of ['test-user', 'repro', 'repro2']) {
    const r = classifyProfile({ userId, nickname: userId, verifiedAt: '2026-09-01T00:00:00.000Z', ilinkUserId: '' })
    assert.equal(r.eligible, false, userId)
    assert.match(r.reason, /ilinkUserId/)
  }
})

test('planBackfill: default run plans 微信日报/微信周报 for a fresh verified user, never 每日资讯', (t) => {
  const taskStore = setup(t)
  const entries = planBackfill([verified()], taskStore)
  assert.equal(entries.length, 1)
  const [entry] = entries
  assert.equal(entry.excluded, undefined)
  assert.deepEqual(entry.tasks.map((x) => x.name), ['微信日报', '微信周报'])
  assert.ok(entry.tasks.every((x) => x.action === 'subscribe'))
})

test('planBackfill + applyBackfill: apply actually writes subscribers; dry-run (plan only, no apply) writes nothing', (t) => {
  const taskStore = setup(t)
  const entries = planBackfill([verified()], taskStore)
  // 只是 plan，不 apply —— tasks.db 必须原封不动
  assert.equal(taskStore.isSubscribed('微信日报', 'ilink-zhang@im.wechat'), false)
  assert.equal(taskStore.isSubscribed('微信周报', 'ilink-zhang@im.wechat'), false)

  const log = new Set()
  const subscribed = applyBackfill(entries, taskStore, log)
  assert.equal(subscribed, 2)
  assert.equal(taskStore.isSubscribed('微信日报', 'ilink-zhang@im.wechat'), true)
  assert.equal(taskStore.isSubscribed('微信周报', 'ilink-zhang@im.wechat'), true)
  assert.equal(taskStore.isSubscribed('每日资讯', 'ilink-zhang@im.wechat'), false) // 从没碰过它
  // 账本键用 NUL 分隔（`${ilinkUserId}\u0000${taskName}`）而不是空格：wxid 与
  // 任务名都不可能含 NUL，空格则可能出现在任务名里、会造成键歧义。
  assert.ok(log.has('ilink-zhang@im.wechat\u0000微信日报'))
  assert.ok(log.has('ilink-zhang@im.wechat\u0000微信周报'))
})

test('idempotent: already-subscribed users are skipped, re-running has no side effect', (t) => {
  const taskStore = setup(t)
  taskStore.subscribe('微信日报', 'ilink-zhang@im.wechat') // 用户自己此前已经手动订阅过

  const entries = planBackfill([verified()], taskStore)
  const [entry] = entries
  assert.deepEqual(entry.tasks, [
    { name: '微信日报', action: 'skip', reason: '已订阅' },
    { name: '微信周报', action: 'subscribe' },
  ])
  const log = new Set()
  const subscribed = applyBackfill(entries, taskStore, log)
  assert.equal(subscribed, 1) // 只有微信周报是新订阅
  assert.equal(taskStore.isSubscribed('微信日报', 'ilink-zhang@im.wechat'), true)
  assert.equal(taskStore.isSubscribed('微信周报', 'ilink-zhang@im.wechat'), true)

  // 重跑：两个都已订阅（微信日报是原来的，微信周报是刚 apply 出来的），全 skip
  const entries2 = planBackfill([verified()], taskStore, log)
  assert.ok(entries2[0].tasks.every((t) => t.action === 'skip'))
  const subscribed2 = applyBackfill(entries2, taskStore, log)
  assert.equal(subscribed2, 0)
})

test('same ilinkUserId shared by multiple profiles dedupes to exactly one subscriber (production: 4 profiles share one 微信 identity)', (t) => {
  const taskStore = setup(t)
  const profiles = [
    verified({ userId: 'u_browser_1' }),
    verified({ userId: 'u_browser_2' }),
    verified({ userId: 'u_browser_3', nickname: 'Z.俊' }),
    verified({ userId: 'u_browser_4', nickname: 'Z.俊' }),
  ]
  const entries = planBackfill(profiles, taskStore)
  const active = entries.filter((e) => !e.excluded)
  const excluded = entries.filter((e) => e.excluded)
  assert.equal(active.length, 1)
  assert.equal(active[0].userId, 'u_browser_1') // 第一个认领这个键的
  assert.equal(excluded.length, 3)
  for (const e of excluded) assert.match(e.excluded, /共用同一 ilinkUserId/)

  const log = new Set()
  applyBackfill(entries, taskStore, log)
  assert.deepEqual(taskStore.getTask('global-微信日报').subscribers, ['ilink-zhang@im.wechat']) // 不是 4 个马甲键
})

test('CRITICAL: a user already backfilled who then unsubscribed is NOT re-subscribed on a re-run', (t) => {
  const taskStore = setup(t)
  const log = new Set()

  // 第一次跑：回填成功
  const first = planBackfill([verified()], taskStore, log)
  applyBackfill(first, taskStore, log)
  assert.equal(taskStore.isSubscribed('微信日报', 'ilink-zhang@im.wechat'), true)

  // 用户自己主动退订（比如收到几天日报后觉得吵）
  taskStore.unsubscribe('微信日报', 'ilink-zhang@im.wechat')
  assert.equal(taskStore.isSubscribed('微信日报', 'ilink-zhang@im.wechat'), false)

  // 管理员出于别的原因（比如给新核验的一批人回填）重跑本脚本，profiles.json 里
  // 这个人还在——如果脚本只看 subscribers，会把他"不在订阅列表里"误判成"该
  // 回填"，把他悄悄订阅回去，退订就白退了。账本必须挡住这一步。
  const second = planBackfill([verified()], taskStore, log)
  const task = second[0].tasks.find((x) => x.name === '微信日报')
  assert.equal(task.action, 'skip')
  assert.match(task.reason, /此前已被本脚本回填处理过/)

  const subscribed = applyBackfill(second, taskStore, log)
  assert.equal(subscribed, 0)
  assert.equal(taskStore.isSubscribed('微信日报', 'ilink-zhang@im.wechat'), false) // 退订状态原样保留
})

test('--tasks override: a caller can restrict (or even re-include 每日资讯) explicitly', (t) => {
  const taskStore = setup(t)
  const entries = planBackfill([verified()], taskStore, new Set(), { taskNames: ['每日资讯'] })
  assert.deepEqual(entries[0].tasks, [{ name: '每日资讯', action: 'subscribe' }])
})

test('mixed batch: unverified and no-ilinkUserId profiles are excluded with an honest reason, verified ones proceed', (t) => {
  const taskStore = setup(t)
  const profiles = [
    verified(),
    { userId: 'test-user', nickname: 'test-user', verifiedAt: '2026-01-01T00:00:00.000Z', ilinkUserId: '' },
    { userId: 'repro', nickname: 'repro', verifiedAt: '2026-01-01T00:00:00.000Z', ilinkUserId: '' },
    { userId: 'never-verified', nickname: '未核验' },
  ]
  const entries = planBackfill(profiles, taskStore)
  assert.equal(entries.find((e) => e.userId === 'ilink-zhang@im.wechat' || e.userId === 'u1').tasks.length, 2)
  assert.match(entries.find((e) => e.userId === 'test-user').excluded, /ilinkUserId/)
  assert.match(entries.find((e) => e.userId === 'repro').excluded, /ilinkUserId/)
  assert.match(entries.find((e) => e.userId === 'never-verified').excluded, /未核验/)
})
