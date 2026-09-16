import fs from 'node:fs'
import path from 'node:path'
import { nextRunAt } from './schedule.mjs'
import { buildReportPrompt, parseReportJson, dedupeItems, renderReportPoster, renderPushText } from './daily-report.mjs'

/** 定时任务调度器（DESIGN-timed-tasks.md + DESIGN-daily-report.md + ADR-0018 + ADR-0026）。
 *
 * 常驻 tick（默认 30s）：扫描全部启用任务，对"已到触发点且本轮尚未执行过"
 * 的任务执行——私有任务推给 owner；公共任务推给每个订阅者。执行 = 调 agent
 * 产出内容（可自由使用工具/技能），再经 iLink sendText 推给用户微信。
 * 主动推送依赖 ContextTokenCache（入站消息时更新），没有有效 token 的用户
 * 本轮跳过并记录原因，不影响其他订阅者。
 *
 * 报告类公共任务（kind='report'）走「生成一次、处处发布」管道（#runReportTask）：
 * 一次 agent 生成结构化 JSON → 近 7 天指纹机械去重 → 入库 ReportStore →
 * **渲染海报长图**（posterRender：HTML → PNG，纯 CSS 科技风头图，ADR-0018）→
 * 向订阅者推送「海报长图 + 短描述（含公网 URL）」。
 *
 * **失败重试（ADR-0026）**：`lastRunAt` 只在"本周期已结束"（成功，或重试耗尽放弃）
 * 时才推进；一次完全失败（如 LLM 402/限流）不会让任务静默等到明天——按
 * `retryIntervalMs` 节流、在同一天内重试 `retryMax` 次，仍失败才放弃并如实
 * 告知用户"明天再试"，而不是含糊的"请稍后重试"（其实没人会重试）。
 * 根因见生产事故：8:00 报告因 402 失败，切换模型后无人推动、干等到第二天。 */
export class TaskScheduler {
  #taskStore
  #agent
  #provider
  #profileStore
  #contextTokens
  #reportStore
  #reportUrl
  #posterRender
  #now
  #tickMs
  #retryMax
  #retryIntervalMs
  #onError
  #timer = null
  #running = false

