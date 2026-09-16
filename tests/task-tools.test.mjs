import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { TaskStore } from '../src/services/task-store.mjs'
import { ReportStore } from '../src/services/report-store.mjs'
import { taskTools } from '../src/tools/task-tools.mjs'

function call(toolFn, input, ctx) {
  return toolFn.invoke(ctx, JSON.stringify(input))
}

function setup() {
  const file = path.join(os.tmpdir(), `tk-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const store = new TaskStore({ file })
  const tools = taskTools({ taskStore: store })
  const ctx = (userId = 'u1') => ({ context: { userId } })
  return { file, store, tools, ctx }
}

test('create_task validates and lists; delete_task is owner-scoped', async () => {
  const { file, store, tools, ctx } = setup()
  try {
    const out = await call(tools.createTask, { name: '晨报', schedule: 'daily@08:30', instruction: '搜新闻', }, ctx('u1'))
    assert.match(out, /已创建定时任务「晨报」/)
    assert.match(out, /每天 08:30/)
    const bad = await call(tools.createTask, { name: '坏', schedule: '8点', instruction: 'x' }, ctx('u1'))
    assert.match(bad, /创建失败：非法调度/)
    const dup = await call(tools.createTask, { name: '晨报', schedule: 'daily@09:00', instruction: 'x' }, ctx('u1'))
    assert.match(dup, /已存在/)
    // u2 cannot see or delete u1's task
    const u2list = await call(tools.listMyTasks, {}, ctx('u2'))
    assert.match(u2list, /你还没有定时任务/)
    const del = await call(tools.deleteTask, { name: '晨报' }, ctx('u2'))
    assert.match(del, /不存在/)
    assert.equal(store.listUserTasks('u1').length, 1)
    const delOk = await call(tools.deleteTask, { name: '晨报' }, ctx('u1'))
    assert.match(delOk, /已删除/)
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

test('global task directory + subscribe/unsubscribe via tools', async () => {
  const { file, store, tools, ctx } = setup()
  try {
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', instruction: '推送早报' }])
    const dir = await call(tools.listGlobalTasks, {}, ctx('u1'))
    assert.match(dir, /每日早报/)
    assert.match(dir, /每天 08:00/)
    assert.doesNotMatch(dir, /已订阅/)
    const sub = await call(tools.subscribeTask, { name: '每日早报' }, ctx('u1'))
    assert.match(sub, /已订阅/)
    const dir2 = await call(tools.listGlobalTasks, {}, ctx('u1'))
    assert.match(dir2, /已订阅/)
    // listed in my tasks
    const mine = await call(tools.listMyTasks, {}, ctx('u1'))
    assert.match(mine, /\[公共\] 每日早报/)
    const unsub = await call(tools.unsubscribeTask, { name: '每日早报' }, ctx('u1'))
    assert.match(unsub, /已退订/)
    assert.equal(store.isSubscribed('每日早报', 'u1'), false)
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

test('get_daily_report returns the latest report only for subscribed/owned tasks', async () => {
  const file = path.join(os.tmpdir(), `tk-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const repFile = file + '.rep.db'
  const store = new TaskStore({ file })
  const reportStore = new ReportStore({ file: repFile })
  const tools = taskTools({ taskStore: store, reportStore })
  const ctx = (userId = 'u1') => ({ context: { userId } })
  try {
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', instruction: 'x', kind: 'report' }])
    reportStore.saveReport({
      taskId: 'global-每日早报', name: '每日早报', runAt: Date.now(), focus: '关注点X',
      items: [{ title: 'T1', summary: 'S1', source: '源', url: 'https://a.com' }, { title: 'T2', summary: 'S2' }],
    })
    // 未订阅 → 找不到（不泄露他人/全局报告）
    const notSub = await call(tools.getDailyReport, {}, ctx('u2'))
    assert.match(notSub, /未找到报告/)
    const denied = await call(tools.getDailyReport, { name: '每日早报' }, ctx('u2'))
    assert.match(denied, /未订阅/)
    // 订阅后可见
    store.subscribe('每日早报', 'u1')
    const out = await call(tools.getDailyReport, {}, ctx('u1'))
    assert.match(out, /T1/)
    assert.match(out, /S1/)
    // 不带裸链接（ADR-0026：对齐海报"来源不放裸 URL"的规矩，追问细节该配合
    // gzh_content 抓正文，而不是把原文链接甩给用户）
    assert.doesNotMatch(out, /https:\/\/a\.com/)
    assert.match(out, /关注点X/)
    const out2 = await call(tools.getDailyReport, { name: '每日早报' }, ctx('u1'))
    assert.match(out2, /T2/)
    // 无 reportStore 时优雅返回
    const plain = taskTools({ taskStore: store })
    const out3 = await call(plain.getDailyReport, {}, ctx('u1'))
    assert.match(out3, /未启用/)
  } finally {
    store?.close?.(); reportStore?.close?.(); fs.rmSync(file, { force: true }); fs.rmSync(repFile, { force: true })
  }
})

