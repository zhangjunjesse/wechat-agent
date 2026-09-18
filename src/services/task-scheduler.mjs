import fs from 'node:fs'
import path from 'node:path'
import { nextRunAt } from './schedule.mjs'
import { buildReportPrompt, parseReportJson, dedupeItems, renderReportPoster, renderPushText } from './daily-report.mjs'
import { digestWindowDays, renderDigestPushText, renderQuietText } from './wechat-digest.mjs'
import { isRetryableError, looksLikeRawJsonPayload, logServerError } from './failure-messaging.mjs'

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
 * **个性化主题（ADR-0019）按主题独立成篇（ADR-0027）**：未设主题的订阅者共享
 * 一份公共版；设了 N 个主题的用户，当天收到 **N 份独立的**海报+推送——每个
 * 主题各自生成、各自去重、各自海报，不合并成一份让模型自己权衡分配（那样会
 * 出现"订阅了却看不出区别"甚至"某主题当天被挤到 0 条而不自知"）。
 *
 * **失败重试（ADR-0026）**：`lastRunAt` 只在"本周期已结束"（成功，或重试耗尽放弃）
 * 时才推进；一次完全失败（如 LLM 402/限流）不会让任务静默等到明天——按
 * `retryIntervalMs` 节流、在同一天内重试 `retryMax` 次，仍失败才放弃并如实
 * 告知用户"明天再试"，而不是含糊的"请稍后重试"（其实没人会重试）。
 * 根因见生产事故：8:00 报告因 402 失败，切换模型后无人推动、干等到第二天。
 *
 * **报告任务重试按生成单元独立跟踪（ADR-0028）**：ADR-0027 之后一个报告任务
 * 一轮 = 多个独立生成单元（公共版 + 每个 (用户,主题)），"部分成功部分失败"
 * 是常态；重试判定从任务级全有全无下沉到单元级（`tasks.retry_units` 跨 tick
 * 持久化），重试轮只补跑失败单元，已成功的用户不被重复推送。 */
export class TaskScheduler {
  #taskStore
  #agent
  #provider
  #profileStore
  #contextTokens
  #reportStore
  #reportUrl
  #posterRender
  #digestRunner
  #digestQuietPush
  #now
  #tickMs
  #retryMax
  #retryIntervalMs
  #onError
  #timer = null
  #running = false

