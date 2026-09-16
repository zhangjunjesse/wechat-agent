import path from 'node:path'

/** 视觉模型客户端（ADR-0030）：把图片字节转 base64 data URI，向
 * `${OPENAI_BASE_URL}/chat/completions` 发一次标准 OpenAI vision 请求
 * （text + image_url content block），取 `choices[0].message.content` 返回。
 *
 * 为什么刻意独立、不接 deepseek-thinking-client / agents-sdk-agent 主链路：
 * 那条链路是为主 agent 多轮工具调用 + DeepSeek reasoning_content 强制回传
 * 设计的，历史上因它出过三次生产 400 事故（见 STATUS.md / git log 的
 * reasoning 修复记录）；视觉调用是单轮、无工具的普通问答（生产网关实测
 * `reasoning_tokens: 0`），没有任何理由沾那套复杂度。
 *
 * 保持简单（对齐 SubagentRunner 的 timeoutMs 模式）：无 session、无
 * serial-queue、不重试；60 秒超时防止单次调用卡死一次工具执行。 */

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_PROMPT = '请用中文描述这张图片的内容：主体、场景、图中的文字（如有请照原文抄录）、值得注意的细节。'
const EXT_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.heic': 'image/heic', '.heif': 'image/heif',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.avif': 'image/avif', '.ico': 'image/x-icon',
}

/** 按文件扩展名给出图片 MIME（data URI 用），未知扩展名兜底 image/png。 */
export function mimeForImage(fileName) {
  return EXT_MIME[path.extname(String(fileName || '')).toLowerCase()] || 'image/png'
}

export class VisionClient {
  #baseUrl
  #apiKey
  #model
  #timeoutMs
  #fetch

  constructor({ baseUrl, apiKey, model, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch }) {
    if (!baseUrl || !apiKey || !model) throw new TypeError('baseUrl/apiKey/model are required')
    this.#baseUrl = String(baseUrl).replace(/\/$/, '')
    this.#apiKey = apiKey
    this.#model = model
    this.#timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS
    this.#fetch = fetchImpl
  }

  get model() { return this.#model }

  /** 一次性看图问答。buffer 是图片字节；question 不传用通用描述 prompt。
   * 失败时抛错（信息如实带 HTTP 状态/网关返回摘要），由调用方转成用户可读文案。 */
  async describeImage({ buffer, mimeType = 'image/png', question = '' }) {
    const dataUri = `data:${mimeType};base64,${Buffer.from(buffer).toString('base64')}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const res = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
        body: JSON.stringify({
          model: this.#model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: String(question || '').trim() || DEFAULT_PROMPT },
              { type: 'image_url', image_url: { url: dataUri } },
            ],
          }],
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`视觉模型请求失败：HTTP ${res.status}${body ? ` ${body.slice(0, 200)}` : ''}`)
      }
      const data = await res.json()
      const text = data?.choices?.[0]?.message?.content
      if (typeof text !== 'string' || !text.trim()) throw new Error('视觉模型返回了空内容')
      return text.trim()
    } catch (e) {
      if (e?.name === 'AbortError') throw new Error(`视觉模型请求超时（${Math.round(this.#timeoutMs / 1000)} 秒），请稍后再试`)
      throw e
    } finally {
      clearTimeout(timer)
    }
  }
}
