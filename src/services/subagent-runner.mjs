import { isRetryableError, logServerError } from './failure-messaging.mjs'

/** 板驱动的后台执行器（DESIGN-agent-task-board.md；前身 ADR-0024 的队列版）。
 *
 * 与 ADR-0024 版的关键差异：**板即队列**。不再持有内存 `#queue`（那正是"进程
 * 重启任务悬挂"的根源）——执行目标从 `agent_tasks` 里现挑（可认领 = pending ∧
 * 无 owner ∧ 无未完成 blocker），认领用 CAS，进程里只留"正在跑什么"的瞬时计数。
 * 重启后什么都不用恢复：recover() 把死 owner 的 in_progress 释放回 pending，
 * 下一轮 drain 自然接上。
 *
 * 保留自 ADR-0024（原样复用）：独立 agent 实例（thinking 缓存隔离）、
 * ephemeral 执行（不写用户会话/记忆）、每用户并发上限、结算通知走 run 行的
 * `notified` CAS（至多一次）、无抢占（超时只结算不硬杀）。
 *
 * 失败双轨（ADR-0035 分类落到板上）：
 *   - 可重试（超时/限流/网络）→ 释放回 pending + auto_attempts+1，**中间静默**；
 *     攒满 maxAutoAttempts 才通知一次"没做成"。
 *   - 不可重试（402/401/400）→ 释放且 auto_attempts 直接顶到上限（不再自动
 *     重挑），立即如实通知一次，不承诺重试。
 *   - 通知文案不含任何原始报错/错误码——完整错误进服务端日志。 */
export class SubagentRunner {
  #agentFactory
  #board
  #runs
  #provider
  #contextTokens
  #profileStore
  #sessions
  #maxConcurrentPerUser
  #timeoutMs
  #maxAutoAttempts
  #retryBackoffMs
  #mainStaleMs
  #sweepIntervalMs
  #running = new Map() // userId -> count（本进程瞬时并发，不是权威状态）
  #liveOwners = new Set()
  #ownerSeq = 0
  #instanceId
  #timer = null
  #onError

  constructor({ agentFactory, board, runs, provider, contextTokens, profileStore = null, sessions = null, maxConcurrentPerUser = 2, timeoutMs = 300_000, maxAutoAttempts = 3, retryBackoffMs = 60_000, mainStaleMs = 10 * 60_000, sweepIntervalMs = 30_000, onError = null }) {
    if (typeof agentFactory !== 'function') throw new TypeError('agentFactory is required')
    if (!board) throw new TypeError('board (AgentTaskStore) is required')
    this.#agentFactory = agentFactory
    this.#board = board
    this.#runs = runs
    this.#provider = provider
    this.#contextTokens = contextTokens
    this.#profileStore = profileStore
    this.#sessions = sessions
    this.#maxConcurrentPerUser = Math.max(1, Number(maxConcurrentPerUser) || 2)
    this.#timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 300_000
    this.#maxAutoAttempts = Math.max(1, Number(maxAutoAttempts) || 3)
    this.#retryBackoffMs = Number(retryBackoffMs) >= 0 ? Number(retryBackoffMs) : 60_000
    this.#mainStaleMs = Number(mainStaleMs) > 0 ? Number(mainStaleMs) : 10 * 60_000
    this.#sweepIntervalMs = Number(sweepIntervalMs) > 0 ? Number(sweepIntervalMs) : 30_000
    this.#instanceId = `${process.pid}-${Date.now().toString(36)}`
    this.#onError = onError
  }

  /** 启动：先恢复（释放死 owner），再全量 drain，然后周期扫描。 */
  start() {
    if (this.#timer) return
    this.recover()
    this.drainAll()
    this.#timer = setInterval(() => { this.recover(); this.drainAll() }, this.#sweepIntervalMs)
    this.#timer.unref?.()
  }

  stop() {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = null }
  }

