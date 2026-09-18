import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { TaskStore } from '../src/services/task-store.mjs'
import { TaskScheduler } from '../src/services/task-scheduler.mjs'
import { ReportStore } from '../src/services/report-store.mjs'
import { ContextTokenCache } from '../src/services/context-token-cache.mjs'

// 北京时间 2026-09-16（周三）21:30:30 —— daily@21:30 刚过触发点
const NOW = Date.UTC(2026, 8, 16, 13, 30, 30)
const CREATED = NOW - 60_000

function setup({ digestRunner, digestQuietPush = true, retryMax = 3 } = {}) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const taskFile = path.join(os.tmpdir(), `dsch-t-${stamp}.db`)
  const repFile = path.join(os.tmpdir(), `dsch-r-${stamp}.db`)
  const store = new TaskStore({ file: taskFile })
  const reportStore = new ReportStore({ file: repFile })
  const sentText = []
  const sentImage = []
  const provider = {
    sendText: async (a) => { sentText.push(a); return { providerMessageId: 'm1' } },
    sendImage: async (a) => { sentImage.push(a); return { providerMessageId: 'i1' } },
  }
  const profiles = new Map()
  const profileStore = { get: async (id) => profiles.get(id) || null }
  const tokens = new ContextTokenCache({ file: taskFile + '.ctx.json', flushDelayMs: 60_000 })
  // 调度器专属 agent 在 digest 路径上不该被直接调用（生成全在 runner 里）
  const agentCalls = []
  const agent = { respond: async (a) => { agentCalls.push(a); return { text: 'plain 路径的输出' } } }
  const scheduler = new TaskScheduler({
    taskStore: store, agent, provider, profileStore, contextTokens: tokens, reportStore,
    reportUrl: (id) => `https://x.test/reports/${id}`,
    now: () => NOW, digestRunner, digestQuietPush, retryMax,
  })
  const cleanup = () => {
    store?.close?.(); reportStore.close()
    for (const f of [taskFile, repFile, taskFile + '.ctx.json']) fs.rmSync(f, { force: true })
  }
  return { store, reportStore, scheduler, sentText, sentImage, profiles, tokens, agentCalls, cleanup }
}

function verify(ctx, userId) {
  ctx.profiles.set(userId, { userId, nickname: userId, wxid: `wx-${userId}`, ilinkUserId: userId })
  ctx.tokens.update(userId, { contextToken: `tok-${userId}`, providerBotId: 'bot-1' })
}

const DIGEST_TASKS = [{ name: '微信日报', schedule: 'daily@21:30', kind: 'wechat-digest', instruction: '只捞和我有关的', createdAt: CREATED }]

function fakeReport(reportStore, { userId, posterPath = '' }) {
  return reportStore.saveReport({
    taskId: 'global-微信日报', name: '微信日报', runAt: NOW, userId, kind: 'wechat-digest', posterPath,
    focus: '今天主要是项目群',
    items: [
      { title: '给李四回复接口方案', summary: '他等你的答复', source: '来自 项目群 · 09-16 18:30', section: 'action_items' },
      { title: '周六带爸复查', summary: '上午', source: '来自 家人群 · 09-16 16:30', section: 'work_updates' },
    ],
  })
}

