import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { ILinkProvider } from '../src/providers/ilink-provider.mjs'
import { aesEcbPaddedSize } from '../src/services/ilink-cdn.mjs'

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
  assert.equal(Buffer.from(item.file_item.media.aes_key, 'base64').toString('ascii').length, 32)
  assert.match(Buffer.from(item.file_item.media.aes_key, 'base64').toString('ascii'), /^[0-9a-f]{32}$/)
})

test('pollEvents downloads and decrypts inbound FILE items into the user sandbox', async () => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inbound-'))
  try {
    const key = crypto.randomBytes(16)
    const plain = Buffer.from('name,age\n张三,30\n', 'utf8')
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
    const encodedKey = Buffer.from(key.toString('hex')).toString('base64')
    const provider = new ILinkProvider({
      userFilesRoot: root,
      fetchImpl: async (url) => {
        if (String(url).includes('getupdates')) {
          return { ok: true, json: async () => ({ msgs: [{ message_type: 1, message_id: 99, from_user_id: 'wx-user', context_token: 'ctx', item_list: [{ type: 4, file_item: { file_name: '名单.csv', media: { encrypt_query_param: 'download-param', aes_key: encodedKey } } }] }] }) }
        }
        if (String(url).includes('/download?')) return { ok: true, arrayBuffer: async () => encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength) }
        throw new Error(`unexpected fetch: ${url}`)
      },
    })
    await provider.restoreSession({ bindingRef: 'b', userId: 'tenant', botId: 'bot-in', token: 'tok', baseUrl: 'https://region', profile: { providerUserId: 'wx-owner' }, cursor: '' })
    const events = await provider.pollEvents({ providerBotId: 'bot-in' })
    assert.equal(events.events.length, 1)
    assert.equal(events.events[0].text, '')
    assert.match(events.events[0].attachments[0].name, /名单\.csv$/)
    const saved = await fs.readFile(path.join(root, 'wx-user', events.events[0].attachments[0].path), 'utf8')
    assert.equal(saved, plain.toString('utf8'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('sendFile accepts the current upload_full_url response shape', async () => {
  const calls = []
  const provider = await boundProvider(async (url, options) => {
    calls.push({ url: String(url), options })
    if (String(url).includes('get_bot_qrcode')) return { ok: true, json: async () => ({ qrcode: 'q1', qrcode_img_content: 'https://qr/q1' }) }
    if (String(url).includes('get_qrcode_status')) return { ok: true, json: async () => ({ status: 'confirmed', ilink_bot_id: 'bot-full', ilink_user_id: 'wx-owner', bot_token: 'secret', baseurl: 'https://region' }) }
    if (String(url).includes('getuploadurl')) return { ok: true, json: async () => ({ upload_full_url: 'https://upload.example/cdn/signed' }) }
    if (String(url).includes('upload.example')) return { status: 200, headers: { get: (k) => k === 'x-encrypted-param' ? 'dl-full' : null } }
    if (String(url).includes('sendmessage')) return { ok: true, json: async () => ({ ret: 0 }) }
    throw new Error(`unexpected fetch: ${url}`)
  })
  await provider.sendFile({ providerBotId: 'bot-full', toProviderUserId: 'wx-peer', contextToken: 'ctx', fileName: 'report.xlsx', buffer: Buffer.from('binary') })
  assert.ok(calls.some((c) => c.url === 'https://upload.example/cdn/signed'))
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

// Shared mock: QR lifecycle + getuploadurl + CDN + sendmessage, recording calls.
function mediaFetch(calls, { downloadParam = 'dl-xyz', uploadFullUrl = '' } = {}) {
  return async (url, options) => {
    calls.push({ url: String(url), options })
    if (String(url).includes('get_bot_qrcode')) return { ok: true, json: async () => ({ qrcode: 'q1', qrcode_img_content: 'https://qr/q1' }) }
    if (String(url).includes('get_qrcode_status')) return { ok: true, json: async () => ({ status: 'confirmed', ilink_bot_id: 'bot-1', ilink_user_id: 'wx-owner', bot_token: 'secret', baseurl: 'https://region' }) }
    if (String(url).includes('getuploadurl')) return { ok: true, json: async () => (uploadFullUrl ? { upload_full_url: uploadFullUrl } : { upload_param: 'up-xyz' }) }
    if (String(url).includes('novac2c.cdn.weixin.qq.com') || (uploadFullUrl && String(url).startsWith(uploadFullUrl))) return { status: 200, headers: { get: (k) => (k === 'x-encrypted-param' ? downloadParam : null) } }
    if (String(url).includes('sendmessage')) return { ok: true, json: async () => ({ ret: 0 }) }
    throw new Error(`unexpected fetch: ${url}`)
  }
}

function lastSendItem(calls) {
  const sendCall = calls.find((c) => c.url.includes('sendmessage'))
  return JSON.parse(sendCall.options.body).msg.item_list[0]
}

test('sendVideo uploads with media_type=VIDEO and sends a VIDEO item whose video_size is the ciphertext size', async () => {
  const calls = []
  const provider = await boundProvider(mediaFetch(calls))
  const buffer = Buffer.from('fake mp4 payload', 'utf8')
  await provider.sendVideo({ providerBotId: 'bot-1', toProviderUserId: 'wx-peer', contextToken: 'ctx', fileName: 'clip.mp4', buffer })

  const uploadUrlBody = JSON.parse(calls.find((c) => c.url.includes('getuploadurl')).options.body)
  assert.equal(uploadUrlBody.media_type, 2) // VIDEO
  assert.equal(uploadUrlBody.rawsize, buffer.length)
  assert.equal(uploadUrlBody.no_need_thumb, true)
  assert.equal(uploadUrlBody.aeskey.length, 32)

  const item = lastSendItem(calls)
  assert.equal(item.type, 5) // VIDEO
  assert.equal(item.video_item.video_size, aesEcbPaddedSize(buffer.length))
  assert.equal(item.video_item.media.encrypt_query_param, 'dl-xyz')
  assert.equal(item.video_item.media.encrypt_type, 1)
  assert.match(Buffer.from(item.video_item.media.aes_key, 'base64').toString('ascii'), /^[0-9a-f]{32}$/)
  assert.equal(item.video_item.file_name, undefined)
  assert.equal(item.file_item, undefined)
})

test('sendImage uploads with media_type=IMAGE and sends an IMAGE item whose mid_size is the ciphertext size', async () => {
  const calls = []
  const provider = await boundProvider(mediaFetch(calls))
  const buffer = Buffer.from('fake png payload', 'utf8')
  await provider.sendImage({ providerBotId: 'bot-1', toProviderUserId: 'wx-peer', contextToken: 'ctx', fileName: 'photo.png', buffer })

  const uploadUrlBody = JSON.parse(calls.find((c) => c.url.includes('getuploadurl')).options.body)
  assert.equal(uploadUrlBody.media_type, 1) // IMAGE
  assert.equal(uploadUrlBody.rawsize, buffer.length)
  assert.equal(uploadUrlBody.no_need_thumb, true)

  const item = lastSendItem(calls)
  assert.equal(item.type, 2) // IMAGE
  assert.equal(item.image_item.mid_size, aesEcbPaddedSize(buffer.length))
  assert.equal(item.image_item.media.encrypt_query_param, 'dl-xyz')
  assert.equal(item.image_item.media.encrypt_type, 1)
  assert.match(Buffer.from(item.image_item.media.aes_key, 'base64').toString('ascii'), /^[0-9a-f]{32}$/)
  assert.equal(item.file_item, undefined)
})

test('sendVideo/sendImage reuse the same CDN upload pipeline (upload_full_url accepted)', async () => {
  const calls = []
  const provider = await boundProvider(mediaFetch(calls, { uploadFullUrl: 'https://upload.example/cdn/signed-v' }))
  const buffer = Buffer.from('bytes', 'utf8')
  await provider.sendVideo({ providerBotId: 'bot-1', toProviderUserId: 'wx-peer', contextToken: 'ctx', fileName: 'v.mp4', buffer })
  assert.ok(calls.some((c) => c.url === 'https://upload.example/cdn/signed-v'))
  assert.equal(lastSendItem(calls).type, 5)
})
