import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { encryptAesEcb, aesEcbPaddedSize, buildCdnUploadUrl, uploadBufferToCdn, CDN_BASE_URL } from '../src/services/ilink-cdn.mjs'

test('AES-128-ECB round-trips (encrypt then Node decrypt gives back the original)', () => {
  const key = crypto.randomBytes(16)
  const plaintext = Buffer.from('hello, this is a test document with some content 你好世界', 'utf8')
  const ciphertext = encryptAesEcb(plaintext, key)
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
  const roundtrip = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  assert.deepEqual(roundtrip, plaintext)
})

test('aesEcbPaddedSize matches the real ciphertext length for boundary and non-boundary sizes', () => {
  const key = crypto.randomBytes(16)
  for (const size of [0, 1, 15, 16, 17, 31, 32, 1000, 1024]) {
    const plaintext = crypto.randomBytes(size)
    const ciphertext = encryptAesEcb(plaintext, key)
    assert.equal(ciphertext.length, aesEcbPaddedSize(size), `mismatch at plaintext size ${size}`)
  }
})

test('buildCdnUploadUrl embeds encoded uploadParam and filekey', () => {
  const url = buildCdnUploadUrl({ uploadParam: 'a b&c', filekey: 'fk=1' })
  assert.equal(url, `${CDN_BASE_URL}/upload?encrypted_query_param=a%20b%26c&filekey=fk%3D1`)
})

test('uploadBufferToCdn encrypts, POSTs, and returns the x-encrypted-param header', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return { status: 200, headers: { get: (k) => (k === 'x-encrypted-param' ? 'dl-param-xyz' : null) } }
  }
  const buf = Buffer.from('document content')
  const aeskey = crypto.randomBytes(16)
  const result = await uploadBufferToCdn({ fetchImpl, buf, uploadParam: 'up1', filekey: 'fk1', aeskey })
  assert.equal(result.downloadParam, 'dl-param-xyz')
  assert.equal(result.ciphertextSize, aesEcbPaddedSize(buf.length))
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/upload\?encrypted_query_param=up1&filekey=fk1/)
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.headers['Content-Type'], 'application/octet-stream')
  assert.equal(Buffer.isBuffer(calls[0].options.body), true)
  assert.equal(calls[0].options.body.length, aesEcbPaddedSize(buf.length))
})

test('uploadBufferToCdn does not retry a 4xx (bad request shape), fails fast', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return { status: 400, headers: { get: () => 'bad filekey' }, text: async () => 'bad filekey' } }
  await assert.rejects(
    () => uploadBufferToCdn({ fetchImpl, buf: Buffer.from('x'), uploadParam: 'u', filekey: 'f', aeskey: crypto.randomBytes(16) }),
    /CDN upload rejected \(400\)/
  )
  assert.equal(calls, 1)
})

test('uploadBufferToCdn retries a 5xx up to maxRetries then throws', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return { status: 500, headers: { get: () => null } } }
  await assert.rejects(
    () => uploadBufferToCdn({ fetchImpl, buf: Buffer.from('x'), uploadParam: 'u', filekey: 'f', aeskey: crypto.randomBytes(16), maxRetries: 3 }),
    /CDN upload failed \(500\)/
  )
  assert.equal(calls, 3)
})
