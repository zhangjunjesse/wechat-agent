import test from 'node:test'
import assert from 'node:assert/strict'
import { ILinkProvider } from '../src/providers/ilink-provider.mjs'

test('iLink adapter maps QR lifecycle, credentials, polling and send payload', async () => {
  const calls = []
  let n = 0
  const responses = [
    { ok: true, json: async () => ({ qrcode: 'q1', qrcode_img_content: 'https://qr/q1' }) },
    { ok: true, json: async () => ({ status: 'scaned' }) },
    { ok: true, json: async () => ({ status: 'confirmed', ilink_bot_id: 'bot-1', ilink_user_id: 'wx-owner', bot_token: 'secret', baseurl: 'https://region' }) },
    { ok: true, json: async () => ({ get_updates_buf: 'c1', msgs: [{ message_type: 1, message_id: 42, from_user_id: 'wx-peer', context_token: 'ctx', item_list: [{ type: 1, text_item: { text: 'hello' } }] }] }) },
    { ok: true, json: async () => ({ ret: 0 }) },
  ]
  const provider = new ILinkProvider({ now: () => 1000, fetchImpl: async (url, options) => { calls.push({ url, options }); return responses[n++] } })
  const qr = await provider.createBindingQr({ userId: 'tenant-a' })
  assert.equal(qr.qrPayload, 'https://qr/q1')
  assert.equal((await provider.getBindingStatus({ bindingRef: qr.bindingRef })).status, 'scanned')
  const bound = await provider.getBindingStatus({ bindingRef: qr.bindingRef })
  assert.equal(bound.providerBotId, 'bot-1')
  const events = await provider.pollEvents({ providerBotId: 'bot-1' })
  assert.equal(events.events[0].text, 'hello')
  const sent = await provider.sendText({ providerBotId: 'bot-1', toProviderUserId: 'wx-peer', text: 'hi', contextToken: 'ctx' })
  assert.match(sent.providerMessageId, /^ilink-/)
  assert.equal(calls.length, 5)
})
