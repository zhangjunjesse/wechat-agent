import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createApp, listen } from '../src/app.mjs'
import { MockBotProvider } from '../src/providers/mock-provider.mjs'
import { DownloadTokenStore } from '../src/services/download-tokens.mjs'

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
