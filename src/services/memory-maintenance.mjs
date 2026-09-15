import { scoreUser, archiveLowImportance } from './memory-importance.mjs'

/** 记忆维护编排（DESIGN-memory-lifecycle.md §4.6，P5）。
 *
 * 两条路径：
 *   - **轻量（每轮、无 LLM）**：不在这里——它挂在 `MemoryManager.absorb()` 的异步链里
 *     （本轮卡片评分 + todo 过期/老化归档 + 脏标记），保证用户回复不被阻塞。
 *   - **重量（本类，有 LLM）**：评分刷新 → 低价值归档 → 聚类合并 → 抽象泛化 → 档案重建。
 *
 * 调度语义（模仿 TaskScheduler 的形态：setInterval + unref + 可手动 sweep）：
 *   tick 每 6h 检查一次；对每个"有 active 卡片"的用户判断是否到期：
 *     · 活跃用户（最近 3 天有卡片写入）：间隔 ≥ intervalMs(24h)
 *     · 不活跃用户：间隔 ≥ idleIntervalMs(7 天) —— 低频兜底，否则时间衰减永远不生效，
 *       "僵尸记忆"会永久占据召回预算（用户 2026-09-14 拍板要求）
 *     · active 卡片数 < minCards(8)：跳过（不值得为几条卡片烧 LLM 调用）
 *   同一时刻只跑一个用户（#running），避免并发打爆模型配额。
 *
 * 失败隔离：单用户任一步骤抛错只记进该用户的结果与 last_result，不中断 tick 其余部分。 */

export const IDLE_THRESHOLD_MS = Number(process.env.MEMORY_IDLE_THRESHOLD_MS || 3 * 86400000)

export class MemoryMaintenance {
  #store; #clusterer; #generalizer; #profiler; #now; #tickMs; #intervalMs; #idleIntervalMs; #minCards; #onError
  #timer = null
  #running = false

  constructor({
    store,
    clusterer,
    generalizer,
    profiler,
    now = () => Date.now(),
    tickMs = Number(process.env.MEMORY_TICK_MS || 6 * 3600 * 1000),
    intervalMs = Number(process.env.MEMORY_INTERVAL_MS || 24 * 3600 * 1000),
    idleIntervalMs = Number(process.env.MEMORY_IDLE_INTERVAL_MS || 7 * 24 * 3600 * 1000),
    minCards = Number(process.env.MEMORY_MIN_CARDS || 8),
    onError = null,
  } = {}) {
    if (!store) throw new TypeError('store is required')
    this.#store = store
    this.#clusterer = clusterer || null
    this.#generalizer = generalizer || null
    this.#profiler = profiler || null
    this.#now = now
    this.#tickMs = tickMs
    this.#intervalMs = intervalMs
    this.#idleIntervalMs = idleIntervalMs
    this.#minCards = minCards
    this.#onError = onError
  }

  get running() { return this.#running }
  get minCards() { return this.#minCards }

  start() {
    if (this.#timer) return
    this.#timer = setInterval(() => { void this.sweep() }, this.#tickMs)
    this.#timer.unref?.()
    void this.sweep()
  }

  stop() {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = null }
  }

  /** 一次扫描（start 会调用一次；测试与手动运维也可直接调）。 */
  async sweep() {
    if (this.#running) return []
    this.#running = true
    const now = this.#now()
    const results = []
    try {
      for (const userId of this.#store.listActiveUserIds()) {
        if (!this.isDue(userId, now)) continue
        try {
          results.push(await this.runUser(userId, now))
        } catch (error) {
          this.#onError?.(error, userId)
          results.push({ userId, errors: [String(error?.message || error)] })
        }
      }
    } finally {
      this.#running = false
    }
    return results
  }

  /** 该用户现在是否到期做重量维护。 */
  isDue(userId, now = this.#now()) {
    if (this.#store.countActive(userId) < this.#minCards) return false
    const state = this.#store.getMaintenance(userId)
    const idle = (now - Number(state.lastChangeAt || 0)) > IDLE_THRESHOLD_MS
    const interval = idle ? this.#idleIntervalMs : this.#intervalMs
    return (now - Number(state.lastRunAt || 0)) >= interval
  }

  /** 单个用户的完整重量维护：评分 → 归档 → 聚类 → 泛化 → 档案（步骤间失败隔离）。 */
  async runUser(userId, now = this.#now()) {
    const result = { userId, scored: 0, archived: 0, merged: 0, clusterSkipped: 0, generalized: 0, profile: null, errors: [] }

    const step = async (name, fn) => {
      try { await fn() } catch (error) { result.errors.push(`${name}: ${String(error?.message || error).slice(0, 160)}`) }
    }

    await step('score', () => {
      const scoring = archiveLowImportance(this.#store, userId, now)
      result.scored = scoring.scored
      result.archived = scoring.archived
    })
    if (this.#clusterer) {
      await step('cluster', async () => {
        const clustering = await this.#clusterer.compress(this.#store, userId, now)
        result.merged = clustering.merged
        result.clusterSkipped = clustering.skipped
      })
    }
    if (this.#generalizer) {
      await step('generalize', async () => {
        const generalization = await this.#generalizer.generalize(this.#store, userId, now)
        result.generalized = generalization.generalized
      })
    }
    if (this.#profiler) {
      await step('profile', async () => {
        const profile = await this.#profiler.generate(this.#store, userId, now)
        result.profile = profile.ok ? 'ok' : profile.reason
      })
    }

    const summary = `scored=${result.scored} archived=${result.archived} merged=${result.merged} generalized=${result.generalized} profile=${result.profile}`
      + (result.errors.length ? ` errors=${result.errors.join(' | ')}` : '')
    try { this.#store.markMaintenanceRun(userId, now, summary) } catch (e) { result.errors.push(`state: ${String(e?.message || e)}`) }
    if (result.errors.length) this.#onError?.(new Error(summary), userId)
    return result
  }
}