  constructor({ taskStore, agent, provider, profileStore, contextTokens, now = () => Date.now(), tickMs = 30_000, onError = null, reportStore = null, reportUrl = null, posterRender = null, retryMax = 3, retryIntervalMs = 20 * 60_000, digestRunner = null, digestQuietPush = true }) {
    this.#taskStore = taskStore
    this.#agent = agent
    this.#provider = provider
    this.#profileStore = profileStore
    this.#contextTokens = contextTokens
    this.#reportStore = reportStore
    this.#reportUrl = reportUrl
    this.#posterRender = posterRender
    this.#digestRunner = digestRunner
    this.#digestQuietPush = digestQuietPush
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
   * 非报告任务：`retry` = true iff execution was attempted and produced zero
   * successes (a total failure worth retrying soon) — partial success/failure
   * settles normally so already-delivered users don't get duplicate pushes.
   * 报告任务：重试判定下沉到生成单元级（ADR-0028，见 #runReportTask）——
   * `retry` = 还有单元在等重试，重试轮只补跑失败单元，不会重复打扰已成功者。 */
  async #runTask(task, attemptInfo = { attemptNumber: 1, isLastAttempt: true }) {
    // 报告类公共任务：生成一次 + 扇出投递（DESIGN-daily-report.md）；
    // 单元级重试状态自持久化（tasks.retry_units），不需要任务级 attemptInfo。
    if (task.scope === 'global' && task.kind === 'report' && this.#reportStore) {
      return this.#runReportTask(task)
    }
    // 微信日报/周报（DESIGN-wechat-digest.md）：per-user 生成，不是一次生成全员扇出。
    // 未配置 digestRunner（无 WECHAT_LOG_DB / 本地开发）时整条分支不存在，任务
    // 落到下面的 plain 路径也只会推一条没内容的文本——所以这里直接判为跳过。
    if (task.scope === 'global' && task.kind === 'wechat-digest') {
      if (!this.#digestRunner || !this.#reportStore) {
        return { results: [{ userId: `task-${task.id}`, skipped: 'digest_not_configured' }], retry: false }
      }
      return this.#runDigestTask(task)
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

  /** 报告类公共任务：公共版一次生成（无主题订阅者共享）+ 有主题用户按**每个主题
   * 独立生成**个性化版（ADR-0027：订阅 N 个主题就收到 N 份独立海报+推送，不再
   * 合并成一份让模型自己权衡分配——那样用户订阅了多个主题也看不出区别，某个
   * 主题当天还可能被挤到 0 条而不自知）。各自独立生成、独立去重、独立海报。
   *
   * **重试按生成单元独立跟踪（ADR-0028）**：单元 = 无主题共享公共版（userId=''、
   * topic=''）或某个 (用户, 主题)。此前重试判定是任务级全有全无（"一份都没成功"
   * 才重试），一旦部分成功部分失败，失败单元既不重试、其用户还收到过"系统会
   * 自动重试"的虚假承诺。现改为：首轮跑全部单元；失败单元连同各自尝试次数写进
   * `tasks.retry_units`（跨 tick 持久化），重试轮**只重跑还挂着的单元**——已成功
   * 的用户绝不被重复生成/推送；所有最初尝试过的单元都成功或耗尽重试次数后，
   * 任务才整体结算（`retry=false` → markRun，锚点推到下一周期并清空单元状态）。
   * 失败话术按**该单元自己**的重试余量措辞，不拿别的单元的命运替它承诺。 */
  async #runReportTask(task) {
    const now = this.#now()
    const subscribers = task.subscribers || []
    const topicsByUser = this.#taskStore.reportTopicsByTask(task.name)
    const plainUsers = subscribers.filter((u) => !topicsByUser[u]?.length)
    // 当前全部生成单元（公共版单元排最前，保持原有执行顺序）
    const allUnits = []
    if (plainUsers.length) allUnits.push({ userId: '', topic: '' })
    for (const userId of subscribers.filter((u) => topicsByUser[u]?.length)) {
      for (const topic of topicsByUser[userId]) allUnits.push({ userId, topic })
    }
    // 待重试状态：非首轮（retry_units 非空）只重跑还挂着的单元；期间退订/删主题
    // 导致单元消失的，直接出局（不再属于"最初尝试过的单元"集合的存活部分）。
    const unitKey = (u) => `${u.userId}\u0000${u.topic}`
    const pendingBefore = Array.isArray(task.retryUnits) ? task.retryUnits : []
    const pendingByKey = new Map(pendingBefore.map((u) => [unitKey(u), u]))
    const toAttempt = pendingBefore.length ? allUnits.filter((u) => pendingByKey.has(unitKey(u))) : allUnits
    const results = []
    const nextPending = []

    for (const unit of toAttempt) {
      // 单元级重试余量：话术与"是否继续挂起"都只看这个单元自己试了几次
      const unitAttemptNumber = (pendingByKey.get(unitKey(unit))?.attempts || 0) + 1
      const unitIsLast = unitAttemptNumber >= this.#retryMax + 1
      if (!unit.userId) {
        // ① 公共版：未设主题的订阅者共享一份（生成一次，不随人数翻倍）
        const r = await this.#generateAndStore(task, null, now, '')
        if (r.ok) {
          for (const userId of plainUsers) results.push(await this.#fanoutReport(task, userId, r.report.posterPath, this.#pushText(r.report)))
        } else {
          const { text, giveUp } = this.#unitFailure(task, r, unitAttemptNumber, unitIsLast)
          for (const userId of plainUsers) results.push(await this.#fanoutReport(task, userId, '', text))
          results.push({ userId: `task-${task.id}`, error: r.error }) // 公共版失败可观测
          if (!giveUp) nextPending.push({ userId: '', topic: '', attempts: unitAttemptNumber })
        }
      } else {
        // ② 个性化版：每个 (用户, 主题) 各自单独生成一份（互不合并、互不串），
        // 失败按主题各自降级，不因一个主题失败连累其他主题。
        const r = await this.#generateAndStore(task, unit.userId, now, unit.topic)
        if (r.ok) {
          results.push(await this.#fanoutReport(task, unit.userId, r.report.posterPath, this.#pushText(r.report, [unit.topic])))
        } else {
          const { text, giveUp } = this.#unitFailure(task, r, unitAttemptNumber, unitIsLast)
          results.push(await this.#fanoutReport(task, unit.userId, '', text))
          results.push({ userId: `task-${task.id}-${unit.userId}-${unit.topic}`, error: r.error }) // 个性化失败可观测（按主题定位）
          if (!giveUp) nextPending.push({ userId: unit.userId, topic: unit.topic, attempts: unitAttemptNumber })
        }
      }
    }

    // 落盘待重试单元（空数组 = 本周期不再有单元等重试）；整体结算时 markRun 还会再清一次
    this.#taskStore.setReportRetryUnits(task.id, nextPending)
    return { results, retry: nextPending.length > 0 }
  }

  /** 微信日报/周报（kind='wechat-digest'，DESIGN-wechat-digest.md）。
   *
   * 与 `#runReportTask` 的结构刻意保持一致（单元级重试、`retry_units` 持久化、
   * 按单元措辞的失败话术都原样复用 ADR-0026/0028 的机制），但**生成单元的定义
   * 不同**：日报是"公共版 + 每个 (用户,主题)"，这里是**每个订阅者各一个单元**
   * ——内容全部来自该用户自己的群，没有任何可共享的部分，一次生成全员扇出的
   * 模型在这里根本不成立。单元 key 沿用 `{userId, topic:''}`，与 `retry_units`
   * 的既有形状兼容，不需要为它再开一列。
   *
   * **逐用户串行**：LLM 调用走调度器专属实例（ADR-0028），本来就是一条串行
   * 队列，这里不额外并发；单用户失败只影响他自己那个单元。
   *
   * **"空"不是失败**：三节全空（`empty:true`）走静默路径——默认发一句
   * "今天各群平静"的短文本、不发海报（`digestQuietPush=false` 则彻底不发），
   * 并且**直接算作已处理**，不进 `retry_units`。把"没内容"当成失败去重试，会
   * 让每个安静的日子都触发 3 轮无谓的 LLM 调用和一条"生成失败"的话术。 */
  async #runDigestTask(task) {
    const now = this.#now()
    const windowDays = digestWindowDays(task.schedule)
    const subscribers = task.subscribers || []
    const unitKey = (u) => `${u.userId}\u0000${u.topic}`
    const allUnits = subscribers.map((userId) => ({ userId, topic: '' })) // 单元 = 一个订阅者
    const pendingBefore = Array.isArray(task.retryUnits) ? task.retryUnits : []
    const pendingByKey = new Map(pendingBefore.map((u) => [unitKey(u), u]))
    const toAttempt = pendingBefore.length ? allUnits.filter((u) => pendingByKey.has(unitKey(u))) : allUnits
    const results = []
    const nextPending = []

    for (const unit of toAttempt) {
      const unitAttemptNumber = (pendingByKey.get(unitKey(unit))?.attempts || 0) + 1
      const unitIsLast = unitAttemptNumber >= this.#retryMax + 1
      // 身份先行：digest 的取数边界完全由 profile 的 wxid/nickname 决定
      // （accessibleChats），未核验的用户根本无从取数——与 #fanoutReport 的
      // unverified 跳过是同一个判断，提前到生成之前做，省掉一次注定为空的管道。
      const profile = await this.#profileStore.get(unit.userId)
      if (!profile?.nickname && !profile?.wxid) { results.push({ userId: unit.userId, skipped: 'unverified' }); continue }
      let r
      try {
        r = await this.#digestRunner.generate({ task, userId: unit.userId, profile, now })
      } catch (error) {
        r = { ok: false, error: error.message || String(error) }
      }
      if (r.ok && r.empty) {
        // 各群平静：可配置的静默。不占重试预算。
        if (this.#digestQuietPush) results.push(await this.#fanoutReport(task, unit.userId, '', renderQuietText(task.name, { windowDays })))
        else results.push({ userId: unit.userId, skipped: 'quiet_day' })
        continue
      }
      if (r.ok) {
        const url = this.#reportUrl ? this.#reportUrl(r.report.id) : ''
        results.push(await this.#fanoutReport(task, unit.userId, r.report.posterPath, renderDigestPushText(r.report, { reportUrl: url })))
        continue
      }
      const { text, giveUp } = this.#unitFailure(task, r, unitAttemptNumber, unitIsLast)
      results.push(await this.#fanoutReport(task, unit.userId, '', text))
      results.push({ userId: `task-${task.id}-${unit.userId}`, error: r.error }) // 可观测
      if (!giveUp) nextPending.push({ userId: unit.userId, topic: '', attempts: unitAttemptNumber })
    }

    this.#taskStore.setReportRetryUnits(task.id, nextPending)
    return { results, retry: nextPending.length > 0 }
  }

  /** 生成失败时推给用户的话术：还有重试机会就如实说"会自动重试"，重试耗尽就
   * 明说"今天放弃、明天再来"——不再用含糊的"请稍后重试"（其实没人会重试，
   * 用户只会干等或来问）。报告任务传入的是**该生成单元自己**的尝试次数/余量
   * （ADR-0028）：说"会自动重试"就必须真的会重试这个单元，不能拿任务级或
   * 别的单元的状态替它承诺。 */
  #failureText(task, attemptNumber, isLastAttempt) {
    if (isLastAttempt) {
      return `【定时任务「${task.name}」】已重试 ${attemptNumber} 次仍失败，今天不再重试，明天按计划再试。`
    }
    return `【定时任务「${task.name}」】本次生成失败，系统会自动重试，无需操作。`
  }

  /** 不可重试错误（402 余额不足/401 鉴权/400 参数）的话术：不说"会自动重试"
   * ——这是一个不会兑现的承诺，账户余额问题不会因为等 20 分钟再试就自己好
   * （2026-09-18 事故的直接教训：402 被当成普通失败机械重试了 3 次）。 */
  #nonRetryableFailureText(task) {
    return `【定时任务「${task.name}」】本次生成遇到无法自动恢复的问题（比如账户余额或鉴权配置），今天不再重试，问题解决后下个周期会自动恢复正常推送。`
  }

  /** 单元失败时的推送文案 + 这个单元是否到此为止（不再排进重试）。
   * 两条独立的整改（2026-09-18 事故，第 1/3 件事）都收在这里：
   *   1. 绝不能把 `r.rawText` 原样当文案发出去——它是喂给 `parseReportJson`/
   *      `parseDigestJson` 解析用的原始 LLM 输出，解析失败时**通常**就是一段
   *      没收尾的 JSON（如 `{"focus":...,"items":[...]}`），而不是人话；只有
   *      明显是自然语言（如"抱歉，今天没有合适的新闻"）时才展示它，否则一律
   *      走标准失败话术（`looksLikeRawJsonPayload` 兜底判断）。
   *   2. 错误分类决定要不要继续排重试（ADR-0026/0028 只有"重试/放弃"两态，
   *      没有区分错误是否"重试也没用"）——不可重试错误立刻放弃，不占用
   *      `retryMax` 配额，也不再对用户说一句不会兑现的"会自动重试"。 */
  #unitFailure(task, r, unitAttemptNumber, unitIsLast) {
    const rawText = String(r.rawText || '').trim()
    const safeRaw = rawText && !looksLikeRawJsonPayload(rawText) ? rawText : ''
    const retryable = isRetryableError({ message: r.error })
    const giveUp = unitIsLast || !retryable
    const text = safeRaw || (retryable ? this.#failureText(task, unitAttemptNumber, unitIsLast) : this.#nonRetryableFailureText(task))
    return { text, giveUp }
  }

  /** 生成并入库一份报告（userId 为空 = 公共版；非空 = 该用户个性化版）。
   * `topic`（ADR-0027）：非空时只代表**单个**主题——调用方对用户的每个订阅主题
   * 各调一次本方法，而不是把多个主题合并进一次调用；这样每个主题的 prompt、
   * 去重窗口、生成结果、海报都完全独立，一个主题的新闻不会挤占另一个主题的名额。 */
  async #generateAndStore(task, userId, now, topic = '') {
    const runUserId = `task-${task.id}${userId ? `-${userId}` : ''}${topic ? `-${topic}` : ''}` // 合成用户：ephemeral 执行，主题独立会话
    const topics = topic ? [topic] : []
    try {
      // 近 7 天已报道标题注入 prompt 要求回避（去重窗口按用户+主题维度隔离）
      const recent = this.#reportStore.recentTitles(task.id, 7, 20, { userId: userId || '', topic, now })
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
      // 机械去重（指纹比对近 7 天同一用户+主题的历史；删后不足 3 条保底不删）
      const deduped = dedupeItems(parsed.items, this.#reportStore.recentFingerprints(task.id, 7, { userId: userId || '', topic, now }))
      let report = this.#reportStore.saveReport({ taskId: task.id, name: task.name, runAt: now, focus: parsed.focus, rawText, items: deduped.items, userId: userId || '', topic })
      // 海报长图（ADR-0018）：HTML → PNG；失败非致命，降级为纯文本短描述
      if (this.#posterRender) {
        try {
          const posterPath = await this.#posterRender(report, renderReportPoster({ ...report, topics }))
          if (posterPath) report = this.#reportStore.saveReport({ ...report, posterPath })
        } catch { /* poster 失败 → 纯文本降级 */ }
      }
      return { ok: true, report }
    } catch (error) {
      // 完整错误（含 stack）落服务端日志——用户侧只会看到 #unitFailure 生成的
      // 简短话术，排查还得靠这里（第 2/3 件事的落盘要求）。
      logServerError('task-scheduler:generate', error, { taskId: task.id, userId, topic })
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
      // 引导曝光埋点（ADR-0020）：海报/短描述带**主题定制**引导，记录展示。
      // 微信日报/周报没有主题概念、推送文案里也没有这条引导——给它记 guide_shown
      // 会把 ADR-0020 的转化率分母灌水成"曝光了但从来不会转化"，故排除。
      if (task.kind !== 'wechat-digest') this.#taskStore.recordGuideEvent({ userId, event: 'guide_shown', entry: 'push', taskName: task.name })
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
      // 生成本身失败（LLM/工具异常）：值得短间隔重试（ADR-0026）——但**不是所有
      // 失败都值得**（2026-09-18 事故教训）：402/401/400 这类账户/鉴权/参数问题
      // 重试也没用，只会白烧 retryMax 次日志（failure-messaging.mjs 统一判定，
      // 与报告/日报生成单元共用同一份分类）。
      logServerError('task-scheduler:runForUser', error, { taskId: task.id, userId })
      return { userId, error: error.message || String(error), retryable: isRetryableError(error) }
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
