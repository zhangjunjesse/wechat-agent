import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { TaskStore } from '../src/services/task-store.mjs'
import { TaskScheduler } from '../src/services/task-scheduler.mjs'
import { ReportStore } from '../src/services/report-store.mjs'
import { ContextTokenCache } from '../src/services/context-token-cache.mjs'

// Beijing 2026-09-10 08:00:30. Tasks are created 60s before NOW so their
// first trigger (daily@08:00) has already arrived.
const NOW = Date.UTC(2026, 8, 10, 0, 0, 30)
const CREATED = NOW - 60_000

function setup({ tasks = [], subscribers = {}, failSend = false } = {}) {
  const file = path.join(os.tmpdir(), `sch-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const store = new TaskStore({ file })
  const agent = { respond: async (args) => ({ text: `输出(${args.text.slice(0, 20)}…)` }) }
  const sent = []
  const provider = {
    sendText: failSend
      ? async () => { throw new Error('iLink 401 过期') }
      : async (args) => { sent.push(args); return { providerMessageId: 'm1' } },
  }
  const profiles = new Map()
  const profileStore = { get: async (id) => profiles.get(id) || null }
  const tokens = new ContextTokenCache({ file: file + '.ctx.json', flushDelayMs: 60000 })
  for (const [uid, tok] of Object.entries(subscribers)) tokens.update(uid, { contextToken: tok, providerBotId: 'bot-1' })
  const scheduler = new TaskScheduler({ taskStore: store, agent, provider, profileStore, contextTokens: tokens, now: () => NOW })
  for (const t of tasks) store.createUserTask({ createdAt: CREATED, ...t })
  return { file, store, scheduler, sent, profiles }
}

test('scheduler runs a due user task once and pushes to WeChat', async () => {
  const { file, store, scheduler, sent, profiles } = setup({
    tasks: [{ name: '早报', schedule: 'daily@08:00', instruction: '推送早报', ownerUserId: 'u1' }],
    subscribers: { u1: 'tok-u1' },
  })
  try {
    profiles.set('u1', { userId: 'u1', nickname: '用户一', wxid: 'wx-u1', ilinkUserId: 'u1' })
    await scheduler.sweep()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].toProviderUserId, 'u1')
    assert.equal(sent[0].contextToken, 'tok-u1')
    assert.match(sent[0].text, /早报/)
    const t = store.getTask(`user-u1-早报`)
    assert.ok(t.lastRunAt > 0)
    // second sweep does not re-run (lastRunAt guard)
    await scheduler.sweep()
    assert.equal(sent.length, 1)
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

test('scheduler skips tasks not yet due and users without contextToken', async () => {
  const { file, store, scheduler, sent, profiles } = setup({
    tasks: [
      { name: '未来任务', schedule: 'daily@09:00', instruction: 'x', ownerUserId: 'u1' }, // 09:00 not reached at 08:00:30
      { name: '无token', schedule: 'daily@08:00', instruction: 'y', ownerUserId: 'u2' },
    ],
    subscribers: { u1: 'tok-u1' }, // u2 has NO cached contextToken
  })
  try {
    profiles.set('u1', { userId: 'u1', nickname: 'u', wxid: 'w', ilinkUserId: 'u1' })
    profiles.set('u2', { userId: 'u2', nickname: 'u2', wxid: 'w2', ilinkUserId: 'u2' })
    await scheduler.sweep()
    assert.equal(sent.length, 0) // future task not due; tokenless user skipped
    // the due-but-tokenless task still got marked as run (skip is per-user, not per-task)
    assert.ok(store.getTask('user-u2-无token').lastRunAt > 0)
    assert.equal(store.getTask('user-u1-未来任务').lastRunAt, 0) // not due yet
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

test('scheduler runs a global task for every subscriber with tokens', async () => {
  const { file, store, scheduler, sent, profiles } = setup({
    subscribers: { u1: 'tok-1', u2: 'tok-2', u3: 'tok-3' },
  })
  try {
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', instruction: '早报', createdAt: CREATED }])
    store.subscribe('每日早报', 'u1')
    store.subscribe('每日早报', 'u2')
    store.subscribe('每日早报', 'u3')
    for (const id of ['u1', 'u2', 'u3']) profiles.set(id, { userId: id, nickname: id, wxid: 'wx-' + id, ilinkUserId: id })
    await scheduler.sweep()
    assert.deepEqual(sent.map((s) => s.toProviderUserId).sort(), ['u1', 'u2', 'u3'])
    const t = store.getTask('global-每日早报')
    assert.ok(t.lastRunAt > 0)
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

test('a subscriber without a verified profile is skipped without breaking others', async () => {
  const { file, store, scheduler, sent, profiles } = setup({ subscribers: { u1: 'tok-1', u2: 'tok-2' } })
  try {
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', instruction: '早报', createdAt: CREATED }])
    store.subscribe('每日早报', 'u1')
    store.subscribe('每日早报', 'u2')
    profiles.set('u1', { userId: 'u1', nickname: 'u1', wxid: 'wx1', ilinkUserId: 'u1' }) // u2 unverified
    await scheduler.sweep()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].toProviderUserId, 'u1')
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

test('send failures are aggregated into lastError', async () => {
  const { file, store, scheduler, profiles } = setup({
    tasks: [{ name: '早报', schedule: 'daily@08:00', instruction: 'x', ownerUserId: 'u1' }],
    subscribers: { u1: 'tok-u1' },
    failSend: true,
  })
  try {
    profiles.set('u1', { userId: 'u1', nickname: 'u1', wxid: 'wx1', ilinkUserId: 'u1' })
    await scheduler.sweep()
    const t = store.getTask('user-u1-早报')
    // 已结算（不是重试挂起）：这是投递失败（会话过期），不是生成失败——重试
    // 生成解决不了会话过期的问题，所以不该占 attemptCount/白耗 LLM 调用
    // （ADR-0026：区分"生成失败"与"投递失败"）。
    assert.ok(t.lastRunAt > 0)
    assert.equal(t.attemptCount, 0)
    assert.match(t.lastError, /iLink 401 过期/)
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

// ---- 报告类公共任务（DESIGN-daily-report.md：生成一次 + 扇出）----

const REPORT_JSON = JSON.stringify({
  focus: '关注AI新进展',
  cover: '',
  items: [
    { title: '标题A', summary: '摘要A', source: '源A', url: 'https://a.com' },
    { title: '标题B', summary: '摘要B', source: '源B', url: 'https://b.com' },
    { title: '标题C', summary: '摘要C', source: '源C', url: 'https://c.com' },
  ],
})

function setupReport({ agent, subscribers = {}, posterRender = null, provider = null, now = () => NOW, retryMax = 3, retryIntervalMs = 20 * 60_000 } = {}) {
  const file = path.join(os.tmpdir(), `sch-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const store = new TaskStore({ file })
  const reportStore = new ReportStore({ file: file + '.rep.db' })
  const sent = []
  const sentImgs = []
  const realProvider = provider || {
    sendText: async (args) => { sent.push(args); return { providerMessageId: 'm1' } },
  }
  const profiles = new Map()
  const profileStore = { get: async (id) => profiles.get(id) || null }
  const tokens = new ContextTokenCache({ file: file + '.ctx.json', flushDelayMs: 60000 })
  for (const [uid, tok] of Object.entries(subscribers)) tokens.update(uid, { contextToken: tok, providerBotId: 'bot-1' })
  const root = path.join(os.tmpdir(), `sch-root-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const scheduler = new TaskScheduler({ taskStore: store, agent, provider: realProvider, profileStore, contextTokens: tokens, now, reportStore, reportUrl: (id) => `https://reports.local/${id}`, posterRender, retryMax, retryIntervalMs })
  store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', instruction: '生成早报', kind: 'report', createdAt: CREATED }])
  for (const uid of Object.keys(subscribers)) store.subscribe('每日早报', uid) // 订阅者真正入订阅列表
  return { file, root, store, reportStore, scheduler, sent, sentImgs, profiles }
}

test('report-kind global task runs the agent once and fans the same short text out', async () => {
  const calls = []
  const agent = { respond: async (args) => { calls.push(args); return { text: REPORT_JSON } } }
  const { file, root, store, reportStore, scheduler, sent, profiles } = setupReport({ agent, subscribers: { u1: 'tok-1', u2: 'tok-2', u3: 'tok-3' } })
  try {
    for (const id of ['u1', 'u2', 'u3']) profiles.set(id, { userId: id, nickname: '用户' + id, wxid: 'wx-' + id, ilinkUserId: id })
    await scheduler.sweep()
    assert.equal(calls.length, 1) // 生成只跑一次，不随订阅者数翻倍
    assert.equal(sent.length, 3)
    for (const m of sent) {
      assert.match(m.text, /已送达/)
      assert.match(m.text, /https:\/\/reports\.local\/rp-/) // 公网 URL 在短描述里
      assert.match(m.text, /第N条展开讲讲/)
      assert.doesNotMatch(m.text, /标题A/) // 内容在海报里，不在文本里
      assert.doesNotMatch(m.text, /https:\/\/a\.com/) // 不裸奔 URL
    }
    const t = store.getTask('global-每日早报')
    assert.ok(t.lastRunAt > 0)
    const reports = reportStore.listReports('global-每日早报', 5)
    assert.equal(reports.length, 1)
    assert.equal(reportStore.getReport(reports[0].id).items.length, 3)
    // 第二轮 sweep 不重跑
    await scheduler.sweep()
    assert.equal(sent.length, 3)
  } finally {
    store?.close?.(); reportStore?.close?.(); fs.rmSync(file, { force: true }); fs.rmSync(file + '.rep.db', { force: true }); fs.rmSync(root, { recursive: true, force: true })
  }
})

test('report task prompt carries recent titles for dedup', async () => {
  let promptText = ''
  const agent = { respond: async (args) => { promptText = args.text; return { text: REPORT_JSON } } }
  const { file, root, store, reportStore, scheduler, sent, profiles } = setupReport({ agent, subscribers: { u1: 'tok-1' } })
  try {
    profiles.set('u1', { userId: 'u1', nickname: 'u1', wxid: 'w', ilinkUserId: 'u1' })
    reportStore.saveReport({ taskId: 'global-每日早报', name: '每日早报', runAt: NOW - 86_400_000, items: [{ title: '昨日旧闻', summary: '', source: '', url: '' }] })
    await scheduler.sweep()
    assert.match(promptText, /昨日旧闻/)
    assert.match(promptText, /近 7 天已报道/)
    assert.match(promptText, /【定时任务「每日早报」】/)
  } finally {
    store?.close?.(); reportStore?.close?.(); fs.rmSync(file, { force: true }); fs.rmSync(file + '.rep.db', { force: true }); fs.rmSync(root, { recursive: true, force: true })
  }
})

test('unparsable report degrades to raw text push and records report_unparsable', async () => {
  const agent = { respond: async () => ({ text: '抱歉，今天没有合适的新闻。' }) }
  const { file, root, store, reportStore, scheduler, sent, profiles } = setupReport({ agent, subscribers: { u1: 'tok-1' } })
  try {
    profiles.set('u1', { userId: 'u1', nickname: 'u1', wxid: 'w', ilinkUserId: 'u1' })
    await scheduler.sweep()
    assert.equal(sent.length, 1)
    assert.match(sent[0].text, /抱歉，今天没有合适的新闻/)
    const t = store.getTask('global-每日早报')
    assert.match(t.lastError, /report_unparsable/)
    assert.equal(reportStore.listReports('global-每日早报', 5).length, 0) // 未入库
  } finally {
    store?.close?.(); reportStore?.close?.(); fs.rmSync(file, { force: true }); fs.rmSync(file + '.rep.db', { force: true }); fs.rmSync(root, { recursive: true, force: true })
  }
})

test('poster image is sent before the short text; poster failure degrades to text-only', async () => {  const agentOk = { respond: async () => ({ text: REPORT_JSON }) }
  // 场景 1：posterRender 产出真实文件 → sendImage 先于 sendText，posterPath 入库
  const posterFile = path.join(os.tmpdir(), `poster-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
  fs.writeFileSync(posterFile, Buffer.from([137, 80, 78, 71]))
  const sentImgs1 = []
  const sent1 = []
  const s1 = setupReport({
    agent: agentOk, subscribers: { u1: 'tok-1' },
    posterRender: async () => posterFile,
    provider: { sendImage: async (a) => { sentImgs1.push(a); return {} }, sendText: async (a) => { sent1.push(a); return {} } },
  })
  try {
    s1.profiles.set('u1', { userId: 'u1', nickname: 'u1', wxid: 'w', ilinkUserId: 'u1' })
    await s1.scheduler.sweep()
    assert.equal(sentImgs1.length, 1)
    assert.equal(sentImgs1[0].fileName, path.basename(posterFile))
    assert.equal(sent1.length, 1)
    assert.match(sent1[0].text, /已送达/)
    const rep = s1.reportStore.listReports('global-每日早报', 1)
    assert.equal(s1.reportStore.getReport(rep[0].id).posterPath, posterFile)
  } finally {
    s1.store?.close?.(); s1.reportStore?.close?.(); fs.rmSync(s1.file, { force: true }); fs.rmSync(s1.file + '.rep.db', { force: true }); fs.rmSync(s1.root, { recursive: true, force: true }); fs.rmSync(posterFile, { force: true })
  }

  // 场景 2：posterRender 抛错 → 任务不失败，纯文本推送，无 sendImage
  const sentImgs2 = []
  const sent2 = []
  const s2 = setupReport({
    agent: agentOk, subscribers: { u1: 'tok-1' },
    posterRender: async () => { throw new Error('no browser') },
    provider: { sendImage: async (a) => { sentImgs2.push(a); return {} }, sendText: async (a) => { sent2.push(a); return {} } },
  })
  try {
    s2.profiles.set('u1', { userId: 'u1', nickname: 'u1', wxid: 'w', ilinkUserId: 'u1' })
    await s2.scheduler.sweep()
    assert.equal(sentImgs2.length, 0)
    assert.equal(sent2.length, 1)
    assert.match(sent2[0].text, /已送达/)
    const t = s2.store.getTask('global-每日早报')
    assert.equal(t.lastError, '') // 海报失败不污染任务错误（内容本身成功）
  } finally {
    s2.store?.close?.(); s2.reportStore?.close?.(); fs.rmSync(s2.file, { force: true }); fs.rmSync(s2.file + '.rep.db', { force: true }); fs.rmSync(s2.root, { recursive: true, force: true })
  }

  // 场景 3：poster 文件缺失 → 无 sendImage，仍有短文本
  const ghostFile = path.join(os.tmpdir(), `ghost-${Date.now()}.png`)
  const sentImgs3 = []
  const sent3 = []
  const s3 = setupReport({
    agent: agentOk, subscribers: { u1: 'tok-1' },
    posterRender: async () => ghostFile,
    provider: { sendImage: async (a) => { sentImgs3.push(a); return {} }, sendText: async (a) => { sent3.push(a); return {} } },
  })
  try {
    s3.profiles.set('u1', { userId: 'u1', nickname: 'u1', wxid: 'w', ilinkUserId: 'u1' })
    await s3.scheduler.sweep()
    assert.equal(sentImgs3.length, 0)
    assert.equal(sent3.length, 1)
    assert.match(sent3[0].text, /https:\/\/reports\.local\/rp-/)
  } finally {
    s3.store?.close?.(); s3.reportStore?.close?.(); fs.rmSync(s3.file, { force: true }); fs.rmSync(s3.file + '.rep.db', { force: true }); fs.rmSync(s3.root, { recursive: true, force: true })
  }
})

// ---- 失败重试（ADR-0026）：生产事故——8:00 报告因 402 失败，lastRunAt 照样被
// 推进到"今天"，调度器算出下次=明天，切换模型修好问题后也没人推动重试，
// 干等一整天。修法：失败不结算，按 retryIntervalMs 节流、当天重试 retryMax 次，
// 全部失败才放弃并如实告知"明天再来"。----

test('report generation failure retries with backoff, then gives up for the day and settles', async () => {
  let calls = 0
  const agent = { respond: async () => { calls++; throw new Error('402 Insufficient Balance') } }
  let nowMs = NOW
  const { file, root, store, reportStore, scheduler, sent, profiles } = setupReport({
    agent, subscribers: { u1: 'tok-1' }, now: () => nowMs, retryMax: 2, retryIntervalMs: 1000,
  })
  try {
    profiles.set('u1', { userId: 'u1', nickname: 'u1', wxid: 'w', ilinkUserId: 'u1' })

    // 第 1 次尝试：失败，不结算（lastRunAt 仍是 0，任务仍"到期"），措辞是"会自动重试"
    await scheduler.sweep()
    assert.equal(calls, 1)
    let t = store.getTask('global-每日早报')
    assert.equal(t.lastRunAt, 0)
    assert.equal(t.attemptCount, 1)
    assert.equal(sent.length, 1)
    assert.match(sent[0].text, /系统会自动重试/)

    // 节流：还没到 retryIntervalMs，立刻再 sweep 不会重试（不浪费一次 LLM 调用）
    await scheduler.sweep()
    assert.equal(calls, 1)
    assert.equal(sent.length, 1)

    // 过了 retryIntervalMs：第 2 次尝试，仍失败，仍未结算
    nowMs += 1000
    await scheduler.sweep()
    assert.equal(calls, 2)
    t = store.getTask('global-每日早报')
    assert.equal(t.lastRunAt, 0)
    assert.equal(t.attemptCount, 2)
    assert.match(sent[1].text, /系统会自动重试/)

    // 第 3 次尝试（= retryMax+1）：仍失败——这是最后一次机会，放弃并结算，
    // 话术改说"今天不再重试，明天按计划再试"（不再是没人会照做的"请稍后重试"）
    nowMs += 1000
    await scheduler.sweep()
    assert.equal(calls, 3)
    t = store.getTask('global-每日早报')
    assert.ok(t.lastRunAt > 0) // 已结算
    assert.equal(t.attemptCount, 0) // 归零，迎接下一个自然周期
    assert.match(sent[2].text, /已重试 3 次仍失败，今天不再重试，明天按计划再试/)
    assert.equal(reportStore.listReports('global-每日早报', 5).length, 0) // 全程没有一份生成成功

    // 结算后不会再触发（下次到期是明天）
    nowMs += 1000
    await scheduler.sweep()
    assert.equal(calls, 3)
    assert.equal(sent.length, 3)
  } finally {
    store?.close?.(); reportStore?.close?.(); fs.rmSync(file, { force: true }); fs.rmSync(file + '.rep.db', { force: true }); fs.rmSync(root, { recursive: true, force: true })
  }
})

test('report generation succeeding on a retry settles immediately with the normal push text', async () => {
  let calls = 0
  const agent = { respond: async () => { calls++; if (calls === 1) throw new Error('502 Bad Gateway'); return { text: REPORT_JSON } } }
  let nowMs = NOW
  const { file, root, store, reportStore, scheduler, sent, profiles } = setupReport({
    agent, subscribers: { u1: 'tok-1' }, now: () => nowMs, retryMax: 3, retryIntervalMs: 1000,
  })
  try {
    profiles.set('u1', { userId: 'u1', nickname: 'u1', wxid: 'w', ilinkUserId: 'u1' })
    await scheduler.sweep()
    assert.equal(store.getTask('global-每日早报').attemptCount, 1)
    nowMs += 1000
    await scheduler.sweep()
    assert.equal(calls, 2)
    const t = store.getTask('global-每日早报')
    assert.ok(t.lastRunAt > 0)
    assert.equal(t.attemptCount, 0)
    assert.equal(reportStore.listReports('global-每日早报', 5).length, 1)
    assert.match(sent[sent.length - 1].text, /已送达/) // 成功用的是正常措辞，不是失败话术
  } finally {
    store?.close?.(); reportStore?.close?.(); fs.rmSync(file, { force: true }); fs.rmSync(file + '.rep.db', { force: true }); fs.rmSync(root, { recursive: true, force: true })
  }
})


test('report topics: per-user personalized runs are isolated and never shared (ADR-0019)', async () => {
  const calls = []
  // 按 prompt 内容回不同 JSON（用主题区分，方便断言隔离）
  const agent = { respond: async (args) => {
    calls.push(args)
    const isRobot = /个性化主题：机器人/.test(args.text)
    const items = [
      { title: isRobot ? '机器人头条' : '公共头条', summary: 's', source: 'src', url: 'https://x.com' },
      { title: '条目B', summary: 's2', source: 'src2', url: 'https://y.com' },
      { title: '条目C', summary: 's3', source: 'src3', url: 'https://z.com' },
    ]
    return { text: JSON.stringify({ focus: '关注', items }) }
  } }
  const { file, root, store, reportStore, scheduler, sent, profiles } = setupReport({ agent, subscribers: { u1: 'tok-1', u2: 'tok-2', u3: 'tok-3' } })
  try {
    for (const id of ['u1', 'u2', 'u3']) profiles.set(id, { userId: id, nickname: 'u' + id, wxid: 'wx-' + id, ilinkUserId: id })
    store.subscribe('每日早报', 'u1')
    store.subscribe('每日早报', 'u2')
    store.subscribe('每日早报', 'u3')
    // u1 订阅 机器人 主题、u2 无主题（公共版）
    store.setReportTopics({ globalName: '每日早报', userId: 'u1', topics: ['机器人'] })
    await scheduler.sweep()
    // 生成次数 = 公共版 1（u2/u3 共享）+ u1 1 = 2
    assert.equal(calls.length, 2)
    // prompt 隔离：u1 的 prompt 只含机器人，公共版不含
    const u1Prompt = calls.find((c) => c.userId === 'task-global-每日早报-u1-机器人').text
    const sharedPrompt = calls.find((c) => c.userId === 'task-global-每日早报').text
    assert.match(u1Prompt, /个性化主题：机器人/)
    assert.doesNotMatch(sharedPrompt, /个性化主题：/)
    // 报告按用户+主题维度入库：2 份不同 id 的报告
    const shared = reportStore.listReports('global-每日早报', 5)
    const u1Reps = reportStore.listReports('global-每日早报', 5, { userId: 'u1', topic: '机器人' })
    assert.equal(shared.length, 1)
    assert.equal(u1Reps.length, 1)
    assert.equal(reportStore.getReport(u1Reps[0].id).items[0].title, '机器人头条')
    assert.equal(reportStore.getReport(u1Reps[0].id).topic, '机器人')
    assert.equal(reportStore.getReport(shared[0].id).items[0].title, '公共头条')
    // 推送隔离：每条短文本都带各自报告的 URL（id 不同 = 不串），个性化的带主题提示
    assert.equal(sent.length, 3) // u1 一条 + u2/u3 各一条共享文本
    const u1Msg = sent.find((m) => m.toProviderUserId === 'u1')
    assert.match(u1Msg.text, /当前主题：机器人/)
    const urls = sent.map((m) => (/https:\/\/reports\.local\/(rp-[^\n]+)/.exec(m.text) || [])[1])
    assert.equal(new Set(urls).size, 2) // u1 的主题版 + u2/u3 共享的公共版
    assert.ok(urls.every(Boolean))
  } finally {
    store?.close?.(); reportStore?.close?.(); fs.rmSync(file, { force: true }); fs.rmSync(file + '.rep.db', { force: true }); fs.rmSync(root, { recursive: true, force: true })
  }
})

// ADR-0027：订阅 N 个主题 = 当天收到 N 份独立报告（各自生成/去重/海报），
// 不再合并成一份让模型自行权衡分配——那样订阅多个主题也看不出区别。
test('a user with multiple topics gets one independent report+push per topic (ADR-0027)', async () => {
  const calls = []
  const agent = { respond: async (args) => {
    calls.push(args)
    const m = /个性化主题：([^。\n]+)/.exec(args.text)
    const topic = m ? m[1] : ''
    const items = [
      { title: `${topic || '公共'}头条`, summary: 's', source: 'src', url: 'https://x.com' },
      { title: '条目B', summary: 's2', source: 'src2', url: 'https://y.com' },
      { title: '条目C', summary: 's3', source: 'src3', url: 'https://z.com' },
    ]
    return { text: JSON.stringify({ focus: `关注${topic}`, items }) }
  } }
  const { file, root, store, reportStore, scheduler, sent, profiles } = setupReport({ agent, subscribers: { u1: 'tok-1' } })
  try {
    profiles.set('u1', { userId: 'u1', nickname: 'u1', wxid: 'wx-u1', ilinkUserId: 'u1' })
    store.subscribe('每日早报', 'u1')
    store.setReportTopics({ globalName: '每日早报', userId: 'u1', topics: ['AI', '芯片'] })
    await scheduler.sweep()
    // 生成次数 = 2（AI 一次、芯片一次），没有公共版调用（u1 是唯一订阅者且已设主题）
    assert.equal(calls.length, 2)
    const aiCall = calls.find((c) => c.userId === 'task-global-每日早报-u1-AI')
    const chipCall = calls.find((c) => c.userId === 'task-global-每日早报-u1-芯片')
    assert.ok(aiCall && chipCall, '两个主题应各自用独立的合成会话 id 生成')
    assert.match(aiCall.text, /个性化主题：AI/)
    assert.doesNotMatch(aiCall.text, /个性化主题：芯片/)
    assert.match(chipCall.text, /个性化主题：芯片/)
    assert.doesNotMatch(chipCall.text, /个性化主题：AI/)

    // 入库：2 份不同 id 的报告，各自维度隔离
    const aiReps = reportStore.listReports('global-每日早报', 5, { userId: 'u1', topic: 'AI' })
    const chipReps = reportStore.listReports('global-每日早报', 5, { userId: 'u1', topic: '芯片' })
    assert.equal(aiReps.length, 1)
    assert.equal(chipReps.length, 1)
    assert.notEqual(aiReps[0].id, chipReps[0].id)
    assert.equal(reportStore.getReport(aiReps[0].id).items[0].title, 'AI头条')
    assert.equal(reportStore.getReport(chipReps[0].id).items[0].title, '芯片头条')

    // 推送：用户收到 2 条独立消息（各自一图一文的文案），不是合并成一条
    assert.equal(sent.length, 2)
    const texts = sent.map((m) => m.text)
    assert.ok(texts.some((t) => /当前主题：AI/.test(t)))
    assert.ok(texts.some((t) => /当前主题：芯片/.test(t)))
    const urls = texts.map((t) => (/https:\/\/reports\.local\/(rp-[^\n]+)/.exec(t) || [])[1])
    assert.equal(new Set(urls).size, 2) // 两份报告链接不同
  } finally {
    store?.close?.(); reportStore?.close?.(); fs.rmSync(file, { force: true }); fs.rmSync(file + '.rep.db', { force: true }); fs.rmSync(root, { recursive: true, force: true })
  }
})

// 一个主题生成失败不该连累同一用户的其他主题（各自独立降级）。
test('one topic failing does not block another topic for the same user (ADR-0027)', async () => {
  const agent = { respond: async (args) => {
    if (/个性化主题：AI/.test(args.text)) throw new Error('502 Bad Gateway')
    const items = [{ title: '芯片头条', summary: 's', source: 'src', url: 'https://x.com' }, { title: 'B', summary: '' }, { title: 'C', summary: '' }]
    return { text: JSON.stringify({ focus: '关注', items }) }
  } }
  const { file, root, store, reportStore, scheduler, sent, profiles } = setupReport({ agent, subscribers: { u1: 'tok-1' } })
  try {
    profiles.set('u1', { userId: 'u1', nickname: 'u1', wxid: 'wx-u1', ilinkUserId: 'u1' })
    store.subscribe('每日早报', 'u1')
    store.setReportTopics({ globalName: '每日早报', userId: 'u1', topics: ['AI', '芯片'] })
    await scheduler.sweep()
    // 两条都推送了：AI 是失败话术，芯片是正常海报文案——一个主题失败不拦住
    // 另一个主题当轮送达。结算语义已按 ADR-0028 收紧：AI 单元还在等重试，
    // 任务**不**当轮结算（只有 AI 也成功或耗尽重试次数后才结算），但已成功的
    // 芯片不会被拖进重试循环重复推送（见下方 ADR-0028 的按单元重试测试）。
    assert.equal(sent.length, 2)
    const t = store.getTask('global-每日早报')
    assert.equal(t.lastRunAt, 0) // 未结算：AI 单元还挂着
    assert.deepEqual(t.retryUnits, [{ userId: 'u1', topic: 'AI', attempts: 1 }])
    assert.ok(sent.some((m) => /系统会自动重试/.test(m.text)))
    assert.ok(sent.some((m) => /已送达/.test(m.text)))
    assert.equal(reportStore.listReports('global-每日早报', 5, { userId: 'u1', topic: '芯片' }).length, 1)
    assert.equal(reportStore.listReports('global-每日早报', 5, { userId: 'u1', topic: 'AI' }).length, 0)
  } finally {
    store?.close?.(); reportStore?.close?.(); fs.rmSync(file, { force: true }); fs.rmSync(file + '.rep.db', { force: true }); fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---- 按生成单元独立重试（ADR-0028）：ADR-0026 的重试判定是任务级全有全无
// （"一份都没成功"才重试），ADR-0027 之后一个任务一轮有多个独立生成单元
// （公共版 + 每个 (用户,主题)），部分成功部分失败几乎必然——一旦有任何单元
// 成功，失败单元既不被重试，其用户还收到过"系统会自动重试"的虚假承诺。
// 修法：失败单元记入 tasks.retry_units（跨 tick 持久化），重试轮只重跑挂着的
// 单元；全部单元成功或耗尽重试次数后任务才整体结算。----

test('partial failure retries only the failed unit; delivered units are never re-pushed (ADR-0028)', async () => {
  // 3 个生成单元：公共版（u2 无主题）+ u1 的 AI / 芯片两个主题；AI 首轮失败
  let aiFails = true
  const calls = []
  const agent = { respond: async (args) => {
    calls.push(args)
    if (/个性化主题：AI/.test(args.text) && aiFails) throw new Error('502 Bad Gateway')
    const m = /个性化主题：([^。\n]+)/.exec(args.text)
    const topic = m ? m[1] : ''
    const items = [
      { title: `${topic || '公共'}头条`, summary: 's', source: 'src', url: 'https://x.com' },
      { title: '条目B', summary: 's2', source: 'src2', url: 'https://y.com' },
      { title: '条目C', summary: 's3', source: 'src3', url: 'https://z.com' },
    ]
    return { text: JSON.stringify({ focus: `关注${topic}`, items }) }
  } }
  let nowMs = NOW
  const { file, root, store, reportStore, scheduler, sent, profiles } = setupReport({
    agent, subscribers: { u1: 'tok-1', u2: 'tok-2' }, now: () => nowMs, retryMax: 2, retryIntervalMs: 1000,
  })
  try {
    for (const id of ['u1', 'u2']) profiles.set(id, { userId: id, nickname: 'u' + id, wxid: 'wx-' + id, ilinkUserId: id })
    store.setReportTopics({ globalName: '每日早报', userId: 'u1', topics: ['AI', '芯片'] })

    // 第 1 轮：3 个单元都跑；AI 失败（收到"会自动重试"，且这个承诺必须兑现），
    // 公共版/芯片成功送达。任务不结算——不能因为别的单元成功就抛下 AI。
    await scheduler.sweep()
    assert.equal(calls.length, 3)
    assert.equal(sent.length, 3) // u2 公共版 + u1 芯片 + u1 AI 失败话术
    assert.equal(sent.filter((m) => m.toProviderUserId === 'u2').length, 1)
    const aiFail = sent.find((m) => m.toProviderUserId === 'u1' && /系统会自动重试/.test(m.text))
    assert.ok(aiFail, 'AI 单元的失败话术应承诺自动重试（且后面真的会重试）')
    let t = store.getTask('global-每日早报')
    assert.equal(t.lastRunAt, 0) // 未结算：AI 单元还在等重试
    assert.equal(t.attemptCount, 1)
    assert.deepEqual(t.retryUnits, [{ userId: 'u1', topic: 'AI', attempts: 1 }])

    // 第 2 轮（过了 retryIntervalMs，AI 恢复）：只重跑 AI 这一个单元——
    // 公共版和芯片已送达，不重新生成、更不重复推送。
    aiFails = false
    nowMs += 1000
    await scheduler.sweep()
    assert.equal(calls.length, 4) // 只多了 1 次生成
    assert.equal(calls[3].userId, 'task-global-每日早报-u1-AI')
    assert.equal(sent.length, 4) // 只多了 1 条推送（AI 成功版）
    assert.equal(sent.filter((m) => m.toProviderUserId === 'u2').length, 1) // u2 没有被重复打扰
    assert.match(sent[3].text, /当前主题：AI/)
    assert.match(sent[3].text, /已送达/)
    assert.equal(reportStore.listReports('global-每日早报', 5, { userId: 'u1', topic: 'AI' }).length, 1)
    // 失败单元也成功了 → 任务整体结算，单元状态清空
    t = store.getTask('global-每日早报')
    assert.ok(t.lastRunAt > 0)
    assert.equal(t.attemptCount, 0)
    assert.deepEqual(t.retryUnits, [])

    // 结算后不再触发（下次到期是明天）
    nowMs += 1000
    await scheduler.sweep()
    assert.equal(calls.length, 4)
    assert.equal(sent.length, 4)
  } finally {
    store?.close?.(); reportStore?.close?.(); fs.rmSync(file, { force: true }); fs.rmSync(file + '.rep.db', { force: true }); fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a unit that keeps failing exhausts its own retries, gets the give-up text, then the task settles (ADR-0028)', async () => {
  // u1 订阅 AI/芯片：AI 一直失败到耗尽，芯片首轮成功（且全程只被推送一次）
  const calls = []
  const agent = { respond: async (args) => {
    calls.push(args)
    if (/个性化主题：AI/.test(args.text)) throw new Error('502 Bad Gateway')
    const items = [{ title: '芯片头条', summary: 's', source: 'src', url: 'https://x.com' }, { title: 'B', summary: '' }, { title: 'C', summary: '' }]
    return { text: JSON.stringify({ focus: '关注', items }) }
  } }
  let nowMs = NOW
  const { file, root, store, reportStore, scheduler, sent, profiles } = setupReport({
    agent, subscribers: { u1: 'tok-1' }, now: () => nowMs, retryMax: 2, retryIntervalMs: 1000,
  })
  try {
    profiles.set('u1', { userId: 'u1', nickname: 'u1', wxid: 'wx-u1', ilinkUserId: 'u1' })
    store.setReportTopics({ globalName: '每日早报', userId: 'u1', topics: ['AI', '芯片'] })

    // 第 1 轮：芯片成功、AI 失败（第 1 次尝试，承诺自动重试）
    await scheduler.sweep()
    assert.equal(calls.length, 2)
    let t = store.getTask('global-每日早报')
    assert.equal(t.lastRunAt, 0)
    assert.deepEqual(t.retryUnits, [{ userId: 'u1', topic: 'AI', attempts: 1 }])

    // 第 2 轮：只重跑 AI，仍失败（第 2 次尝试，还有余量，仍是"会自动重试"）
    nowMs += 1000
    await scheduler.sweep()
    assert.equal(calls.length, 3)
    t = store.getTask('global-每日早报')
    assert.equal(t.lastRunAt, 0)
    assert.deepEqual(t.retryUnits, [{ userId: 'u1', topic: 'AI', attempts: 2 }])
    assert.match(sent[sent.length - 1].text, /系统会自动重试/)

    // 第 3 轮（= retryMax+1 次尝试）：AI 单元重试耗尽——收到"今天不再重试、
    // 明天再试"的话术，任务整体结算（锚点推到明天），单元状态清空。
    nowMs += 1000
    await scheduler.sweep()
    assert.equal(calls.length, 4)
    t = store.getTask('global-每日早报')
    assert.ok(t.lastRunAt > 0) // 已结算：所有最初尝试过的单元都成功或耗尽
    assert.equal(t.attemptCount, 0)
    assert.deepEqual(t.retryUnits, [])
    assert.match(sent[sent.length - 1].text, /已重试 3 次仍失败，今天不再重试，明天按计划再试/)

    // 芯片全程只生成 1 次、推送 1 次（没有被 AI 的重试连累重复打扰）
    assert.equal(calls.filter((c) => c.userId === 'task-global-每日早报-u1-芯片').length, 1)
    assert.equal(sent.filter((m) => /当前主题：芯片/.test(m.text)).length, 1)
    assert.equal(reportStore.listReports('global-每日早报', 5, { userId: 'u1', topic: '芯片' }).length, 1)

    // 结算后当天不再触发
    nowMs += 1000
    await scheduler.sweep()
    assert.equal(calls.length, 4)
  } finally {
    store?.close?.(); reportStore?.close?.(); fs.rmSync(file, { force: true }); fs.rmSync(file + '.rep.db', { force: true }); fs.rmSync(root, { recursive: true, force: true })
  }
})
