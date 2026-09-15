import fs from 'node:fs'
import path from 'node:path'
import { nextRunAt } from './schedule.mjs'
import { buildReportPrompt, parseReportJson, dedupeItems, renderReportPoster } from './daily-report.mjs'

/** 定时任务调度器（DESIGN-timed-tasks.md + DESIGN-daily-report.md + ADR-0018）。
 *
 * 常驻 tick（默认 30s）：扫描全部启用任务，对"已到触发点且本轮尚未执行过"
 * 的任务执行——私有任务推给 owner；公共任务推给每个订阅者。执行 = 调 agent
 * 产出内容（可自由使用工具/记忆/技能），再经 iLink sendText 推给用户微信。
 * 主动推送依赖 ContextTokenCache（入站消息时更新），没有有效 token 的用户
 * 本轮跳过并记录原因，不影响其他订阅者。
 *
 * 报告类公共任务（kind='report'）走「生成一次、处处发布」管道（#runReportTask）：
 * 一次 agent 生成结构化 JSON → 近 7 天指纹机械去重 → 入库 ReportStore →
 * **渲染海报长图**（posterRender：HTML → PNG，纯 CSS 科技风头图，ADR-0018）→
 * 向订阅者推送「海报长图 + 短描述（含公网 URL）」。 */
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
  #onError
  #timer = null
  #running = false

  constructor({ taskStore, agent, provider, profileStore, contextTokens, now = () => Date.now(), tickMs = 30_000, onError = null, reportStore = null, reportUrl = null, posterRender = null }) {
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
    // 报告类公共任务：生成一次 + 扇出投递（DESIGN-daily-report.md）
    if (task.scope === 'global' && task.kind === 'report' && this.#reportStore) {
      return this.#runReportTask(task)
    }
    const targets = task.scope === 'user' ? [task.ownerUserId] : (task.subscribers || [])
    const results = []
    for (const userId of targets) {
      results.push(await this.#runForUser(task, userId))
    }
    return results
  }

  /** 报告类公共任务：公共版一次生成（无主题订阅者共享）+ 每个有主题用户单独生成
   * 个性化版（ADR-0019：per-user 主题，严格隔离），各自渲染海报并推送。 */
  async #runReportTask(task) {
    const now = this.#now()
    const subscribers = task.subscribers || []
    const topicsByUser = this.#taskStore.reportTopicsByTask(task.name)
    const plainUsers = subscribers.filter((u) => !topicsByUser[u]?.length)
    const results = []
    let fallback = ''

    // ① 公共版：未设主题的订阅者共享一份（生成一次，不随人数翻倍）
    if (plainUsers.length) {
      const r = await this.#generateAndStore(task, null, now, [])
      if (r.ok) {
        for (const userId of plainUsers) results.push(await this.#fanoutReport(task, userId, r.report.posterPath, this.#pushText(r.report)))
      } else {
        fallback = r.error
        const text = r.rawText || `【定时任务「${task.name}」】生成失败，请稍后重试。`
        for (const userId of plainUsers) results.push(await this.#fanoutReport(task, userId, '', text))
      }
    }

    // ② 个性化版：每个设了主题的订阅者单独生成（内容贴合自己主题，互不串）
    for (const userId of subscribers.filter((u) => topicsByUser[u]?.length)) {
      const r = await this.#generateAndStore(task, userId, now, topicsByUser[userId])
      if (r.ok) {
        results.push(await this.#fanoutReport(task, userId, r.report.posterPath, this.#pushText(r.report, topicsByUser[userId])))
      } else {
        const text = r.rawText || `【定时任务「${task.name}」】生成失败，请稍后重试。`
        results.push(await this.#fanoutReport(task, userId, '', text))
        results.push({ userId: `task-${task.id}-${userId}`, error: r.error }) // 个性化失败可观测
      }
    }

    if (fallback) results.push({ userId: `task-${task.id}`, error: fallback }) // 公共版失败可观测
    return results
  }

  /** 生成并入库一份报告（userId 为空 = 公共版；非空 = 该用户个性化版）。 */
  async #generateAndStore(task, userId, now, topics = []) {
    const runUserId = `task-${task.id}${userId ? `-${userId}` : ''}` // 合成用户：ephemeral 执行
    try {
      // 近 7 天已报道标题注入 prompt 要求回避（去重窗口按用户维度隔离）
      const recent = this.#reportStore.recentTitles(task.id, 7, 20, { userId: userId || '' })
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
      const deduped = dedupeItems(parsed.items, this.#reportStore.recentFingerprints(task.id, 7, { userId: userId || '' }))
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

  /** 推送短描述：报告名 + 公网 URL + 主题/订阅引导。 */
  #pushText(report, topics = []) {
    const url = this.#reportUrl ? this.#reportUrl(report.id) : ''
    const topicLine = topics.length ? `当前主题：${topics.join('、')} · ` : ''
    return `📰 ${report.name} 已送达\n想了解每条详情或回看历史，请访问：\n${url}\n${topicLine}想定制感兴趣的主题？回复「订阅 AI 主题」即可\n也可以回复我「第N条展开讲讲」，我帮你细说。`
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