  constructor({ taskStore, agent, provider, profileStore, contextTokens, now = () => Date.now(), tickMs = 30_000, onError = null, reportStore = null, reportUrl = null, posterRender = null, retryMax = 3, retryIntervalMs = 20 * 60_000 }) {
    this.#taskStore = taskStore
    this.#agent = agent
    this.#provider = provider
    this.#profileStore = profileStore
    this.#contextTokens = contextTokens
    this.#reportStore = reportStore
    this.#reportUrl = reportUrl
    this.#posterRender = posterRender
    this.#now = now
    this.#tickMs = tickMs
    this.#retryMax = retryMax
    this.#retryIntervalMs = retryIntervalMs
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

  /** One sweep: run every task whose trigger point is due since last run
   * (or due for a throttled retry after a total failure — ADR-0026). */
  async #tick() {
    if (this.#running) return
    this.#running = true
    const now = this.#now()
    try {
      for (const task of this.#taskStore.getAllEnabled()) {
        let next
        try {
          // Next trigger measured from the anchor: the last *settled* run
          // (success, or a give-up after exhausting retries) — never a
          // still-retrying failure, or a transient blip would silently cost
          // the user the whole day (production incident, 2026-09-16: 08:00
          // report hit "402 Insufficient Balance", nothing retried it).
          const anchor = task.lastRunAt > 0 ? task.lastRunAt : task.createdAt
          next = nextRunAt(task.schedule, anchor)
        } catch { continue } // corrupt schedule: skip
        if (next > now) continue // not due yet
        // Throttle retries: mid-cycle failures wait retryIntervalMs before
        // trying again, so a persistent outage doesn't get hammered every tick.
        if (task.attemptCount > 0 && (now - task.lastAttemptAt) < this.#retryIntervalMs) continue
        const attemptNumber = task.attemptCount + 1
        const isLastAttempt = attemptNumber >= this.#retryMax + 1
        try {
          const { results, retry } = await this.#runTask(task, { attemptNumber, isLastAttempt })
          const errors = results.filter((r) => r?.error).map((r) => `${r.userId}: ${r.error}`)
          if (retry && !isLastAttempt) {
            this.#taskStore.markAttemptFailed(task.id, now, errors.join('; ')) // keep retrying this cycle
          } else {
            this.#taskStore.markRun(task.id, now, errors.join('; ')) // settle: success, or retries exhausted
          }
        } catch (error) {
          if (!isLastAttempt) {
            this.#taskStore.markAttemptFailed(task.id, now, error.message || String(error))
          } else {
            this.#taskStore.markRun(task.id, now, error.message || String(error))
          }
          this.#onError?.(error, task)
        }
      }
    } finally {
      this.#running = false
    }
  }

  /** Execute a task for every target user; returns { results, retry }.
   * `retry` = true iff execution was attempted and produced zero successes
   * (a total failure worth retrying soon) — partial success/failure settles
   * normally so already-delivered users don't get duplicate pushes. */
  async #runTask(task, attemptInfo = { attemptNumber: 1, isLastAttempt: true }) {
    // 报告类公共任务：生成一次 + 扇出投递（DESIGN-daily-report.md）
    if (task.scope === 'global' && task.kind === 'report' && this.#reportStore) {
      return this.#runReportTask(task, attemptInfo)
    }
    const targets = task.scope === 'user' ? [task.ownerUserId] : (task.subscribers || [])
    const results = []
    for (const userId of targets) {
      results.push(await this.#runForUser(task, userId))
    }
    // 只有"全员都是可重试失败"（生成本身出错，如 LLM 异常）才重试整任务；
    // 有任何成功/跳过/投递失败（会话过期这类重试也解决不了的）混在里面，
    // 就直接结算，避免给已经收到的人重复推送。
    const retry = targets.length > 0 && results.every((r) => r?.retryable)
    return { results, retry }
  }

  /** 报告类公共任务：公共版一次生成（无主题订阅者共享）+ 每个有主题用户单独生成
   * 个性化版（ADR-0019：per-user 主题，严格隔离），各自渲染海报并推送。
   * 返回 { results, retry }：`retry` = 尝试过生成但一份都没成功（如 402/限流），
   * 值得短间隔重试；只要至少一份成功就不重试（不重复打扰已收到的订阅者）。 */
  async #runReportTask(task, { attemptNumber = 1, isLastAttempt = true } = {}) {
    const now = this.#now()
    const subscribers = task.subscribers || []
    const topicsByUser = this.#taskStore.reportTopicsByTask(task.name)
    const plainUsers = subscribers.filter((u) => !topicsByUser[u]?.length)
    const results = []
    let anyAttempted = false
    let anySucceeded = false

    // ① 公共版：未设主题的订阅者共享一份（生成一次，不随人数翻倍）
    if (plainUsers.length) {
      anyAttempted = true
      const r = await this.#generateAndStore(task, null, now, [])
      if (r.ok) {
        anySucceeded = true
        for (const userId of plainUsers) results.push(await this.#fanoutReport(task, userId, r.report.posterPath, this.#pushText(r.report)))
      } else {
        const text = r.rawText || this.#failureText(task, attemptNumber, isLastAttempt)
        for (const userId of plainUsers) results.push(await this.#fanoutReport(task, userId, '', text))
        results.push({ userId: `task-${task.id}`, error: r.error }) // 公共版失败可观测
      }
    }

    // ② 个性化版：每个设了主题的订阅者单独生成（内容贴合自己主题，互不串）
    for (const userId of subscribers.filter((u) => topicsByUser[u]?.length)) {
      anyAttempted = true
      const r = await this.#generateAndStore(task, userId, now, topicsByUser[userId])
      if (r.ok) {
        anySucceeded = true
        results.push(await this.#fanoutReport(task, userId, r.report.posterPath, this.#pushText(r.report, topicsByUser[userId])))
      } else {
        const text = r.rawText || this.#failureText(task, attemptNumber, isLastAttempt)
        results.push(await this.#fanoutReport(task, userId, '', text))
        results.push({ userId: `task-${task.id}-${userId}`, error: r.error }) // 个性化失败可观测
      }
    }

    return { results, retry: anyAttempted && !anySucceeded }
  }

  /** 生成失败时推给用户的话术：还有重试机会就如实说"会自动重试"，重试耗尽就
   * 明说"今天放弃、明天再来"——不再用含糊的"请稍后重试"（其实没人会重试，
   * 用户只会干等或来问）。 */
  #failureText(task, attemptNumber, isLastAttempt) {
    if (isLastAttempt) {
      return `【定时任务「${task.name}」】已重试 ${attemptNumber} 次仍失败，今天不再重试，明天按计划再试。`
    }
    return `【定时任务「${task.name}」】本次生成失败，系统会自动重试，无需操作。`
  }

  /** 生成并入库一份报告（userId 为空 = 公共版；非空 = 该用户个性化版）。 */
  async #generateAndStore(task, userId, now, topics = []) {
    const runUserId = `task-${task.id}${userId ? `-${userId}` : ''}` // 合成用户：ephemeral 执行
    try {
      // 近 7 天已报道标题注入 prompt 要求回避（去重窗口按用户维度隔离）
      const recent = this.#reportStore.recentTitles(task.id, 7, 20, { userId: userId || '', now })
      const reply = await this.#agent.respond({
        userId: runUserId,
        text: buildReportPrompt(task, recent, { topics }),
        profile: { nickname: task.name, wxid: runUserId },
        channel: null,
        ephemeral: true,
      })
      const rawText = typeof reply?.text === 'string' ? reply.text : String(reply ?? '')
      const parsed = parseReportJson(rawText)
      if (!parsed.ok) return { ok: false, error: 'report_unparsable', rawText }
      // 机械去重（指纹比对近 7 天；删后不足 3 条保底不删）
      const deduped = dedupeItems(parsed.items, this.#reportStore.recentFingerprints(task.id, 7, { userId: userId || '', now }))
      let report = this.#reportStore.saveReport({ taskId: task.id, name: task.name, runAt: now, focus: parsed.focus, rawText, items: deduped.items, userId: userId || '' })
      // 海报长图（ADR-0018）：HTML → PNG；失败非致命，降级为纯文本短描述
      if (this.#posterRender) {
        try {
          const posterPath = await this.#posterRender(report, renderReportPoster({ ...report, topics }))
          if (posterPath) report = this.#reportStore.saveReport({ ...report, posterPath })
        } catch { /* poster 失败 → 纯文本降级 */ }
      }
      return { ok: true, report }
    } catch (error) {
      return { ok: false, error: error.message || String(error), rawText: '' }
    }
  }

  /** 推送短描述：报告名 + 公网 URL + 主题/订阅引导（ADR-0026：委托给
   * daily-report.mjs 的 renderPushText，和 resend_daily_report 工具共用同一份
   * 措辞逻辑，不再各写各的）。 */
  #pushText(report, topics = []) {
    const url = this.#reportUrl ? this.#reportUrl(report.id) : ''
    return renderPushText(report, { reportUrl: url, topics })
  }

  /** 向单个订阅者投递：海报长图（原生图片消息）+ 短描述（含公网 URL）。 */
  async #fanoutReport(task, userId, posterPath, text) {
    const profile = await this.#profileStore.get(userId)
    if (!profile?.nickname && !profile?.wxid) return { userId, skipped: 'unverified' }
    const ilinkId = profile.ilinkUserId || userId
    const cached = this.#contextTokens.get(ilinkId)
    if (!cached?.contextToken) return { userId, skipped: 'no_context_token' }
    try {
      if (posterPath && typeof this.#provider.sendImage === 'function') {
        let buffer = null
        try { buffer = fs.readFileSync(posterPath) } catch { buffer = null }
        if (buffer) {
          await this.#provider.sendImage({ providerBotId: cached.providerBotId, toProviderUserId: ilinkId, contextToken: cached.contextToken, fileName: path.basename(posterPath), buffer })
        }
      }
      await this.#provider.sendText({ providerBotId: cached.providerBotId, toProviderUserId: ilinkId, contextToken: cached.contextToken, text })
      // 引导曝光埋点（ADR-0020）：海报/短描述带主题定制引导，记录展示
      this.#taskStore.recordGuideEvent({ userId, event: 'guide_shown', entry: 'push', taskName: task.name })
      return { userId, sent: true }
    } catch (error) {
      return { userId, error: error.message || String(error) }
    }
  }

