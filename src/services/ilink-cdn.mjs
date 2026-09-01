import crypto from 'node:crypto'

/** AES-128-ECB + CDN upload for the WeChat iLink bot media pipeline.
 *
 * Every non-text message (image/voice/file/video) in this protocol is
 * encrypted client-side with a fresh, random AES-128-ECB key before being
 * POSTed to a separate CDN host, then the (key, CDN reference) pair is
 * embedded in the `sendmessage` payload so the recipient's client can fetch
 * and decrypt it. This is reverse-engineered protocol behavior (see
 * ADR-0009) — kept in its own small, pure module so it can be unit-tested
 * against known padding/size invariants independent of the live network
 * calls in ilink-provider.mjs. */

export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

/** Encrypt a buffer with AES-128-ECB (PKCS7 padding, Node's default). */
export function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/** PKCS7-padded ciphertext size for a given plaintext size (pads to the next
 * 16-byte boundary; a block-aligned input still gets one full extra block —
 * this is standard PKCS7, not an off-by-one). The server wants this size
 * declared up front in getUploadUrl, before the actual encryption happens. */
export function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

export function buildCdnUploadUrl({ cdnBaseUrl = CDN_BASE_URL, uploadParam, filekey }) {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
}

/** Encrypt `buf` and POST it to the CDN. Returns the `downloadParam` (the
 * `x-encrypted-param` response header) to embed as `CDNMedia.encrypt_query_param`
 * in the eventual sendmessage call. Retries transient (5xx/network) failures;
 * a 4xx is treated as non-retryable (bad request shape, retrying won't help). */
export async function uploadBufferToCdn({ fetchImpl = globalThis.fetch, buf, uploadParam, uploadFullUrl = '', filekey, aeskey, cdnBaseUrl = CDN_BASE_URL, maxRetries = 3 }) {
  const ciphertext = encryptAesEcb(buf, aeskey)
  const fullUrl = String(uploadFullUrl || '').trim()
  if (!fullUrl && !uploadParam) throw new Error('CDN upload URL missing: upload_full_url/upload_param')
  const url = fullUrl || buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey })
  let lastError
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: ciphertext })
      if (res.status >= 400 && res.status < 500) {
        const msg = res.headers.get('x-error-message') || (await res.text().catch(() => ''))
        throw Object.assign(new Error(`CDN upload rejected (${res.status}): ${msg}`), { retryable: false })
      }
      if (res.status !== 200) {
        throw Object.assign(new Error(`CDN upload failed (${res.status})`), { retryable: true })
      }
      const downloadParam = res.headers.get('x-encrypted-param')
      if (!downloadParam) throw Object.assign(new Error('CDN upload response missing x-encrypted-param header'), { retryable: true })
      return { downloadParam, ciphertextSize: ciphertext.length }
    } catch (error) {
      lastError = error
      if (error?.retryable === false || attempt >= maxRetries) break
    }
  }
  throw lastError
}