  /** 恢复扫描（幂等）：释放不再活着的认领。
   *  - worker 认领：owner 不在本进程 live 集合 → 上一个进程的遗留，释放；
   *  - main 认领（主 agent 当场做）：应在一轮对话内完成，超过 mainStaleMs 视为
   *    中断，释放回 pending。释放不占退避预算（重启不是任务的错）。 */
  recover(now = Date.now()) {
    return this.#board.recoverStale({
      now,
      shouldRelease: (task) => task.owner === 'main'
        ? now - task.updatedAt > this.#mainStaleMs
        : !this.#liveOwners.has(task.owner),
    })
  }

  /** 某用户有新可认领任务时的即时触发（task_create/task_update 调）。 */
  poke(userId) {
    queueMicrotask(() => { void this.#drain(String(userId)) })
  }

  drainAll(now = Date.now()) {
    for (const userId of this.#board.usersWithClaimable({ maxAutoAttempts: this.#maxAutoAttempts, retryBackoffMs: this.#retryBackoffMs, now })) {
      void this.#drain(userId, now)
    }
  }

  async #drain(userId, now = Date.now()) {
    for (;;) {
      const running = this.#running.get(userId) || 0
      if (running >= this.#maxConcurrentPerUser) return
      const next = this.#board.nextClaimable(userId, { maxAutoAttempts: this.#maxAutoAttempts, retryBackoffMs: this.#retryBackoffMs, now })
      if (!next) return
      this.#ownerSeq += 1
      const owner = `worker:${this.#instanceId}:${this.#ownerSeq}`
      const claimed = this.#board.claim(next.id, owner)
      if (!claimed) continue // 被别的 drain 抢走：挑下一个
      this.#running.set(userId, running + 1)
      this.#liveOwners.add(owner)
      void this.#execute(claimed, owner).finally(() => {
        this.#liveOwners.delete(owner)
        const left = (this.#running.get(userId) || 1) - 1
        if (left <= 0) this.#running.delete(userId)
        else this.#running.set(userId, left)
        this.poke(userId) // 释放并发位后继续挑
      })
    }
  }

  async #execute(task, owner) {
    const run = this.#runs.create({ userId: task.userId, goal: `${task.subject}\n${task.description}`.trim(), boardTaskId: String(task.id), origin: 'board' })
    this.#runs.markRunning(run.id)
    let outcome = { status: 'failed', result: '', error: '' }
    try {
      const agent = await this.#agentFactory()
      const prompt = buildSubagentPrompt({ runId: run.id, boardId: task.id, subject: task.subject, description: task.description })
      const execProfile = (this.#profileStore ? await this.#profileStore.get(task.userId) : null) || { nickname: '任务执行', wxid: `subagent:${run.id}` }
      const timeout = new Promise((resolve) => {
        const t = setTimeout(() => resolve({ timedOut: true }), this.#timeoutMs)
        t.unref?.()
      })
      const reply = await Promise.race([
        // userId 用 task.userId（= 该用户目录），不是 `subagent:${run.id}`：工具用
        // ctx.context.userId 解析沙箱路径（file-tools / wechat-send-tools 都这样），
        // 按 run 分目录会让同批次的兄弟任务互相看不到对方产出的文件——"生成报告"和
        // "把报告发我"永远对不上（线上实例：task-17 生成、task-18 找不到）。会话与
        // 记忆不受影响：ephemeral 仍为 true，两者都不落盘。
        agent.respond({ userId: task.userId, text: prompt, profile: execProfile, channel: this.#channelFor(task.userId), ephemeral: true }).then((r) => ({ r })),
        timeout,
      ])
      if (!reply || reply.timedOut) {
        outcome = { status: 'timeout', result: '', error: `超过 ${Math.round(this.#timeoutMs / 1000)} 秒未完成` }
      } else {
        const text = typeof reply.r?.text === 'string' ? reply.r.text : String(reply.r ?? '')
        outcome = text ? { status: 'done', result: text, error: '' } : { status: 'failed', result: '', error: '子任务没有产出任何内容' }
      }
    } catch (error) {
      outcome = { status: 'failed', result: '', error: error?.message || String(error) }
    }
    const settledRun = this.#runs.settle(run.id, { ...outcome, atMs: Date.now() })

    // ---- 板侧结算 ----
    const fresh = this.#board.get(task.id)
    if (!fresh || fresh.status === 'deleted') return // cancel 语义：结果作废、零通知（A7）

    if (outcome.status === 'done') {
      this.#board.complete(task.id, { result: outcome.result })
      await this.#safeNotify(settledRun, task, renderSettlementText({ boardId: task.id, subject: task.subject, kind: 'done', result: outcome.result, ...this.#batchState(task) }))
      return
    }

    // 失败：分类决定退避与话术（错误原文只进日志，永不进用户消息）
    logServerError('subagent-runner', new Error(outcome.error), { boardId: task.id, runId: run.id, userId: task.userId })
    const retryable = outcome.status === 'timeout' || isRetryableError(outcome.error)
    if (!retryable) {
      this.#board.release(task.id, { error: outcome.error, setAutoAttempts: this.#maxAutoAttempts })
      await this.#safeNotify(settledRun, task, renderSettlementText({ boardId: task.id, subject: task.subject, kind: 'nonRetryable', ...this.#batchState(task) }))
      return
    }
    const released = this.#board.release(task.id, { error: outcome.error, countAttempt: true })
    if (released && released.autoAttempts >= this.#maxAutoAttempts) {
      await this.#safeNotify(settledRun, task, renderSettlementText({ boardId: task.id, subject: task.subject, kind: 'gaveUp', ...this.#batchState(task) }))
    }
    // 未到上限：中间静默（ADR-0035），下一轮 sweep 自动重挑
  }

  /** 批次状态（ADR-0038）：同一次分诊落板的 plan 共享 metadata.batchId。
   * 通知带 (n/N) 进度；批内全部"尘埃落定"时，收尾说明合并进最后这条通知
   * （不另发一条，微信里少一条是一条）。"尘埃落定" = completed/deleted，或
   * pending 且退避次数已顶满（不会再自动重试）。 */
  #batchState(task) {
    const batchId = task.metadata?.batchId
    const batchSize = Number(task.metadata?.batchSize || 0)
    if (!batchId || batchSize <= 1) return {}
    const siblings = this.#board.listByBatch ? this.#board.listByBatch(task.userId, batchId) : []
    const settled = siblings.filter((t) => ['completed', 'deleted'].includes(t.status) || (t.status === 'pending' && t.autoAttempts >= this.#maxAutoAttempts))
    const ok = settled.filter((t) => t.status === 'completed').length
    return {
      progress: `(${settled.length}/${batchSize}) `,
      batchClosed: settled.length >= batchSize,
      batchOk: ok,
      batchFailed: settled.length - ok,
    }
  }

  async #safeNotify(run, task, text) {
    try {
      // 交付层可能判定"这一条没有面向用户的内容"（空串）：此时不推、也不进
      // transcript——子任务不该以任何形式对用户发言（2026-09-19 用户约束）。
      if (!String(text || '').trim()) return
      if (!run || !this.#runs.markNotified(run.id)) return // notified CAS：至多一次
      const target = this.#tokenFor(task.userId)
      // S2（ADR-0038）：这条通知是"用户看到的对话事实"，必须进
      // transcript——否则用户回"这个摘要不错，再加一段"时主 agent 不知所指。
      // 无推送通道时也记（板上有结果，下轮对话该能引用它）。
      this.#sessions?.appendAssistant?.(task.userId, text)
      if (!target) return
      await this.#provider.sendText({ providerBotId: target.providerBotId, toProviderUserId: target.toProviderUserId, contextToken: target.contextToken, text })
    } catch (error) {
      this.#onError?.(error, task)
    }
  }

  #tokenFor(userId) {
    const cached = this.#contextTokens?.get(userId)
    if (cached?.contextToken) return { providerBotId: cached.providerBotId, toProviderUserId: userId, contextToken: cached.contextToken }
    return null
  }

  /** `channel`（message-router.mjs 同款契约，见 wechat-send-tools.mjs）喂给子
   * agent 的 run context——生产实锤（2026-09-19，真实用户"Z.俊"的会话）：
   * buildSubagentPrompt 第 2 条一直告诉子 agent"当前对话是微信渠道，用
   * send_file/notify_user 直接发"，但这里从未真正传过 channel，两个工具于是
   * 每次都判 `!channel` 拒绝、回退成 write_file 下载链接——子任务生成的图片
   * 报告因此从没有一次真正落进微信，用户只能点链接。复用 #safeNotify 已经在
   * 用的同一份实时 contextToken 缓存（DESIGN-timed-tasks.md）：缓存命中就是
   * 真实 WeChat 频道；缓存未命中（用户很久没发过消息）返回 null，
   * agent.respond 对 channel:null 的降级行为和网页对话完全一致（见
   * agents-sdk-agent.mjs #doRespond）。 */
  #channelFor(userId) {
    const target = this.#tokenFor(userId)
    return target ? { type: 'ilink', ...target } : null
  }
}

/** 子 agent 的任务提示：自包含 + 交付要求（子 agent 看不到主对话、也没有任务板工具）。 */
export function buildSubagentPrompt({ runId, boardId, subject, description = '' }) {
  return [
    `【后台任务 #${boardId}（执行 ${runId}）】你是被主助手派出来的执行子 agent，**看不到与用户的对话历史**，只依据下面的任务描述工作。`,
    '',
    `## 任务`,
    subject,
    description ? `\n## 详情\n${description}` : '',
    '',
    '## 执行要求',
    '1. 先用可用工具把任务做完；信息不足时，明确说明缺什么（不要编造、不要猜）。',
    '2. 产出文件时先用 write_file / 相应工具生成，再用 send_file 直接把**产物**发给用户（当前对话是微信渠道）。除了 send_file 交付产物，**不要以任何其他方式直接对用户说话**——进度与结论一律写在第 4 条的答复里，由主 agent 呈现给用户。',
    '3. 你只有一次说话的机会（第 4 条那段答复），没有进度播报工具；长任务直接耐心做完。',
    '4. 最后用中文写**给用户看的答复**（≤150 字，直接作为微信消息发给用户）：',
    '   - 只讲结果：做成了什么、产物是什么（文件名/要点），有链接就给链接；',
    '   - **不要**写过程叙述（"我尝试了…""让我先…""需要说明的是…"）、不要写"任务完成""结果说明"这类标题、不要描述你用了哪些工具、不要提内部任务编号；',
    '   - 没做成时，一句话说清卡在哪、缺什么，让用户知道下一步能怎么办。',
    '5. **你就是后台执行者**：你没有 task_create 等任务板工具，不要试图再委派或等待别人；遇到慢工具（导出文档、生成图片等）直接调用并耐心等它返回。',
  ].filter(Boolean).join('\n')
}

/** 结算通知文案。纪律（ADR-0035）：不含错误码/原始报错；失败不承诺"会自动重试"
 * （gaveUp/nonRetryable 时自动重试已经停了，说了就是不会兑现的承诺）。
 * 批次（progress/batchClosed 来自 #batchState）：多任务批次的每条通知带
 * (n/N)，收尾说明合并进最后一条——不额外发独立汇总。
 *
 * 文案面向用户（2026-09-19 用户反馈"任务 #N 完成"像机器日志）：
 * - 成功时**不出内部任务编号**，用意图（subject）当标题、正文只放结果；
 * - 正文按段落取，截断落在句末，不再硬切 200 字切在句子中间；
 * - 失败时保留编号，因为"重试任务 N"要用户可复制。
 * 子 agent 侧已要求只写面向用户的结果（见 buildSubagentPrompt 第 4 条）。 */
export function renderSettlementText({ boardId, subject, kind, result = '', progress = '', batchClosed = false, batchOk = 0, batchFailed = 0 }) {
  const head = subject ? truncate(subject, 24) : `任务 #${boardId}`
  const tail = batchClosed
    ? (batchFailed > 0
      ? '\n—— 这批事办完了：' + batchOk + ' 件完成，' + batchFailed + ' 件没做成。'
      : '\n—— 这批事都办完了。')
    : ''
  if (kind === 'done') {
    const body = summarizeResult(polishForUser(result))
    // 交付层判定"这条没有面向用户的内容" → 不发（用户只该看到主 agent 的话；
    // 产物本身已由 send_file 交付）。例外：批次收尾行必须送出去，否则这批活
    // 干完了用户一无所知——那时只留收尾行。
    if (!body) return batchClosed ? `☑️ ${progress}${head}${tail}` : ''
    return `☑️ ${progress}${head}\n\n${body}${tail}`
  }
  if (kind === 'nonRetryable') return `⚠️ ${progress}「${head}」这边遇到了服务问题，重试也解决不了，我先停了，已经记下来。想再试的话跟我说「重试任务 ${boardId}」。${tail}`
  return `⚠️ ${progress}「${head}」试了几次都没做成，先停下了。想再试的话跟我说「重试任务 ${boardId}」。${tail}`
}

/** 结果正文的面向用户化：丢掉空行堆叠，最多 2 段；长了在句末收尾而不是硬切。
 * 入参为空串时**原样返回空串**——空串是交付层"这条不该发给用户"的信号，
 * 不能被"（没有更多说明）"填充掉（否则静默判定永远失效）。 */
function summarizeResult(text, max = 180) {
  const src = String(text || '').trim()
  if (!src) return ''
  const body = src
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 2)
    .join('\n')
  if (body.length <= max) return body || '（没有更多说明）'
  const cut = body.slice(0, max)
  const end = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('\n'))
  return end > max * 0.5 ? cut.slice(0, end + 1) : `${cut}…`
}

