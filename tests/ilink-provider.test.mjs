import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
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

async function boundProvider(fetchImpl) {
  const provider = new ILinkProvider({ now: () => 1000, fetchImpl })
  const qr = await provider.createBindingQr({ userId: 'tenant-a' })
  await provider.getBindingStatus({ bindingRef: qr.bindingRef })
  return provider
}

test('sendFile uploads the buffer AES-encrypted to the CDN, then sends a FILE item referencing it', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    if (String(url).includes('get_bot_qrcode')) return { ok: true, json: async () => ({ qrcode: 'q1', qrcode_img_content: 'https://qr/q1' }) }
    if (String(url).includes('get_qrcode_status')) return { ok: true, json: async () => ({ status: 'confirmed', ilink_bot_id: 'bot-1', ilink_user_id: 'wx-owner', bot_token: 'secret', baseurl: 'https://region' }) }
    if (String(url).includes('getuploadurl')) return { ok: true, json: async () => ({ upload_param: 'up-xyz' }) }
    if (String(url).includes('novac2c.cdn.weixin.qq.com')) return { status: 200, headers: { get: (k) => (k === 'x-encrypted-param' ? 'dl-xyz' : null) } }
    if (String(url).includes('sendmessage')) return { ok: true, json: async () => ({ ret: 0 }) }
    throw new Error(`unexpected fetch: ${url}`)
  }
  const provider = await boundProvider(fetchImpl)
  const buffer = Buffer.from('a,b\n1,2\n', 'utf8')
  const result = await provider.sendFile({ providerBotId: 'bot-1', toProviderUserId: 'wx-peer', contextToken: 'ctx', fileName: 'report.csv', buffer })
  assert.match(result.providerMessageId, /^ilink-/)

  const uploadUrlCall = calls.find((c) => c.url.includes('getuploadurl'))
  const uploadUrlBody = JSON.parse(uploadUrlCall.options.body)
  assert.equal(uploadUrlBody.media_type, 3) // FILE
  assert.equal(uploadUrlBody.rawsize, buffer.length)
  assert.equal(uploadUrlBody.rawfilemd5, crypto.createHash('md5').update(buffer).digest('hex'))
  assert.equal(uploadUrlBody.no_need_thumb, true)
  assert.equal(typeof uploadUrlBody.aeskey, 'string')
  assert.equal(uploadUrlBody.aeskey.length, 32) // 16 bytes hex-encoded

  const cdnCall = calls.find((c) => c.url.includes('novac2c.cdn.weixin.qq.com'))
  assert.match(cdnCall.url, /\/upload\?encrypted_query_param=up-xyz&filekey=/)
  assert.equal(cdnCall.options.method, 'POST')
  assert.ok(Buffer.isBuffer(cdnCall.options.body))

  const sendCall = calls.find((c) => c.url.includes('sendmessage'))
  const sendBody = JSON.parse(sendCall.options.body)
  const item = sendBody.msg.item_list[0]
  assert.equal(item.type, 4) // FILE
  assert.equal(item.file_item.file_name, 'report.csv')
  assert.equal(item.file_item.len, String(buffer.length))
  assert.equal(item.file_item.media.encrypt_query_param, 'dl-xyz')
  assert.equal(item.file_item.media.encrypt_type, 1)
  assert.equal(Buffer.from(item.file_item.media.aes_key, 'base64').length, 16)
})

test('sendFile rejects without a bound session or a contextToken', async () => {
  const provider = new ILinkProvider({ fetchImpl: async () => { throw new Error('should not fetch') } })
  await assert.rejects(() => provider.sendFile({ providerBotId: 'unknown', toProviderUserId: 'x', contextToken: 'ctx', fileName: 'a.csv', buffer: Buffer.from('x') }), /bound session not available/)

  const bound = await boundProvider(async (url) => {
    if (String(url).includes('get_bot_qrcode')) return { ok: true, json: async () => ({ qrcode: 'q1', qrcode_img_content: 'https://qr/q1' }) }
    return { ok: true, json: async () => ({ status: 'confirmed', ilink_bot_id: 'bot-2', ilink_user_id: 'wx-owner', bot_token: 'secret', baseurl: 'https://region' }) }
  })
  await assert.rejects(() => bound.sendFile({ providerBotId: 'bot-2', toProviderUserId: 'x', contextToken: '', fileName: 'a.csv', buffer: Buffer.from('x') }), /contextToken is required/)
})
