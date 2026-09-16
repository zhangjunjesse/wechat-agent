import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createApp, listen, buildOnVerified, DEFAULT_SUBSCRIPTIONS } from '../src/app.mjs'
import { MockBotProvider } from '../src/providers/mock-provider.mjs'
import { DownloadTokenStore } from '../src/services/download-tokens.mjs'
import { ReportStore } from '../src/services/report-store.mjs'
import { LarkTokenStore } from '../src/services/lark-token-store.mjs'
import { TaskStore } from '../src/services/task-store.mjs'
import { ProfileStore } from '../src/services/profile-store.mjs'
import { ContextTokenCache } from '../src/services/context-token-cache.mjs'

test('HTTP composition exposes health, binding, status, and webhook routes', async (t) => {
  const provider = new MockBotProvider()
  const app = createApp({ provider, agent: { async respond({ text }) { return { text: `reply:${text}` } } } })
  const server = await listen(app, { port: 0 })
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true })
  const missing = await fetch(`${base}/api/bindings`, { method: 'POST', body: '{}' })
  assert.equal(missing.status, 401)
  const created = await fetch(`${base}/api/bindings`, { method: 'POST', headers: { 'x-user-id': 'tenant-a' }, body: '{}' })
  assert.equal(created.status, 201)
  const binding = await created.json()
  assert.equal(binding.status, 'pending')

  provider.bind(binding.providerRef, { botId: 'bot-a', profile: { providerUserId: 'wx-a', nickname: 'A' } })
  const status = await fetch(`${base}/api/bindings/${binding.id}`, { headers: { 'x-user-id': 'tenant-a' } })
  assert.equal((await status.json()).status, 'bound')

  const inbound = await fetch(`${base}/api/bot/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerBotId: 'bot-a', providerMessageId: 'm-1', providerUserId: 'wx-a', text: 'hi' }),
  })
  assert.deepEqual(await inbound.json(), { accepted: true, duplicate: false, providerMessageId: 'out-1', text: 'reply:hi' })
})

test('GET /files/:token serves a sandboxed file to a valid token and 404s otherwise', async (t) => {
  const userFilesRoot = path.join(os.tmpdir(), `app-files-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(path.join(userFilesRoot, 'u1', 'out'), { recursive: true })
  fs.writeFileSync(path.join(userFilesRoot, 'u1', 'out', 'a.csv'), 'name,phone\nZ,123', 'utf8')
  t.after(() => fs.rmSync(userFilesRoot, { recursive: true, force: true }))

  const downloadTokens = new DownloadTokenStore()
  const provider = new MockBotProvider()
  const app = createApp({ provider, downloadTokens, userFilesRoot })
  const server = await listen(app, { port: 0 })
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  const token = downloadTokens.issue('u1', 'out/a.csv')
  const ok = await fetch(`${base}/files/${token}`)
  assert.equal(ok.status, 200)
  assert.match(ok.headers.get('content-type'), /text\/csv/)
  assert.match(ok.headers.get('content-disposition'), /attachment.*a\.csv/)
  assert.equal(await ok.text(), 'name,phone\nZ,123')

  // Same route also works under the reverse-proxy subpath.
  const okSubpath = await fetch(`${base}/wechat-agent/files/${token}`)
  assert.equal(okSubpath.status, 200)

  const unknown = await fetch(`${base}/files/not-a-real-token`)
  assert.equal(unknown.status, 404)

  // A token can't be redirected to read a different user's file by tampering
  // with the path — resolution is keyed entirely off the token, not the URL.
  const otherUserToken = downloadTokens.issue('u2', '../u1/out/a.csv')
  const blocked = await fetch(`${base}/files/${otherUserToken}`)
  assert.equal(blocked.status, 404)
})

