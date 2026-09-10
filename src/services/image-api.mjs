import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 图片生成/编辑 API 的 Node 封装（图像工坊技能的底层通道）。
 *
 * 三个原子能力（协议来自已验证的 gpt-image-2 图片能力，异步任务模式）：
 *   - uploadImage   : POST /v1/uploads/images      (multipart) → 公网 URL
 *   - createTask    : POST /v1/images/generations   → 异步任务 id
 *   - waitForTask   : GET  /v1/images/generations/{id} 轮询 → 结果图片 URL 列表
 *   - downloadImage : 把结果 URL 下载到本地文件（带鉴权 + UA）
 *
 * 三种模式由 createTask 的不同字段触发：
 *   generate：reference_images（风格参考，重新生成版式）
 *   edit    ：image_urls（保留原图主体，按 prompt 修改）
 *   inpaint ：image_urls + mask_url（仅改 mask 透明区域）
 *
 * key 来源：TOAPIS_API_KEY 环境变量 > ~/.toapis_key。 */

export const IMAGE_API_BASE_URL = process.env.TOAPIS_BASE_URL || 'https://toapis.com'
export const IMAGE_MODEL = 'gpt-image-2'

export const IMAGE_SIZES = ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '2:1', '1:2', '21:9', '9:21']
export const IMAGE_RESOLUTIONS = ['1k', '2k', '4k']
export const IMAGE_MODES = ['generate', 'edit', 'inpaint']
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // API 限制：单张 ≤ 10MB

function keyFilePath() {
  return path.join(os.homedir(), '.toapis_key')
}

/** Resolve the image API key: env first, then ~/.toapis_key. */
export function getImageApiKey({ env = process.env, keyFile = keyFilePath() } = {}) {
  if (env.TOAPIS_API_KEY) return env.TOAPIS_API_KEY
  try {
    const value = fs.readFileSync(keyFile, 'utf8').trim()
    return value || null
  } catch {
    return null
  }
}

function authHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}` }
}

/** Upload a local image (buffer) and return its public URL. */
export async function uploadImage({ buffer, fileName, apiKey, fetchImpl = globalThis.fetch, baseUrl = IMAGE_API_BASE_URL }) {
  if (!Buffer.isBuffer(buffer)) throw new Error('buffer 必须是 Buffer')
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error(`图片超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 上传上限`)
  if (!apiKey) throw new Error('未配置图片服务 API Key')
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: 'application/octet-stream' }), fileName || 'image.png')
  form.append('purpose', 'generation')
  const resp = await fetchImpl(`${baseUrl}/v1/uploads/images`, { method: 'POST', headers: authHeaders(apiKey), body: form })
  const body = await resp.json().catch(() => ({}))
  if (!resp.ok || body.success !== true) throw new Error(`上传失败: ${body.message || `HTTP ${resp.status}`}`)
  const url = body.data?.url
  if (!url) throw new Error(`上传响应缺少 url: ${JSON.stringify(body).slice(0, 200)}`)
  return url
}

/** Create a generation/edit/inpaint task; returns the task id. */
export async function createImageTask({ mode = 'generate', prompt, size = '1:1', resolution = '1k', n = 1, refs = [], maskUrl = null, apiKey, fetchImpl = globalThis.fetch, baseUrl = IMAGE_API_BASE_URL, model = IMAGE_MODEL }) {
  if (!IMAGE_MODES.includes(mode)) throw new Error(`未知模式: ${mode}（可选 ${IMAGE_MODES.join('/')}）`)
  if (!prompt) throw new Error('缺少 prompt')
  if (!apiKey) throw new Error('未配置图片服务 API Key')
  const payload = { model, prompt, size, resolution, n, response_format: 'url' }
  if (mode === 'generate') {
    if (refs.length) payload.reference_images = refs
  } else {
    if (!refs.length) throw new Error(`${mode} 模式至少需要一张参考图`)
    payload.image_urls = refs
    if (mode === 'inpaint') {
      if (!maskUrl) throw new Error('inpaint 模式必须提供 mask 图（透明区域为待重绘区）')
      payload.mask_url = maskUrl
    }
  }
  const resp = await fetchImpl(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(`创建任务失败: ${body.message || `HTTP ${resp.status}`}`)
  const taskId = body.id || body.task_id
  if (!taskId) throw new Error(`创建任务响应缺少 id: ${JSON.stringify(body).slice(0, 200)}`)
  return taskId
}

async function fetchTask({ taskId, apiKey, fetchImpl, baseUrl }) {
  const resp = await fetchImpl(`${baseUrl}/v1/images/generations/${encodeURIComponent(taskId)}`, { headers: authHeaders(apiKey) })
  const body = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(`查询任务失败: ${body.message || `HTTP ${resp.status}`}`)
  return body
}

function collectUrls(obj, acc = []) {
  if (Array.isArray(obj)) {
    for (const item of obj) collectUrls(item, acc)
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'url' && typeof v === 'string' && v.startsWith('http')) acc.push(v)
      else collectUrls(v, acc)
    }
  }
  return acc
}

/** Poll a task until completed (returns unique result image URLs) or failed/timeout. */
export async function waitForImageTask({ taskId, apiKey, fetchImpl = globalThis.fetch, baseUrl = IMAGE_API_BASE_URL, pollIntervalMs = 3000, timeoutMs = 600_000 } = {}) {
  const started = Date.now()
  for (;;) {
    const result = await fetchTask({ taskId, apiKey, fetchImpl, baseUrl })
    const status = result.status
    if (status === 'completed') {
      const urls = [...new Set(collectUrls(result.result).concat(collectUrls(result)))]
      if (!urls.length) throw new Error(`任务完成但未找到图片 URL: ${JSON.stringify(result).slice(0, 200)}`)
      return urls
    }
    if (status === 'failed') {
      const err = result.error || {}
      throw new Error(`图片生成失败: ${(typeof err === 'object' ? err.message : err) || result.fail_reason || JSON.stringify(result).slice(0, 200)}`)
    }
    if (Date.now() - started > timeoutMs) throw new Error(`图片任务超时（>${Math.round(timeoutMs / 1000)}s），task_id=${taskId}`)
    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }
}

/** Download a result image to a local file (the file host requires auth + UA). */
export async function downloadImage({ url, destPath, apiKey, fetchImpl = globalThis.fetch }) {
  const resp = await fetchImpl(url, { headers: { ...authHeaders(apiKey), 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } })
  if (!resp.ok) throw new Error(`下载图片失败: HTTP ${resp.status}`)
  const buf = Buffer.from(await resp.arrayBuffer())
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true })
  await fs.promises.writeFile(destPath, buf)
  return destPath
}

/** Pick a file extension from a URL (default .png). */
export function extFromUrl(url) {
  const p = String(url).split('?')[0].toLowerCase()
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    if (p.endsWith(ext)) return ext
  }
  return '.png'
}
