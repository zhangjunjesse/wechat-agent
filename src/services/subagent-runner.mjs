/** 子 agent 后台执行器（DESIGN-task-delegation.md / ADR-0024）。
 *
 * 主 agent 调 delegate_task 后立即返回，真正的执行在这里异步进行：
 *
 *   队列（每用户并发上限）→ 建**独立** AgentsSdkAgent 实例 → respond(goal)
 *   → 结算（首次结果优先）→ **无条件通知用户**（成功/失败/超时都通知）
 *
 * 关键设计（来自 DSH 研究，见 docs/research-dsh-subagent.md / -jobs.md）：
 *   - **独立 agent 实例**：子 agent 各自持有 wrapClientForDeepSeek 包装的 client 与
 *     串行队列，避免与主 agent 争 thinking 缓存（否则 DeepSeek 400）；
 *   - **上下文隔离**：goal + 可选 context 摘要，不带主对话历史（spawn 语义）；
 *     `ephemeral: true` 执行 —— 不写用户的 session/记忆；
 *   - **受限工具集**：不含 delegate/task 工具（防递归），保留 send_file/notify_user
 *     与业务工具（子 agent 需自己交付文件、汇报进度）；
 *   - **结算通知无条件投递**（DSH 结论：最需要说明结局的正是子级没机会开口的情形），
 *     且在释放并发位**之前**发出；`notified` 位保证只发一次；
 *   - **无抢占**：超时只结算为 timeout 并通知，不硬杀（子 run 自行结束）。
 */
export class SubagentRunner {
  #agentFactory
  #store
  #provider
  #contextTokens
  #profileStore
  #maxConcurrentPerUser
  #timeoutMs
  #queue = []
  #running = new Map() // userId -> count
  #onError

  constructor({ agentFactory, store, provider, contextTokens, profileStore = null, maxConcurrentPerUser = 2, timeoutMs = 300_000, onError = null }) {
    if (typeof agentFactory !== 'function') throw new TypeError('agentFactory is required')
    this.#agentFactory = agentFactory
    this.#store = store
    this.#provider = provider
    this.#contextTokens = contextTokens
    this.#profileStore = profileStore
    this.#maxConcurrentPerUser = Math.max(1, Number(maxConcurrentPerUser) || 2)
    // 超时：正值即生效（生产默认 300s，由 env DELEGATE_TIMEOUT_MS 配置；不设硬下限以便测试）
    this.#timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 300_000
    this.#onError = onError
  }

