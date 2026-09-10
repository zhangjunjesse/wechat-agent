import { nextRunAt } from './schedule.mjs'

/** 定时任务调度器（DESIGN-timed-tasks.md）。
 *
 * 常驻 tick（默认 30s）：扫描全部启用任务，对"已到触发点且本轮尚未执行过"
 * 的任务执行——私有任务推给 owner；公共任务推给每个订阅者。执行 = 调 agent
 * 产出内容（可自由使用工具/记忆/技能），再经 iLink sendText 推给用户微信。
 * 主动推送依赖 ContextTokenCache（入站消息时更新），没有有效 token 的用户
 * 本轮跳过并记录原因，不影响其他订阅者。 */
export class TaskScheduler {
  #taskStore
  #agent
  #provider
  #profileStore
  #contextTokens
  #now
  #tickMs
  #onError
  #timer = null
  #running = false

  constructor({ taskStore, agent, provider, profileStore, contextTokens, now = () => Date.now(), tickMs = 30_000, onError = null }) {
    this.#taskStore = taskStore
    this.#agent = agent
    this.#provider = provider
    this.#profileStore = profileStore
    this.#contextTokens = contextTokens
    this.#now = now
    this.#tickMs = tickMs
    this.#onError = onError
  }

  start() {
    if (this.#timer) return
    this.#timer = setInterval(() => { void this.#tick() }, this.#tickMs)
    this.#timer.unref?.()
    void this.#tick()
  }

  stop() {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = null }
  }

  /** Run one sweep now (used by start() and by tests/manual ops). */
  sweep() {
    return this.#tick()
  }

  /** One sweep: run every task whose trigger point is due since last run. */
  async #tick() {
    if (this.#running) return
    this.#running = true
    const now = this.#now()
    try {
      for (const task of this.#taskStore.getAllEnabled()) {
        let next
        try {
          // Next trigger measured from the anchor: the last run (if any) or
          // the task's creation time — a freshly created task never backfills
          // cycles that predate it.
          const anchor = task.lastRunAt > 0 ? task.lastRunAt : task.createdAt
          next = nextRunAt(task.schedule, anchor)
        } catch { continue } // corrupt schedule: skip
        // Due iff the next trigger after the anchor has already arrived.
        if (next <= now) {
          try {
            const results = await this.#runTask(task)
            const errors = results.filter((r) => r?.error).map((r) => `${r.userId}: ${r.error}`)
            this.#taskStore.markRun(task.id, now, errors.join('; '))
          } catch (error) {
            this.#taskStore.markRun(task.id, now, error.message || String(error))
            this.#onError?.(error, task)
          }
        }
      }
    } finally {
      this.#running = false
    }
  }

  /** Execute a task for every target user; returns per-user results. */
  async #runTask(task) {
    const targets = task.scope === 'user' ? [task.ownerUserId] : (task.subscribers || [])
    const results = []
    for (const userId of targets) {
      results.push(await this.#runForUser(task, userId))
    }
    return results
  }

  async #runForUser(task, userId) {
    const profile = await this.#profileStore.get(userId)
    if (!profile?.nickname && !profile?.wxid) return { userId, skipped: 'unverified' }
    const ilinkId = profile.ilinkUserId || userId
    const cached = this.#contextTokens.get(ilinkId)
    if (!cached?.contextToken) return { userId, skipped: 'no_context_token' }
    try {
      const reply = await this.#agent.respond({
        userId,
        text: `【定时任务「${task.name}」】${task.instruction}`,
        profile,
        channel: null,
      })
      const text = typeof reply?.text === 'string' ? reply.text : String(reply ?? '')
      if (text) {
        await this.#provider.sendText({ providerBotId: cached.providerBotId, toProviderUserId: ilinkId, contextToken: cached.contextToken, text })
      }
      return { userId, sent: true }
    } catch (error) {
      return { userId, error: error.message || String(error) }
    }
  }
}
