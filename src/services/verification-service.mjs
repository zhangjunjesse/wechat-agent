export class VerificationService {
  #verifier
  #tasks = new Map()
  #profiles = new Map()
  #store
  #onVerified
  constructor({ verifier, store = null, onVerified = null }) { if (!verifier) throw new TypeError('verifier is required'); this.#verifier = verifier; this.#store = store; this.#onVerified = onVerified }
  create({ userId, ilinkUserId }) {
    const task = this.#verifier.createTask({ ilinkUserId })
    const record = { ...task, userId, attempts: 0 }
    this.#tasks.set(record.id, record)
    return publicTask(record)
  }
  async check({ userId, id }) {
    const task = this.#tasks.get(id)
    if (!task || task.userId !== userId) throw new Error('verification not found')
    if (task.status === 'verified') return publicTask(task)
    task.attempts++
    const result = await this.#verifier.checkTask(task)
    this.#tasks.set(id, result)
    if (result.status === 'verified') {
      // Persist the stable iLink identity so memory/sessions follow the WeChat
      // user across browser sessions (which get a fresh random userId each time).
      const profile = { ...result.profile, ilinkUserId: task.ilinkUserId || '' }
      this.#profiles.set(userId, profile)
      await this.#store?.put(userId, profile)
      await this.#onVerified?.({ userId, task, profile })
    }
    return publicTask(result)
  }
  profile(userId) { return this.#profiles.get(userId) || null }
}
function publicTask(task) {
  const { code, ...safe } = task
  return { ...safe, instruction: '请添加微信联系人“助手”，并向助手发送页面中的验证码。验证码只用于一次验证。', code }
}