  /** 入队（立即返回，不等待执行）。 */
  enqueue({ taskId, userId, profile = null, channel = null }) {
    this.#queue.push({ taskId, userId, profile, channel })
    queueMicrotask(() => { void this.#drain() })
    return true
  }

  /** 处理队列：为每个用户维持并发上限。 */
  async #drain() {
    for (let i = 0; i < this.#queue.length; i++) {
      const item = this.#queue[i]
      const running = this.#running.get(item.userId) || 0
      if (running >= this.#maxConcurrentPerUser) continue // 该用户已达并发上限，排队等待
      this.#queue.splice(i, 1)
      i -= 1
      this.#running.set(item.userId, running + 1)
      void this.#run(item).finally(() => {
        const left = (this.#running.get(item.userId) || 1) - 1
        if (left <= 0) this.#running.delete(item.userId)
        else this.#running.set(item.userId, left)
        queueMicrotask(() => { void this.#drain() }) // 释放位置后继续排后续任务
      })
    }
  }

  async #run({ taskId, userId, profile, channel }) {
    const task = this.#store.get(taskId)
    if (!task) return
    this.#store.markRunning(taskId)
    const startedAt = Date.now()
    let outcome = { status: 'failed', result: '', error: '' }
    try {
      const agent = await this.#agentFactory()
      const prompt = buildSubagentPrompt(task)
      const runUserId = `subagent:${taskId}`
      const execProfile = profile || (this.#profileStore ? await this.#profileStore.get(userId) : null) || { nickname: '任务执行', wxid: runUserId }
      const timeout = new Promise((resolve) => {
        const t = setTimeout(() => resolve({ timedOut: true }), this.#timeoutMs)
        t.unref?.()
      })
      const reply = await Promise.race([
        agent.respond({ userId: runUserId, text: prompt, profile: execProfile, channel, ephemeral: true }).then((r) => ({ r })),
        timeout,
      ])
      if (!reply || reply.timedOut) {
        outcome = { status: 'timeout', result: '', error: `超过 ${Math.round(this.#timeoutMs / 1000)} 秒未完成` }
      } else {
        const text = typeof reply.r?.text === 'string' ? reply.r.text : String(reply.r ?? '')
        // 子 agent 若已用 send_file 交付文件，这里只记录文本；文件交付由子 agent 自己完成
        outcome = text ? { status: 'done', result: text, error: '' } : { status: 'failed', result: '', error: '子任务没有产出任何内容' }
      }
    } catch (error) {
      outcome = { status: 'failed', result: '', error: error?.message || String(error) }
    } finally {
      const elapsed = Math.round((Date.now() - startedAt) / 1000)
      const settled = this.#store.settle(taskId, { ...outcome, atMs: Date.now() })
      // 结算通知：无条件（成功/失败/超时都告知），且在释放并发位之前
      try {
        await this.#notify(settled, { userId, channel, elapsed })
      } catch (error) {
        this.#onError?.(error, settled)
      }
    }
  }

  /** 把结算结果推给用户（`notified` 位保证只发一次）。 */
  async #notify(task, { userId, channel }) {
    if (!task) return
    if (!this.#store.markNotified(task.id)) return // 已被通知过（重试/重复结算）
    const text = renderSettlementText(task)
    const target = channel && channel.contextToken
      ? channel
      : this.#tokenFor(userId)
    if (!target) return // 无推送通道：记录已由 store 保留，用户下次问起可查
    await this.#provider.sendText({
      providerBotId: target.providerBotId,
      toProviderUserId: target.toProviderUserId,
      contextToken: target.contextToken,
      text,
    })
  }

  #tokenFor(userId) {
    const cached = this.#contextTokens?.get(userId)
    if (cached?.contextToken) return { providerBotId: cached.providerBotId, toProviderUserId: userId, contextToken: cached.contextToken }
    return null
  }
}

/** 子 agent 的任务提示：自包含 + 交付要求（子 agent 看不到主对话）。 */
export function buildSubagentPrompt(task) {
  return [
    `【后台任务 ${task.id}】你是被主助手派出来的执行子 agent，**看不到与用户的对话历史**，只依据下面的任务描述工作。`,
    '',
    `## 任务目标`,
    task.goal,
    task.context ? `\n## 补充上下文（主助手提供）\n${task.context}` : '',
    '',
    '## 执行要求',
    '1. 先用可用工具把任务做完；信息不足时，明确说明缺什么（不要编造、不要猜）。',
    '2. 产出文件时先用 write_file / 相应工具生成，再用 send_file 直接发给用户（当前对话是微信渠道）。',
    '3. 任务较长时，可用 notify_user 给用户发一句简短进度（最多 2 次）。',
    '4. 最后用中文给一段**结果说明**（≤200 字）：做了什么、结果如何、产物在哪（文件名/链接）。这段文字会作为任务结果推送给用户。',
  ].filter(Boolean).join('\n')
}

/** 结算通知文案（成功/失败/超时三种；带 task id 便于用户引用）。 */
export function renderSettlementText(task) {
  const head = `☑️ 任务 ${task.id} 完成`
  if (task.status === 'done') {
    return `${head}：${truncate(task.result, 200)}`
  }
  if (task.status === 'timeout') {
    return `⏱ 任务 ${task.id} 超过时限未完成，已停止（${task.error || '超时'}）。回复「重试 ${task.id}」可以再试一次。`
  }
  if (task.status === 'cancelled') {
    return `🚫 任务 ${task.id} 已取消。`
  }
  return `⚠️ 任务 ${task.id} 失败：${truncate(task.error || '未知原因', 160)}。回复「重试 ${task.id}」可以再试一次。`
}

function truncate(text, max) {
  const s = String(text || '').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}