  async #runForUser(task, userId) {
    const profile = await this.#profileStore.get(userId)
    if (!profile?.nickname && !profile?.wxid) return { userId, skipped: 'unverified' }
    const ilinkId = profile.ilinkUserId || userId
    const cached = this.#contextTokens.get(ilinkId)
    if (!cached?.contextToken) return { userId, skipped: 'no_context_token' }
    let text
    try {
      const reply = await this.#agent.respond({
        userId,
        text: `【定时任务「${task.name}」】${task.instruction}`,
        profile,
        channel: null,
      })
      text = typeof reply?.text === 'string' ? reply.text : String(reply ?? '')
    } catch (error) {
      // 生成本身失败（LLM/工具异常，如生产实测的 402）：值得短间隔重试（ADR-0026）。
      return { userId, error: error.message || String(error), retryable: true }
    }
    if (!text) return { userId, sent: true } // 生成成功但无输出：不算失败，不重试
    try {
      await this.#provider.sendText({ providerBotId: cached.providerBotId, toProviderUserId: ilinkId, contextToken: cached.contextToken, text })
      return { userId, sent: true }
    } catch (error) {
      // 投递失败（如会话过期）：重试生成解决不了问题，不标 retryable。
      return { userId, error: error.message || String(error) }
    }
  }
}
