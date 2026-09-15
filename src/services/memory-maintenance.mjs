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
/** 档案漂移阈值：active 卡片数与档案来源数之差达到它就提前重建档案（DESIGN §4.5）。 */
export const PROFILE_DRIFT_THRESHOLD = Number(process.env.MEMORY_PROFILE_DRIFT || 8)
/** 漂移触发的冷却时间，避免连续对话时反复触发完整维护。 */
export const PROFILE_DRIFT_COOLDOWN_MS = Number(process.env.MEMORY_PROFILE_DRIFT_COOLDOWN_MS || 3600 * 1000)
/** 维护日志里每条明细的内容截断长度（保证 last_result 可读且不膨胀）。 */
const LOG_CLIP = 80

export class MemoryMaintenance {
  #store; #clusterer; #generalizer; #profiler; #now; #tickMs; #intervalMs; #idleIntervalMs; #minCards; #onError
  #profileDriftThreshold; #profileDriftCooldownMs
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
    profileDriftThreshold = PROFILE_DRIFT_THRESHOLD,
    profileDriftCooldownMs = PROFILE_DRIFT_COOLDOWN_MS,
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
    this.#profileDriftThreshold = profileDriftThreshold
    this.#profileDriftCooldownMs = profileDriftCooldownMs
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

  /** 档案漂移：当前 active 卡片数与档案生成时来源数之差（口径与 profiler 一致：
   *  排除助手命名卡，因为它不进档案）。没有档案时返回 0——首次生成由时间判定负责。 */
  profileDrift(userId) {
    const profile = this.#store.getProfile(userId)
    if (!profile) return 0
    const current = this.#store.listActive(userId)
      .filter((c) => !(c.category === 'identity' && c.subject === '助手')).length
    return Math.abs(current - Number(profile.sourceCount || 0))
  }

  /** 该用户现在是否到期做重量维护。
   *
   * 两条触发路径：
   *   ① **档案漂移**（DESIGN §4.5）：卡片变化 ≥ profileDriftThreshold 条 → 提前重建档案
   *      （带冷却，避免连续对话时反复触发完整维护）；
   *   ② **时间**：活跃用户 ≥24h、不活跃用户 ≥7 天（低频兜底，让时间衰减持续生效）。
   * 两者都以 active 卡片数 ≥ minCards 为前提。 */
  isDue(userId, now = this.#now()) {
    if (this.#store.countActive(userId) < this.#minCards) return false
    const state = this.#store.getMaintenance(userId)
    const sinceRun = now - Number(state.lastRunAt || 0)
    if (this.profileDrift(userId) >= this.#profileDriftThreshold) {
      return sinceRun >= this.#profileDriftCooldownMs
    }
    const idle = (now - Number(state.lastChangeAt || 0)) > IDLE_THRESHOLD_MS
    const interval = idle ? this.#idleIntervalMs : this.#intervalMs
    return sinceRun >= interval
  }

  /** 单个用户的完整重量维护：评分 → 归档 → 聚类 → 泛化 → 档案（步骤间失败隔离）。
   *
   * **快照语义**（DESIGN §4.6 / 验收 13）：进入时冻结当时的 active id 集合；各步骤以自身
   * 开头的 listActive 为输入，写操作（archive/mergeInto）也只对库里仍为 active 的卡片生效，
   * 因此维护期间由 absorb 写入的新卡片**不参与本轮**、也不会被误归档——它留给下一轮。 */
  async runUser(userId, now = this.#now()) {
    const snapshot = this.#store.listActive(userId)
    const result = {
      userId,
      snapshotSize: snapshot.length,
      drift: this.profileDrift(userId),
      scored: 0, archived: 0, merged: 0, clusterSkipped: 0, generalized: 0, profile: null,
      details: { archived: [], merged: [], generalized: [], skipped: [] },
      errors: [],
    }

    const step = async (name, fn) => {
      try { await fn() } catch (error) { result.errors.push(`${name}: ${String(error?.message || error).slice(0, 160)}`) }
    }

    await step('score', () => {
      const scoring = archiveLowImportance(this.#store, userId, now)
      result.scored = scoring.scored
      result.archived = scoring.archived
      result.details.archived = (scoring.candidates || []).map((c) => ({ id: c.id, importance: c.importance, content: clip(c.content) }))
    })
    // ⚠️ 泛化必须在聚类**之前**（2026-09-15 真实验证发现）：两层吃的是同一批原料——同
    // (category, subject) 的相似事件。若先聚类，3 条同类 episodic 会被合并成 1 条，
    // 泛化再也凑不齐「≥3 条样本」门槛，第三层被第二层**饿死**（实测 generalized=[]）。
    // 先泛化（提炼规律，来源卡保留或归档）再聚类（合并冗余细节），两层各司其职。
    if (this.#generalizer) {
      await step('generalize', async () => {
        const generalization = await this.#generalizer.generalize(this.#store, userId, now)
        result.generalized = generalization.generalized
        for (const detail of generalization.details || []) {
          if (detail.ok) result.details.generalized.push({ kind: detail.kind, content: clip(detail.content), sources: detail.sourceIds?.length || 0, archivedSources: detail.archivedSources || 0 })
          else result.details.skipped.push({ stage: 'generalize', reason: detail.reason, content: clip(detail.content || '') })
        }
      })
    }
    if (this.#clusterer) {
      await step('cluster', async () => {
        const clustering = await this.#clusterer.compress(this.#store, userId, now)
        result.merged = clustering.merged
        result.clusterSkipped = clustering.skipped
        for (const detail of clustering.details || []) {
          if (detail.ok) result.details.merged.push({ ids: detail.ids, content: clip(detail.content) })
          else result.details.skipped.push({ stage: 'cluster', reason: detail.reason, content: clip(detail.content || '') })
        }
      })
    }
    if (this.#profiler) {
      await step('profile', async () => {
        const profile = await this.#profiler.generate(this.#store, userId, now)
        result.profile = profile.ok ? 'ok' : profile.reason
      })
    }

    // A3：维护日志记「做了什么」而不只是计数——出问题能从 last_result 回溯。
    const summary = `scored=${result.scored} archived=${result.archived} merged=${result.merged} generalized=${result.generalized} profile=${result.profile}`
    const log = {
      summary,
      at: now,
      drift: result.drift,
      snapshotSize: result.snapshotSize,
      archived: result.details.archived.slice(0, 3),
      merged: result.details.merged.slice(0, 3),
      generalized: result.details.generalized.slice(0, 3),
      skipped: result.details.skipped.slice(0, 3),
      errors: result.errors,
    }
    try { this.#store.markMaintenanceRun(userId, now, JSON.stringify(log)) } catch (e) { result.errors.push(`state: ${String(e?.message || e)}`) }
    if (result.errors.length) this.#onError?.(new Error(`${summary} errors=${result.errors.join(' | ')}`), userId)
    return result
  }
}

function clip(text) {
  const value = String(text || '')
  return value.length <= LOG_CLIP ? value : `${value.slice(0, LOG_CLIP)}…`
}