test('update/list report topics are per-user and gated on subscription', async () => {
  const file = path.join(os.tmpdir(), `tk-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const repFile = file + '.rep.db'
  const store = new TaskStore({ file })
  const reportStore = new ReportStore({ file: repFile })
  const tools = taskTools({ taskStore: store, reportStore })
  const ctx = (userId = 'u1') => ({ context: { userId } })
  try {
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', instruction: 'x', kind: 'report' }])
    // 未订阅设置主题 → 拒绝
    const denied = await call(tools.updateReportTopics, { name: '每日早报', topics: ['AI'] }, ctx('u1'))
    assert.match(denied, /未订阅/)
    store.subscribe('每日早报', 'u1')
    store.subscribe('每日早报', 'u2')
    // u1 设置主题，u2 看不到
    const ok = await call(tools.updateReportTopics, { name: '每日早报', topics: ['AI', '芯片'] }, ctx('u1'))
    assert.match(ok, /AI、芯片/)
    // ADR-0027：多主题必须如实告知"各自独立推送"，不能让用户以为只是分区展示
    assert.match(ok, /2 条/)
    assert.match(ok, /各自独立生成一份、各发一条/)
    const mine = await call(tools.listReportTopics, {}, ctx('u1'))
    assert.match(mine, /每日早报：AI、芯片/)
    const other = await call(tools.listReportTopics, {}, ctx('u2'))
    assert.match(other, /还没有设置个性化主题/)
    // 清除
    const cleared = await call(tools.updateReportTopics, { name: '每日早报', topics: [] }, ctx('u1'))
    assert.match(cleared, /清除/)
    assert.equal(store.getReportTopics('每日早报', 'u1').length, 0)
    // 单主题不需要"多条推送"提醒（只有 1 条，无歧义）——顺带用它把 u1 设回单主题，
    // 给下面 get_daily_report 优先个性化版的断言用
    const single = await call(tools.updateReportTopics, { name: '每日早报', topics: ['AI'] }, ctx('u1'))
    assert.doesNotMatch(single, /各自独立生成一份/)
    // get_daily_report 优先个性化版（u1 有主题报告时返回它而非公共版）
    reportStore.saveReport({ taskId: 'global-每日早报', name: '每日早报', runAt: Date.now() - 1000, items: [{ title: '公共条', summary: 's' }] })
    reportStore.saveReport({ taskId: 'global-每日早报', name: '每日早报', runAt: Date.now(), userId: 'u1', topic: 'AI', items: [{ title: '我的个性化条', summary: 's' }] })
    const out = await call(tools.getDailyReport, {}, ctx('u1'))
    assert.match(out, /我的个性化条/)
    assert.doesNotMatch(out, /公共条/)
  } finally {
    store?.close?.(); reportStore?.close?.(); fs.rmSync(file, { force: true }); fs.rmSync(repFile, { force: true })
  }
})

// ADR-0027：订阅多个主题时当天有多份独立报告；get_daily_report/resend_daily_report
// 默认覆盖全部主题，指定 topic 时只处理那一份。
test('get_daily_report / resend_daily_report cover all of a user\'s topic reports by default, or just one via topic (ADR-0027)', async () => {
  const file = path.join(os.tmpdir(), `tk-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const repFile = file + '.rep.db'
  const posterFile = path.join(os.tmpdir(), `poster-${Date.now()}.png`)
  const store = new TaskStore({ file })
  const reportStore = new ReportStore({ file: repFile })
  const sent = { images: [], texts: [] }
  const provider = { sendImage: async (a) => { sent.images.push(a) }, sendText: async (a) => { sent.texts.push(a) } }
  const reportUrl = (id) => `https://h.example/reports/${id}`
  const tools = taskTools({ taskStore: store, reportStore, provider, reportUrl })
  const channel = { providerBotId: 'bot1', toProviderUserId: 'u1', contextToken: 'tok' }
  const ctx = (userId = 'u1') => ({ context: { userId, channel } })
  try {
    fs.writeFileSync(posterFile, Buffer.from('fake-png-bytes'))
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', instruction: 'x', kind: 'report' }])
    store.subscribe('每日早报', 'u1')
    store.setReportTopics({ globalName: '每日早报', userId: 'u1', topics: ['AI', '芯片'] })
    reportStore.saveReport({ taskId: 'global-每日早报', name: '每日早报', runAt: Date.now(), userId: 'u1', topic: 'AI', posterPath: posterFile, items: [{ title: 'AI条', summary: 's' }] })
    reportStore.saveReport({ taskId: 'global-每日早报', name: '每日早报', runAt: Date.now(), userId: 'u1', topic: '芯片', items: [{ title: '芯片条', summary: 's' }] })

    // 不指定 topic：get_daily_report 把两份都列出来
    const both = await call(tools.getDailyReport, {}, ctx('u1'))
    assert.match(both, /AI条/)
    assert.match(both, /芯片条/)
    assert.match(both, /（AI）/)
    assert.match(both, /（芯片）/)

    // 指定 topic：只返回那一份
    const onlyChip = await call(tools.getDailyReport, { topic: '芯片' }, ctx('u1'))
    assert.match(onlyChip, /芯片条/)
    assert.doesNotMatch(onlyChip, /AI条/)

    // 不指定 topic：resend 把两份都重发（各自一图一文/一文）
    const out = await call(tools.resendDailyReport, {}, ctx('u1'))
    assert.match(out, /已重新发送 2 份/)
    assert.equal(sent.images.length, 1) // 只有 AI 那份存了海报
    assert.equal(sent.texts.length, 2)
    assert.ok(sent.texts.some((t) => /当前主题：AI/.test(t.text)))
    assert.ok(sent.texts.some((t) => /当前主题：芯片/.test(t.text)))

    // 指定 topic：只重发那一份
    sent.images.length = 0; sent.texts.length = 0
    const outOne = await call(tools.resendDailyReport, { topic: 'AI' }, ctx('u1'))
    assert.match(outOne, /已重新发送.*每日早报（图\+说明）/)
    assert.equal(sent.images.length, 1)
    assert.equal(sent.texts.length, 1)
    assert.match(sent.texts[0].text, /当前主题：AI/)
  } finally {
    store?.close?.(); reportStore?.close?.(); fs.rmSync(file, { force: true }); fs.rmSync(repFile, { force: true }); fs.rmSync(posterFile, { force: true })
  }
})

// resend_daily_report（ADR-0026）：真事故——"日报补发一下"曾被路由到
// get_daily_report，模型自己现编了一段带 Markdown、带裸链接、没有图的回复。
// 这个工具必须自己调 provider 发图+发文字，不给模型现场编排的机会。
test('resend_daily_report resends the actual poster image + short text via provider', async () => {
  const file = path.join(os.tmpdir(), `tk-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const repFile = file + '.rep.db'
  const posterFile = path.join(os.tmpdir(), `poster-${Date.now()}.png`)
  const store = new TaskStore({ file })
  const reportStore = new ReportStore({ file: repFile })
  const sent = { images: [], texts: [] }
  const provider = {
    sendImage: async (a) => { sent.images.push(a) },
    sendText: async (a) => { sent.texts.push(a) },
  }
  const reportUrl = (id) => `https://h.example/reports/${id}`
  const tools = taskTools({ taskStore: store, reportStore, provider, reportUrl })
  const channel = { providerBotId: 'bot1', toProviderUserId: 'u1', contextToken: 'tok' }
  const ctx = (userId = 'u1') => ({ context: { userId, channel } })
  try {
    fs.writeFileSync(posterFile, Buffer.from('fake-png-bytes'))
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', instruction: 'x', kind: 'report' }])
    store.subscribe('每日早报', 'u1')
    const saved = reportStore.saveReport({
      taskId: 'global-每日早报', name: '每日早报', runAt: Date.now(), posterPath: posterFile,
      items: [{ title: 'T1', summary: 'S1' }],
    })
    const out = await call(tools.resendDailyReport, {}, ctx('u1'))
    assert.match(out, /已重新发送/)
    assert.equal(sent.images.length, 1)
    assert.equal(sent.images[0].fileName, path.basename(posterFile))
    assert.deepEqual(sent.images[0].buffer, Buffer.from('fake-png-bytes'))
    assert.equal(sent.images[0].contextToken, 'tok')
    assert.equal(sent.texts.length, 1)
    // 短描述必须是 renderPushText 的产物：带公网链接、标注"补发"，不是模型现编的内容
    assert.match(sent.texts[0].text, /🔁 每日早报（补发）/)
    assert.match(sent.texts[0].text, new RegExp(`https://h\\.example/reports/${saved.id}`))
    // 不该出现整段条目正文（工具不把内容摆进聊天，靠图+链接）
    assert.doesNotMatch(sent.texts[0].text, /T1/)
  } finally {
    store?.close?.(); reportStore?.close?.(); fs.rmSync(file, { force: true }); fs.rmSync(repFile, { force: true }); fs.rmSync(posterFile, { force: true })
  }
})

test('resend_daily_report degrades to text-only when the poster file is missing, and rejects unsubscribed/unready cases', async () => {
  const file = path.join(os.tmpdir(), `tk-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const repFile = file + '.rep.db'
  const store = new TaskStore({ file })
  const reportStore = new ReportStore({ file: repFile })
  const sent = { images: [], texts: [] }
  const provider = { sendImage: async (a) => { sent.images.push(a) }, sendText: async (a) => { sent.texts.push(a) } }
  const channel = { providerBotId: 'bot1', toProviderUserId: 'u1', contextToken: 'tok' }
  const ctx = (userId = 'u1') => ({ context: { userId, channel } })
  try {
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', instruction: 'x', kind: 'report' }])
    store.subscribe('每日早报', 'u1')
    // 没有报告：明确说明，不是"未启用"
    const tools = taskTools({ taskStore: store, reportStore, provider })
    assert.match(await call(tools.resendDailyReport, {}, ctx('u1')), /未找到报告，无法补发/)
    // posterPath 指向不存在的文件 → 降级为纯文字，不整体失败
    reportStore.saveReport({ taskId: 'global-每日早报', name: '每日早报', runAt: Date.now(), posterPath: '/nope/missing.png', items: [{ title: 'T1' }] })
    const degraded = await call(tools.resendDailyReport, {}, ctx('u1'))
    assert.match(degraded, /没有保存海报图/)
    assert.equal(sent.images.length, 0)
    assert.equal(sent.texts.length, 1)
    // 未订阅指定任务名 → 拒绝
    assert.match(await call(tools.resendDailyReport, { name: '每日早报' }, ctx('u2')), /未订阅\/未创建任务/)
    // 没配置 provider → 明确降级
    const noProvider = taskTools({ taskStore: store, reportStore })
    assert.match(await call(noProvider.resendDailyReport, {}, ctx('u1')), /发送能力未就绪/)
    // 渠道缺 contextToken（如网页对话）→ 明确提示
    const noToken = await call(tools.resendDailyReport, {}, { context: { userId: 'u1', channel: {} } })
    assert.match(noToken, /当前渠道不支持发送图片/)
  } finally {
    store?.close?.(); reportStore?.close?.(); fs.rmSync(file, { force: true }); fs.rmSync(repFile, { force: true })
  }
})
