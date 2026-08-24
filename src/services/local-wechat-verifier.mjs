import { createVerificationCode, findAssistantCode } from './profile-verifier.mjs'

/** Adapter for the existing local WeChat DSH plugin. Inject the actual tool
 * caller from the host; the service never reads WeChat keys or DB files itself. */
export class LocalWechatVerifier {
  #readChat
  #now
  constructor({ readChat, now = () => Date.now() }) {
    if (typeof readChat !== 'function') throw new TypeError('readChat is required')
    this.#readChat = readChat; this.#now = now
  }
  createTask({ ilinkUserId, ttlMs = 5 * 60_000 }) {
    const code = createVerificationCode()
    return { id: `verify-${Date.now().toString(36)}`, ilinkUserId, code, expiresAt: this.#now() + ttlMs, status: 'pending' }
  }
  async checkTask(task) {
    if (!task || task.expiresAt <= this.#now()) return { ...task, status: 'expired' }
    const result = await this.#readChat({ contact: '助手', days: 1, limit: 200 })
    const messages = result?.data?.sections?.flatMap((s) => s.messages || []) || result?.messages || result?.items || []
    const match = findAssistantCode(messages, task.code, { now: this.#now })
    return match ? { ...task, status: 'verified', profile: match } : { ...task, status: 'pending' }
  }
}
