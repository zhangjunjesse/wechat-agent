import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp, listen } from '../src/app.mjs'
import { MockBotProvider } from '../src/providers/mock-provider.mjs'

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