test('wechat-digest tasks are routed to the digest runner, per subscriber', async (t) => {
  const posterFile = path.join(os.tmpdir(), `dsch-poster-${Date.now()}.png`)
  fs.writeFileSync(posterFile, Buffer.from([137, 80, 78, 71]))
  t.after(() => fs.rmSync(posterFile, { force: true }))

  const generated = []
  let ctx
  const digestRunner = {
    generate: async ({ task, userId, profile, now }) => {
      generated.push({ taskName: task.name, userId, wxid: profile.wxid, now })
      return { ok: true, empty: false, report: fakeReport(ctx.reportStore, { userId, posterPath: posterFile }) }
    },
  }
  ctx = setup({ digestRunner })
  t.after(ctx.cleanup)
  ctx.store.loadGlobalTasks(DIGEST_TASKS)
  ctx.store.subscribe('微信日报', 'u1')
  ctx.store.subscribe('微信日报', 'u2')
  verify(ctx, 'u1'); verify(ctx, 'u2')

  await ctx.scheduler.sweep()

  // per-user 生成（不是"一次生成全员扇出"）
  assert.deepEqual(generated.map((g) => g.userId).sort(), ['u1', 'u2'])
  assert.ok(generated.every((g) => g.taskName === '微信日报' && g.now === NOW))
  assert.equal(generated[0].wxid, 'wx-u1') // profile 透传给 runner（取数身份）
  // 调度器自己的 agent 不参与 digest 生成
  assert.equal(ctx.agentCalls.length, 0)

  // 图 + 短描述各一条
  assert.deepEqual(ctx.sentImage.map((s) => s.toProviderUserId).sort(), ['u1', 'u2'])
  assert.deepEqual(ctx.sentText.map((s) => s.toProviderUserId).sort(), ['u1', 'u2'])
  assert.match(ctx.sentText[0].text, /微信日报 已送达/)
  assert.match(ctx.sentText[0].text, /需要你行动 1 条/)
  assert.match(ctx.sentText[0].text, /https:\/\/x\.test\/reports\//)
  assert.match(ctx.sentText[0].text, /哪条没用？直接回我/)
  assert.equal(ctx.sentText[0].contextToken, 'tok-u1')

  const task = ctx.store.getTask('global-微信日报')
  assert.ok(task.lastRunAt > 0)       // 成功即结算
  assert.deepEqual(task.retryUnits, [])
  // 同一轮不重复执行
  await ctx.scheduler.sweep()
  assert.equal(generated.length, 2)
})

test('digest pushes do not pollute the ADR-0020 topic-guidance funnel', async (t) => {
  let ctx
  const digestRunner = { generate: async ({ userId }) => ({ ok: true, empty: false, report: fakeReport(ctx.reportStore, { userId }) }) }
  ctx = setup({ digestRunner })
  t.after(ctx.cleanup)
  ctx.store.loadGlobalTasks(DIGEST_TASKS)
  ctx.store.subscribe('微信日报', 'u1')
  verify(ctx, 'u1')
  await ctx.scheduler.sweep()
  assert.equal(ctx.sentText.length, 1)
  // digest 的推送文案里没有主题定制引导，记 guide_shown 只会灌水转化率的分母
  assert.equal(ctx.store.guideStats().shown, 0)
})

test('a quiet period sends one short line and no poster, and never enters retry', async (t) => {
  const ctx = setup({ digestRunner: { generate: async () => ({ ok: true, empty: true, report: null }) } })
  t.after(ctx.cleanup)
  ctx.store.loadGlobalTasks(DIGEST_TASKS)
  ctx.store.subscribe('微信日报', 'u1')
  verify(ctx, 'u1')

  await ctx.scheduler.sweep()
  assert.equal(ctx.sentImage.length, 0)
  assert.equal(ctx.sentText.length, 1)
  assert.match(ctx.sentText[0].text, /今天各群平静/)
  const task = ctx.store.getTask('global-微信日报')
  assert.deepEqual(task.retryUnits, []) // "没内容" 不是失败，不占重试预算
  assert.ok(task.lastRunAt > 0)
  assert.equal(task.attemptCount, 0)
})

test('digestQuietPush:false stays completely silent on a quiet period', async (t) => {
  const ctx = setup({ digestQuietPush: false, digestRunner: { generate: async () => ({ ok: true, empty: true, report: null }) } })
  t.after(ctx.cleanup)
  ctx.store.loadGlobalTasks(DIGEST_TASKS)
  ctx.store.subscribe('微信日报', 'u1')
  verify(ctx, 'u1')
  await ctx.scheduler.sweep()
  assert.equal(ctx.sentText.length, 0)
  assert.equal(ctx.sentImage.length, 0)
  assert.ok(ctx.store.getTask('global-微信日报').lastRunAt > 0)
})

test('weekly digests fetch a 7-day window; the scheduler passes the task through untouched', async (t) => {
  const seen = []
  const ctx = setup({ digestRunner: { generate: async ({ task }) => { seen.push(task.schedule); return { ok: true, empty: true, report: null } } } })
  t.after(ctx.cleanup)
  // 周日 20:00（weekly@7）——NOW 是周三，取"上一个周日"的锚点让它到期
  ctx.store.loadGlobalTasks([{ name: '微信周报', schedule: 'weekly@7@20:00', kind: 'wechat-digest', instruction: 'x', createdAt: NOW - 10 * 86_400_000 }])
  ctx.store.subscribe('微信周报', 'u1')
  verify(ctx, 'u1')
  await ctx.scheduler.sweep()
  assert.deepEqual(seen, ['weekly@7@20:00']) // 窗口由 runner 从 schedule 推导，不靠配置字段
  assert.match(ctx.sentText[0].text, /这一周各群都挺平静/)
})

test('one subscriber failing does not affect another, and only the failed unit is retried', async (t) => {
  let ctx
  const attempts = []
  const digestRunner = {
    generate: async ({ userId }) => {
      attempts.push(userId)
      if (userId === 'u2') return { ok: false, error: 'digest_unparsable' }
      return { ok: true, empty: false, report: fakeReport(ctx.reportStore, { userId }) }
    },
  }
  ctx = setup({ digestRunner })
  t.after(ctx.cleanup)
  ctx.store.loadGlobalTasks(DIGEST_TASKS)
  ctx.store.subscribe('微信日报', 'u1')
  ctx.store.subscribe('微信日报', 'u2')
  verify(ctx, 'u1'); verify(ctx, 'u2')

  await ctx.scheduler.sweep()
  assert.deepEqual(attempts.sort(), ['u1', 'u2'])
  // u1 收到真简报；u2 首次失败按 ADR-0035 静默——不发任何消息，只落 last_error
  assert.equal(ctx.sentText.length, 1)
  assert.match(ctx.sentText.find((s) => s.toProviderUserId === 'u1').text, /微信日报 已送达/)
  assert.equal(ctx.sentText.find((s) => s.toProviderUserId === 'u2'), undefined)

  const task = ctx.store.getTask('global-微信日报')
  assert.deepEqual(task.retryUnits, [{ userId: 'u2', topic: '', attempts: 1 }]) // 只挂 u2
  assert.equal(task.lastRunAt, 0) // 还有单元挂着 → 不结算
  assert.equal(task.attemptCount, 1)
})

test('the retry round re-runs only the pending unit, never re-pushing to who already got it', async (t) => {
  let ctx
  let failU2 = true
  const attempts = []
  const digestRunner = {
    generate: async ({ userId }) => {
      attempts.push(userId)
      if (userId === 'u2' && failU2) return { ok: false, error: 'digest_unparsable' }
      return { ok: true, empty: false, report: fakeReport(ctx.reportStore, { userId }) }
    },
  }
  // retryIntervalMs 默认 20 分钟，但 now 固定 —— 直接把间隔设为 0 让重试轮立刻到期
  ctx = setup({ digestRunner })
  t.after(ctx.cleanup)
  ctx.store.loadGlobalTasks(DIGEST_TASKS)
  ctx.store.subscribe('微信日报', 'u1')
  ctx.store.subscribe('微信日报', 'u2')
  verify(ctx, 'u1'); verify(ctx, 'u2')

  await ctx.scheduler.sweep() // 首轮：u1 成功、u2 失败
  assert.deepEqual(ctx.store.getTask('global-微信日报').retryUnits, [{ userId: 'u2', topic: '', attempts: 1 }])

  // 重试轮（手动驱动 #runDigestTask 的入口：再 sweep 一次并绕过节流）
  failU2 = false
  attempts.length = 0
  const retried = new TaskScheduler({
    taskStore: ctx.store, agent: { respond: async () => ({ text: '' }) }, provider: {
      sendText: async (a) => { ctx.sentText.push(a); return { providerMessageId: 'm' } },
      sendImage: async (a) => { ctx.sentImage.push(a); return { providerMessageId: 'i' } },
    },
    profileStore: { get: async (id) => ctx.profiles.get(id) || null },
    contextTokens: ctx.tokens, reportStore: ctx.reportStore, reportUrl: (id) => `https://x.test/reports/${id}`,
    now: () => NOW, digestRunner, retryIntervalMs: 0,
  })
  await retried.sweep()
  assert.deepEqual(attempts, ['u2']) // 已成功的 u1 绝不被重复生成/推送
  const task = ctx.store.getTask('global-微信日报')
  assert.deepEqual(task.retryUnits, [])
  assert.ok(task.lastRunAt > 0) // 所有单元结束 → 整体结算
})

test('unverified subscribers are skipped before any generation work is done', async (t) => {
  const attempts = []
  const ctx = setup({ digestRunner: { generate: async ({ userId }) => { attempts.push(userId); return { ok: true, empty: true, report: null } } } })
  t.after(ctx.cleanup)
  ctx.store.loadGlobalTasks(DIGEST_TASKS)
  ctx.store.subscribe('微信日报', 'u1')
  ctx.store.subscribe('微信日报', 'u-unverified')
  verify(ctx, 'u1') // u-unverified 没有 profile

  await ctx.scheduler.sweep()
  // digest 的取数边界完全由 profile 的 wxid/nickname 决定，未核验的用户连管道都不该进
  assert.deepEqual(attempts, ['u1'])
})

test('without a digestRunner the task is skipped, not degraded into an empty plain push', async (t) => {
  const ctx = setup({ digestRunner: null })
  t.after(ctx.cleanup)
  ctx.store.loadGlobalTasks(DIGEST_TASKS)
  ctx.store.subscribe('微信日报', 'u1')
  verify(ctx, 'u1')
  await ctx.scheduler.sweep()
  assert.equal(ctx.sentText.length, 0)
  assert.equal(ctx.agentCalls.length, 0) // 没有退化到 plain 路径去调 agent
  assert.ok(ctx.store.getTask('global-微信日报').lastRunAt > 0)
})

test('report/plain tasks are untouched by the digest branch', async (t) => {
  const ctx = setup({ digestRunner: { generate: async () => { throw new Error('digest 不该被调到') } } })
  t.after(ctx.cleanup)
  ctx.store.loadGlobalTasks([{ name: '普通公共任务', schedule: 'daily@21:30', kind: 'plain', instruction: '说点什么', createdAt: CREATED }])
  ctx.store.subscribe('普通公共任务', 'u1')
  verify(ctx, 'u1')
  await ctx.scheduler.sweep()
  assert.equal(ctx.agentCalls.length, 1) // 走 ADR-0014 的逐订阅者路径
  assert.equal(ctx.sentText.length, 1)
  assert.equal(ctx.sentText[0].text, 'plain 路径的输出')
})
