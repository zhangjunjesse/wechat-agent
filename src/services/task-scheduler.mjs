import fs from 'node:fs'
import path from 'node:path'
import { nextRunAt } from './schedule.mjs'
import { buildReportPrompt, parseReportJson, dedupeItems, renderWeChatDigest } from './daily-report.mjs'
import { resolveUserPath } from './user-sandbox.mjs'

/** 定时任务调度器（DESIGN-timed-tasks.md + DESIGN-daily-report.md）。
 *
 * 常驻 tick（默认 30s）：扫描全部启用任务，对"已到触发点且本轮尚未执行过"
 * 的任务执行——私有任务推给 owner；公共任务推给每个订阅者。执行 = 调 agent
 * 产出内容（可自由使用工具/记忆/技能），再经 iLink sendText 推给用户微信。
 * 主动推送依赖 ContextTokenCache（入站消息时更新），没有有效 token 的用户
 * 本轮跳过并记录原因，不影响其他订阅者。
 *
 * 报告类公共任务（kind='report'）走「生成一次、处处发布」管道（#runReportTask）：
 * 一次 agent 生成结构化 JSON（封面图由 agent 用 image-studio 技能产出，路径放进
 * JSON 的 cover 字段）→ 近 7 天指纹机械去重 → 入库 ReportStore →
 * 渲染微信摘要（含公网 URL）+ 封面 → 向所有订阅者扇出同一份内容。 */
export class TaskScheduler {
  #taskStore
  #agent
  #provider
  #profileStore
  #contextTokens
  #reportStore
  #reportUrl
  #reportRoot
  #now
  #tickMs
  #onError
  #timer = null
  #running = false

  constructor({ taskStore, agent, provider, profileStore, contextTokens, now = () => Date.now(), tickMs = 30_000, onError = null, reportStore = null, reportUrl = null, reportRoot = process.env.USER_FILES_ROOT || 'data/user-files' }) {
    this.#taskStore = taskStore
    this.#agent = agent
    this.#provider = provider
    this.#profileStore = profileStore
    this.#contextTokens = contextTokens
    this.#reportStore = reportStore
    this.#reportUrl = reportUrl
    this.#reportRoot = reportRoot
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

  /** 报告类公共任务：一次 agent 生成 → 去重 → 入库 → 渲染 → 扇出。 */
  async #runReportTask(task) {
    const now = this.#now()
    const runUserId = `task-${task.id}` // 合成用户：ephemeral 执行 + 技能产物落盘目录（Windows 安全字符）
    let rawText = ''
    let report = null
    let fallback = ''
    try {
      // 近 7 天已报道标题注入 prompt 要求回避
      const recent = this.#reportStore.recentTitles(task.id, 7, 20)
      const reply = await this.#agent.respond({
        userId: runUserId,
        text: buildReportPrompt(task, recent, { cover: task.cover }),
        profile: { nickname: task.name, wxid: runUserId },
        channel: null,
        ephemeral: true,
      })
      rawText = typeof reply?.text === 'string' ? reply.text : String(reply ?? '')
      const parsed = parseReportJson(rawText)
      if (parsed.ok) {
        // 机械去重（指纹比对近 7 天；删后不足 3 条保底不删）
        const deduped = dedupeItems(parsed.items, this.#reportStore.recentFingerprints(task.id, 7))
        // 封面：agent 用 image-studio 技能生成后把相对路径放 JSON.cover，这里
        // 解析成沙箱绝对路径并确认文件存在；缺失/越界 → 纯文字降级（非致命）。
        let coverPath = ''
        if (task.cover && parsed.cover) {
          try {
            const full = resolveUserPath(this.#reportRoot, runUserId, parsed.cover)
            if (fs.existsSync(full)) coverPath = full
          } catch { coverPath = '' }
        }
        report = this.#reportStore.saveReport({ taskId: task.id, name: task.name, runAt: now, focus: parsed.focus, rawText, coverPath, items: deduped.items })
      } else {
        fallback = 'report_unparsable'
      }
    } catch (error) {
      return [{ userId: runUserId, error: error.message || String(error) }]
    }
    const digest = report
      ? renderWeChatDigest({ report, reportUrl: this.#reportUrl ? this.#reportUrl(report.id) : '' })
      : (rawText || `【定时任务「${task.name}」】生成失败，请稍后重试。`)
    const results = []
    for (const userId of task.subscribers || []) {
      results.push(await this.#fanoutReport(task, userId, digest, report?.coverPath || ''))
    }
    // 解析失败也要可观测：lastError 记 report_unparsable（#tick 聚合 error 字段）
    if (fallback) results.push({ userId: `task:${task.id}`, error: fallback })
    return results
  }

  /** 向单个订阅者投递已生成好的报告摘要（+ 可选封面图）。 */
  async #fanoutReport(task, userId, digest, coverPath) {
    const profile = await this.#profileStore.get(userId)
    if (!profile?.nickname && !profile?.wxid) return { userId, skipped: 'unverified' }
    const ilinkId = profile.ilinkUserId || userId
    const cached = this.#contextTokens.get(ilinkId)
    if (!cached?.contextToken) return { userId, skipped: 'no_context_token' }
    try {
      const greeting = `早上好，${profile.nickname || profile.wxid}`
      const text = `${greeting}，今日早报已送达 👇\n${digest}`
      if (coverPath && typeof this.#provider.sendImage === 'function') {
        let buffer = null
        try { buffer = fs.readFileSync(coverPath) } catch { buffer = null }
        if (buffer) {
          await this.#provider.sendImage({ providerBotId: cached.providerBotId, toProviderUserId: ilinkId, contextToken: cached.contextToken, fileName: path.basename(coverPath), buffer })
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
