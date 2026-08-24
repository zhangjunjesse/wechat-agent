import crypto from 'node:crypto'
import { findAssistantCode } from './profile-verifier.mjs'

/** Reads the already-synced WeChat records through the protected viewer API.
 * The access key is supplied only via environment/config injection, never Git. */
export class RemoteWechatVerifier {
  #baseUrl
  #accessKey
  #fetch
  #now
  constructor({ baseUrl, accessKey, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    if (!baseUrl || !accessKey || typeof fetchImpl !== 'function') throw new TypeError('baseUrl, accessKey and fetchImpl are required')
    this.#baseUrl = baseUrl.replace(/\/$/, '')
    this.#accessKey = accessKey
    this.#fetch = fetchImpl
    this.#now = now
  }
  createTask({ ilinkUserId, ttlMs = 5 * 60_000 }) {
    const code = `WA-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
    return { id: `verify-${Date.now().toString(36)}`, ilinkUserId, code, expiresAt: this.#now() + ttlMs, status: 'pending' }
  }
  async checkTask(task) {
    if (!task || task.expiresAt <= this.#now()) return { ...task, status: 'expired' }
    const chats = await this.#get('/wechat-api/chats')
    const chat = (chats.chats || []).find((x) => x.chat_display === '助手' || x.chat_wxid === '助手')
    if (!chat) return { ...task, status: 'assistant_not_found' }
    const messages = await this.#get(`/wechat-api/messages?chat=${encodeURIComponent(chat.chat_wxid)}&limit=500`)
    const match = findAssistantCode(messages.messages || [], task.code, { now: this.#now })
    return match ? { ...task, status: 'verified', profile: match } : { ...task, status: 'pending' }
  }
  async #get(path) {
    const separator = path.includes('?') ? '&' : '?'
    const response = await this.#fetch(`${this.#baseUrl}${path}${separator}k=${encodeURIComponent(this.#accessKey)}`)
    if (!response.ok) throw new Error(`remote wechat API failed: ${response.status}`)
    return response.json()
  }
}
