import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createApp, listen } from '../src/app.mjs'
import { MockBotProvider } from '../src/providers/mock-provider.mjs'
import { DownloadTokenStore } from '../src/services/download-tokens.mjs'
import { ReportStore } from '../src/services/report-store.mjs'
import { LarkTokenStore } from '../src/services/lark-token-store.mjs'

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
