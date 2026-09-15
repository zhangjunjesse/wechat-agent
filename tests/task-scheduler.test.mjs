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
    assert.ok(t.lastRunAt > 0)
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

function setupReport({ agent, subscribers = {}, posterRender = null, provider = null } = {}) {
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
  const scheduler = new TaskScheduler({ taskStore: store, agent, provider: realProvider, profileStore, contextTokens: tokens, now: () => NOW, reportStore, reportUrl: (id) => `https://reports.local/${id}`, posterRender })
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

test('poster image is sent before the short text; poster failure degrades to text-only', async () => {
  const agentOk = { respond: async () => ({ text: REPORT_JSON }) }
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