test('GET /reports/:id serves the report page and cover route', async (t) => {
  const repFile = path.join(os.tmpdir(), `app-rep-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const coverFile = path.join(os.tmpdir(), `app-cov-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
  fs.writeFileSync(coverFile, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) // PNG magic
  const reportStore = new ReportStore({ file: repFile })
  t.after(() => { reportStore.close(); fs.rmSync(repFile, { force: true }); fs.rmSync(coverFile, { force: true }) })
  const report = reportStore.saveReport({
    taskId: 'global-每日早报', name: '每日早报', runAt: Date.now(), focus: '关注X', coverPath: coverFile,
    items: [{ title: '页面标题X', summary: '摘要Y', source: '源', url: 'https://a.com' }],
  })
  const provider = new MockBotProvider()
  const app = createApp({ provider, reportStore })
  const server = await listen(app, { port: 0 })
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  const page = await fetch(`${base}/reports/${report.id}`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /text\/html/)
  const html = await page.text()
  assert.match(html, /页面标题X/)
  assert.match(html, /摘要Y/)
  assert.match(html, /阅读原文/)
  assert.match(html, /关注X/)

  // 反向代理子路径前缀也兼容
  const pageSub = await fetch(`${base}/wechat-agent/reports/${report.id}`)
  assert.equal(pageSub.status, 200)

  // cover 路由
  const cov = await fetch(`${base}/reports/${report.id}/cover`)
  assert.equal(cov.status, 200)
  assert.match(cov.headers.get('content-type'), /image\/png/)

  // 未知报告 / 无封面 / 未配置 reportStore → 404 且不崩
  assert.equal((await fetch(`${base}/reports/nope`)).status, 404)
  const noCover = reportStore.saveReport({ taskId: 't2', name: '无封面', runAt: Date.now(), items: [{ title: 'A', summary: 's' }] })
  assert.equal((await fetch(`${base}/reports/${noCover.id}/cover`)).status, 404)
  const app2 = createApp({ provider: new MockBotProvider() })
  const server2 = await listen(app2, { port: 0 })
  t.after(() => server2.close())
  assert.equal((await fetch(`http://127.0.0.1:${server2.address().port}/reports/x`)).status, 404)
})

test('GET /reports/:id renders the digest template for wechat-digest reports', async (t) => {
  const repFile = path.join(os.tmpdir(), `app-dg-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const reportStore = new ReportStore({ file: repFile })
  t.after(() => { reportStore.close(); fs.rmSync(repFile, { force: true }) })
  const digest = reportStore.saveReport({
    taskId: 'global-微信日报', name: '微信日报', runAt: Date.now(), focus: '今天主要是项目群', kind: 'wechat-digest',
    items: [
      { title: '给李四回复接口方案', summary: '他等你的答复', source: '来自 项目群 · 09-16 18:30', section: 'action_items' },
      { title: '周六带爸复查', summary: '上午', source: '来自 家人群 · 09-16 16:30', section: 'work_updates' },
    ],
  })
  const news = reportStore.saveReport({
    taskId: 'global-每日资讯', name: '每日资讯', runAt: Date.now(),
    items: [{ title: '新闻标题X', summary: '摘要', source: '某公众号', url: 'https://a.com' }],
  })
  const app = createApp({ provider: new MockBotProvider(), reportStore })
  const server = await listen(app, { port: 0 })
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  const html = await (await fetch(`${base}/reports/${digest.id}`)).text()
  assert.match(html, /需要你行动/)          // 分节标题
  assert.match(html, /你该知道/)
  assert.match(html, /来自 项目群 · 09-16 18:30/) // 溯源
  assert.doesNotMatch(html, /阅读原文/)      // 不是新闻模板

  // 老数据（无 kind）仍走每日资讯模板，行为不变
  const newsHtml = await (await fetch(`${base}/reports/${news.id}`)).text()
  assert.equal(reportStore.getReport(news.id).kind, 'report')
  assert.match(newsHtml, /阅读原文/)
  assert.doesNotMatch(newsHtml, /需要你行动/)
})

// ---- ADR-0031：注册核验即默认订阅 ----
// 关键在订阅键：subscribe_task 工具写进 subscribers 的是 iLink providerUserId
// （run context 的 userId），而 onVerified 拿到的是网页那次性的 browser id。
// 用错键 = 写进一个调度器永远查不到的订阅，用户永远收不到推送。

function subSetup(t) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const taskFile = path.join(os.tmpdir(), `app-sub-t-${stamp}.db`)
  const profFile = path.join(os.tmpdir(), `app-sub-p-${stamp}.json`)
  const ctxFile = path.join(os.tmpdir(), `app-sub-c-${stamp}.json`)
  const taskStore = new TaskStore({ file: taskFile })
  const profileStore = new ProfileStore({ file: profFile })
  const contextTokens = new ContextTokenCache({ file: ctxFile, flushDelayMs: 60_000 })
  const sent = []
  const provider = { sendText: async (a) => { sent.push(a); return { providerMessageId: 'm1' } } }
  const errors = []
  t.after(() => {
    taskStore.close(); contextTokens.close()
    for (const f of [taskFile, profFile, ctxFile]) fs.rmSync(f, { force: true })
  })
  taskStore.loadGlobalTasks([{ name: '每日资讯', schedule: 'daily@08:00', kind: 'report', instruction: 'x' }])
  return { taskStore, profileStore, contextTokens, provider, sent, errors }
}

test('onVerified subscribes with the STABLE tenant key (ilinkUserId), not the browser id', async (t) => {
  const s = subSetup(t)
  const BROWSER_ID = 'u_51cf2368-99a'
  const ILINK_ID = 'o9cq80wXtSkIXBJDDLCggTI4WQPY@im.wechat'
  // VerificationService 先 put 再调钩子 —— stableKey 依赖这个顺序才解析得出来
  const profile = { nickname: '张三', wxid: 'wxid_zhang', ilinkUserId: ILINK_ID }
  await s.profileStore.put(BROWSER_ID, profile)

  const onVerified = buildOnVerified({ taskStore: s.taskStore, profileStore: s.profileStore, provider: s.provider, contextTokens: s.contextTokens, onError: (e) => s.errors.push(e) })
  await onVerified({ userId: BROWSER_ID, profile })

  const task = s.taskStore.getTask('global-每日资讯')
  assert.deepEqual(task.subscribers, [ILINK_ID])            // ← 与 subscribe_task / 调度器同一命名空间
  assert.equal(task.subscribers.includes(BROWSER_ID), false)
  assert.equal(s.taskStore.isSubscribed('每日资讯', ILINK_ID), true)
  assert.deepEqual(s.errors, [])
})

test('onVerified sends a welcome message only when that channel has a usable session', async (t) => {
  const s = subSetup(t)
  const ILINK_ID = 'ilink-zhang@im.wechat'
  const profile = { nickname: '张三', wxid: 'wxid_zhang', ilinkUserId: ILINK_ID }
  await s.profileStore.put('u_browser', profile)
  s.contextTokens.update(ILINK_ID, { contextToken: 'tok-1', providerBotId: 'bot-1' })

  const onVerified = buildOnVerified({ taskStore: s.taskStore, profileStore: s.profileStore, provider: s.provider, contextTokens: s.contextTokens })
  await onVerified({ userId: 'u_browser', profile })

  assert.equal(s.sent.length, 1)
  assert.equal(s.sent[0].toProviderUserId, ILINK_ID)
  assert.equal(s.sent[0].contextToken, 'tok-1')
  assert.match(s.sent[0].text, /已默认为你订阅「每日资讯」/)
  assert.match(s.sent[0].text, /退订每日资讯/) // 必须告诉用户怎么退
})

test('onVerified without a cached contextToken still subscribes, silently', async (t) => {
  const s = subSetup(t)
  const ILINK_ID = 'ilink-no-token@im.wechat'
  const profile = { nickname: '李四', wxid: 'wxid_li', ilinkUserId: ILINK_ID }
  await s.profileStore.put('u_browser2', profile)
  // 核验走网页，那一刻通常没有 iLink 会话 —— 这是常态，不是错误
  const onVerified = buildOnVerified({ taskStore: s.taskStore, profileStore: s.profileStore, provider: s.provider, contextTokens: s.contextTokens, onError: (e) => s.errors.push(e) })
  await onVerified({ userId: 'u_browser2', profile })

  assert.deepEqual(s.taskStore.getTask('global-每日资讯').subscribers, [ILINK_ID])
  assert.equal(s.sent.length, 0)
  assert.deepEqual(s.errors, [])
  // provider 完全缺失时也一样
  const onVerified2 = buildOnVerified({ taskStore: s.taskStore, profileStore: s.profileStore, contextTokens: s.contextTokens })
  await onVerified2({ userId: 'u_browser2', profile })
})

test('re-verifying does not subscribe twice or re-send the welcome message', async (t) => {
  const s = subSetup(t)
  const ILINK_ID = 'ilink-repeat@im.wechat'
  const profile = { nickname: '张三', wxid: 'wxid_zhang', ilinkUserId: ILINK_ID }
  await s.profileStore.put('u_b1', profile)
  s.contextTokens.update(ILINK_ID, { contextToken: 'tok', providerBotId: 'bot-1' })
  const onVerified = buildOnVerified({ taskStore: s.taskStore, profileStore: s.profileStore, provider: s.provider, contextTokens: s.contextTokens })

  await onVerified({ userId: 'u_b1', profile })
  await onVerified({ userId: 'u_b1', profile })
  // 浏览器换了一个 id 重新核验 —— 同一个微信用户，stableKey 解析到同一个键
  await s.profileStore.put('u_b2', profile)
  await onVerified({ userId: 'u_b2', profile })

  assert.deepEqual(s.taskStore.getTask('global-每日资讯').subscribers, [ILINK_ID])
  assert.equal(s.sent.length, 1) // 欢迎语只发一次
})

test('a user who already unsubscribed is re-subscribed only if they verify again (no silent resurrection)', async (t) => {
  const s = subSetup(t)
  const ILINK_ID = 'ilink-optout@im.wechat'
  const profile = { nickname: '王五', wxid: 'wxid_wang', ilinkUserId: ILINK_ID }
  await s.profileStore.put('u_b', profile)
  const onVerified = buildOnVerified({ taskStore: s.taskStore, profileStore: s.profileStore })

  await onVerified({ userId: 'u_b', profile })
  assert.equal(s.taskStore.isSubscribed('每日资讯', ILINK_ID), true)
  s.taskStore.unsubscribe('每日资讯', ILINK_ID) // 用户主动退订
  assert.equal(s.taskStore.isSubscribed('每日资讯', ILINK_ID), false)
  // 退订后不会被任何后台流程悄悄恢复；只有用户再走一次核验才会重新订上
  await onVerified({ userId: 'u_b', profile })
  assert.equal(s.taskStore.isSubscribed('每日资讯', ILINK_ID), true)
})

test('a missing default task is reported but never breaks verification', async (t) => {
  const s = subSetup(t)
  const profile = { nickname: '张三', wxid: 'wxid_zhang', ilinkUserId: 'ilink-x' }
  await s.profileStore.put('u_b', profile)
  const onVerified = buildOnVerified({
    taskStore: s.taskStore, profileStore: s.profileStore, provider: s.provider, contextTokens: s.contextTokens,
    defaultSubscriptions: ['不存在的任务', '每日资讯'],
    onError: (e, name) => s.errors.push(name),
  })
  await assert.doesNotReject(() => onVerified({ userId: 'u_b', profile }))
  assert.deepEqual(s.errors, ['不存在的任务'])
  assert.deepEqual(s.taskStore.getTask('global-每日资讯').subscribers, ['ilink-x']) // 另一条照常订上
})

test('buildOnVerified is inert without a taskStore or with an empty subscription list', () => {
  assert.equal(buildOnVerified({ taskStore: null }), null)
  assert.equal(buildOnVerified({ taskStore: {}, defaultSubscriptions: [] }), null)
  assert.equal(buildOnVerified({ taskStore: {}, defaultSubscriptions: ['  '] }), null)
  assert.deepEqual(DEFAULT_SUBSCRIPTIONS, ['每日资讯']) // 必须与 deploy/global-tasks.json 的 name 一致
})

test('GET /lark/auth/callback exchanges code when lark configured, 404 otherwise (ADR-0021)', async (t) => {
  // 未配置 lark → 404，不影响其他功能
  const app1 = createApp({ provider: new MockBotProvider() })
  const server1 = await listen(app1, { port: 0 })
  t.after(() => server1.close())
  assert.equal((await fetch(`http://127.0.0.1:${server1.address().port}/lark/auth/callback?code=x&state=u1`)).status, 404)

  // 配置 lark（mock client）→ 200 + token 入库 + 子路径前缀兼容
  const file = path.join(os.tmpdir(), `app-lark-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const tokenStore = new LarkTokenStore({ file })
  t.after(() => { tokenStore.close(); fs.rmSync(file, { force: true }) })
  const exchanged = []
  const lark = { client: { exchangeCode: async ({ code, userId }) => { exchanged.push({ code, userId }); tokenStore.set({ userId, accessToken: 'tok', refreshToken: 'r', expiresIn: 7200, refreshExpiresIn: 3600 }) } } }
  const app2 = createApp({ provider: new MockBotProvider(), lark })
  const server2 = await listen(app2, { port: 0 })
  t.after(() => server2.close())
  const base2 = `http://127.0.0.1:${server2.address().port}`

  const ok = await fetch(`${base2}/lark/auth/callback?code=the-code&state=u9`)
  assert.equal(ok.status, 200)
  assert.deepEqual(exchanged, [{ code: 'the-code', userId: 'u9' }])
  assert.equal(tokenStore.get('u9').accessToken, 'tok')
  const okSub = await fetch(`${base2}/wechat-agent/lark/auth/callback?code=c2&state=u9`)
  assert.equal(okSub.status, 200)
  // 缺参 → 400；exchangeCode 抛错 → 400
  assert.equal((await fetch(`${base2}/lark/auth/callback?code=only`)).status, 400)
  const app3 = createApp({ provider: new MockBotProvider(), lark: { client: { exchangeCode: async () => { throw new Error('bad code') } } } })
  const server3 = await listen(app3, { port: 0 })
  t.after(() => server3.close())
  assert.equal((await fetch(`http://127.0.0.1:${server3.address().port}/lark/auth/callback?code=bad&state=u1`)).status, 400)
})
