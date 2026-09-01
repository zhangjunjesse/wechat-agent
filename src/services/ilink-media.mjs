import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveUserPath } from './user-sandbox.mjs'

const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const MAX_INBOUND_FILE_BYTES = 50 * 1024 * 1024

/** Download and decrypt an inbound iLink media item into the user's sandbox. */
export async function downloadInboundFile({ fetchImpl = globalThis.fetch, item, userId, root, cdnBaseUrl = DEFAULT_CDN_BASE_URL, messageId = '' }) {
  const media = item?.file_item?.media || item?.image_item?.media || item?.video_item?.media || item?.voice_item?.media
  const encryptedParam = media?.encrypt_query_param
  if (!encryptedParam) throw new Error('iLink inbound media missing encrypt_query_param')
  const key = decodeAesKey(item)
  if (!key || key.length !== 16) throw new Error('iLink inbound media missing valid AES-128 key')
  const url = `${cdnBaseUrl.replace(/\/$/, '')}/download?encrypted_query_param=${encodeURIComponent(encryptedParam)}`
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`iLink media download failed: ${response.status}`)
  const encrypted = Buffer.from(await response.arrayBuffer())
  if (encrypted.length > MAX_INBOUND_FILE_BYTES + 16) throw new Error('iLink inbound media exceeds 50MB limit')
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()])
  if (plain.length > MAX_INBOUND_FILE_BYTES) throw new Error('iLink inbound media exceeds 50MB limit')
  const originalName = item?.file_item?.file_name || `inbound-${messageId || Date.now()}.bin`
  const safeName = path.basename(String(originalName)).replace(/[^\w.\-\u4e00-\u9fff ()]/g, '_').slice(0, 180) || `inbound-${Date.now()}.bin`
  const full = resolveUserPath(root, userId, `inbox/${Date.now()}-${safeName}`)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, plain)
  return {
    type: item?.file_item ? 'file' : item?.image_item ? 'image' : item?.video_item ? 'video' : 'voice',
    name: safeName,
    path: path.relative(path.join(path.resolve(root), String(userId)), full).replaceAll(path.sep, '/'),
    size: plain.length,
    mimeType: mimeForName(safeName),
  }
}

function decodeAesKey(item) {
  const media = item?.file_item?.media || item?.image_item?.media || item?.video_item?.media || item?.voice_item?.media
  const raw = item?.file_item?.aeskey || item?.image_item?.aeskey || item?.video_item?.aeskey || item?.voice_item?.aeskey
  if (raw && /^[0-9a-fA-F]{32}$/.test(String(raw))) return Buffer.from(String(raw), 'hex')
  if (media?.aes_key) {
    const b = Buffer.from(String(media.aes_key), 'base64')
    if (b.length === 16) return b
    if (b.toString().length === 32 && /^[0-9a-fA-F]+$/.test(b.toString())) return Buffer.from(b.toString(), 'hex')
  }
  return null
}

function mimeForName(name) {
  const ext = path.extname(name).toLowerCase()
  return ({ '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.csv': 'text/csv', '.txt': 'text/plain', '.json': 'application/json', '.zip': 'application/zip' })[ext] || 'application/octet-stream'
}