/** 交付层（2026-09-19 用户约束："跟用户对话的永远只有主 agent，子任务不要发给用户"）：
 * 子任务的输出是**给内部看的执行汇报**，不能原样出现在用户面前。送出去之前由这层
 * 清洗成"面向用户的交付说明"：
 *   - 去掉内部任务编号（任务 #N）；
 *   - 去掉"结果说明/任务完成/执行说明"这类内部小标题；
 *   - 删掉提到内部机制（send_file/工具名）或过程叙述的句子；
 * 清洗后若只剩元描述（如"已用 send_file 发送"），返回空串表示**这一条不该发给用户**。
 * 用纯代码规则实现——仍然不经过 LLM，保持结算通知"快且确定"（ADR-0038）。 */
export function polishForUser(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.replace(/任务\s*#\d+/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((l) => !/^(结果说明|任务完成|任务结果说明|执行说明|完成说明)[：:]?$/.test(l))
    .filter((l) => !/(send_file|notify_user)/.test(l))
    // 回显任务名的开场残句（"（搜索德文猫资料）完成："）
    .filter((l) => !/^[（(][^）)]{0,40}[）)][^。]{0,12}[：:]?$/.test(l))
    // 第一人称过程叙述（"我尝试了…""让我先…"）——用户不需要看执行者的心路。
    // 要求句子以"我/让"起头且紧跟过程动词，正常交付句不会被误伤。
    .filter((l) => !/^(我|让)(?:先|来|去|再)?(尝试|试了|试过|检查|确认|搜|查|找|看|读取|运行|执行|调用|准备|打算|计划)/.test(l))
    // 纯投递汇报：短、含投递动词、**且没有任何交付物**（无扩展名/无内容片段）。
    // 白名单优先——带文件名或够长的一律保留，别误杀"已导出并发送 报告.pdf"。
    .filter((l) => {
      const isDelivery = /(发送|发给|发你|推送|投递|已发)/.test(l)
      const hasArtifact = /\.[A-Za-z0-9]{2,5}\b/.test(l) || l.length >= 25
      return !(isDelivery && !hasArtifact)
    })
  return lines.join('\n').replace(/\n{2,}/g, '\n').trim()
}

function truncate(text, max) {
  const s = String(text || '').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}
