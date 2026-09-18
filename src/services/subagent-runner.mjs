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
        agent.respond({ userId: `subagent:${run.id}`, text: prompt, profile: execProfile, ephemeral: true }).then((r) => ({ r })),
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
    '2. 产出文件时先用 write_file / 相应工具生成，再用 send_file 直接发给用户（当前对话是微信渠道）。',
    '3. 任务较长时，可用 notify_user 给用户发一句简短进度（最多 2 次）。',
    '4. 最后用中文给一段**结果说明**（≤200 字）：做了什么、结果如何、产物在哪（文件名/链接）。这段文字会作为任务结果推送给用户。',
    '5. **你就是后台执行者**：你没有 task_create 等任务板工具，不要试图再委派或等待别人；遇到慢工具（导出文档、生成图片等）直接调用并耐心等它返回。',
  ].filter(Boolean).join('\n')
}

/** 结算通知文案。纪律（ADR-0035）：不含错误码/原始报错；失败不承诺"会自动重试"
 * （gaveUp/nonRetryable 时自动重试已经停了，说了就是不会兑现的承诺）。
 * 批次（progress/batchClosed 来自 #batchState）：多任务批次的每条通知带
 * (n/N)，收尾说明合并进最后一条——不额外发独立汇总。 */
export function renderSettlementText({ boardId, subject, kind, result = '', progress = '', batchClosed = false, batchOk = 0, batchFailed = 0 }) {
  const label = `${progress}任务 #${boardId}（${truncate(subject, 24)}）`
  const tail = batchClosed
    ? (batchFailed > 0
      ? '\n—— 这批事办完了：' + batchOk + ' 件完成，' + batchFailed + ' 件没做成。'
      : '\n—— 这批事都办完了。')
    : ''
  if (kind === 'done') return `☑️ ${label}完成：${truncate(result, 200)}${tail}`
  if (kind === 'nonRetryable') return `⚠️ ${label}这边遇到了服务问题，重试也解决不了，我先停了，已经记下来。想再试的话跟我说「重试任务 ${boardId}」。${tail}`
  return `⚠️ ${label}试了几次都没做成，先停下了。想再试的话跟我说「重试任务 ${boardId}」。${tail}`
}

function truncate(text, max) {
  const s = String(text || '').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}
