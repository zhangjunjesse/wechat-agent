import { logServerError } from './failure-messaging.mjs'

/** 固定反馈管道（ADR-0038）。
 *
 * 把"一条用户消息"的处理从单一黑盒 respond() 切成代码固定的两条路：
 *
 *   分诊（triage，~3s 轻量 LLM）
 *     ├─ chat → 调用方照旧走主 agent respond（一条直答，本管道零介入）
 *     └─ task → 调用方先发**受理回执**（各渠道自己的发送方式），发送成功后
 *               await commit()：计划机械落板 + poke drain + 会话/记忆记账。
 *
 * 固定规则（全部代码保证，LLM 只填内容）：
 *   - 分诊失败/超时/校验不过 → 一律 chat（route() 永不 throw 到调用方）；
 *   - **回执发送成功之后才落板**（commit 由调用方在 sendText resolve 后调用
 *     ——防止子任务极快时"完成通知先于回执"的乱序）；
 *   - 落板不依赖主 agent 自觉调 task_create：plan → board.create × N，
 *     dependsOn 下标由代码换算成真实板 id；同批任务共享 metadata.batchId
 *     （批次收尾汇总的判定键）；
 *   - 会话一致性（S1/S5）：commit 里 append(用户消息, 回执) 进 session
 *     （用户看到的对话事实必须在 transcript 里，否则下轮上下文断裂），并
 *     memory.absorb(用户消息, 回执)（记忆主要从用户话语里抽取）。
 *
 * 已知边界（如实，见 DESIGN）：task 路不触发会话折叠（fold 逻辑连着
 * compactor 的 LLM 调用，活在主 agent respond 里）——用户任意一次 chat 轮次
 * 会把折叠追上；纯 task 重度用户的 transcript 增长靠这一点兜底。 */
export class TurnPipeline {
  #triage
  #board
  #runner
  #sessions
  #memory
  #maxRecentTurns

  constructor({ triage, board, runner, sessions, memory = null, maxRecentTurns = 6 }) {
    if (typeof triage !== 'function') throw new TypeError('triage is required')
    if (!board) throw new TypeError('board is required')
    this.#triage = triage
    this.#board = board
    this.#runner = runner
    this.#sessions = sessions
    this.#memory = memory
    this.#maxRecentTurns = maxRecentTurns
  }

  /** 分诊一条用户消息。**永不 throw**：任何内部失败都返回 chat（R1 降级）。
   * @returns {{kind:'chat'} | {kind:'task', ack:string, plan:Array, commit:() => Promise<{batchId:string, taskIds:number[]}>}} */
  async route({ userId, text, attachments = [] }) {
    let result
    const t0 = Date.now()
    try {
      const transcript = this.#sessions ? this.#sessions.get(userId).transcript : []
      const activeTasks = this.#board.list(userId).map((t) => ({ id: t.id, subject: t.subject, status: t.status }))
      result = await this.#triage({ text, transcript, activeTasks, attachments })
    } catch (error) {
      logServerError('turn-pipeline', error, { userId, stage: 'triage' })
      result = { kind: 'chat', reason: 'triage_threw' }
    }
    // 分诊决策留痕：出问题时能回答"为什么这条被当成了闲聊"
    console.log(`[triage] user=${String(userId).slice(0, 12)} kind=${result.kind}${result.reason ? ` reason=${result.reason}` : ''}${result.plan ? ` plan=${result.plan.length}` : ''} ${Date.now() - t0}ms`)
    if (result.kind !== 'task') return { kind: 'chat' }
    return {
      kind: 'task',
      ack: result.ack,
      plan: result.plan,
      commit: async () => this.#commit({ userId, text, ack: result.ack, plan: result.plan, attachments }),
    }
  }

  /** 计划机械落板（回执发送成功后由调用方调用）。 */
  async #commit({ userId, text, ack, plan, attachments }) {
    const batchId = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    // 两趟：先建全部任务，再补依赖边——plan 的 dependsOn 允许前向引用
    // （第 1 个子任务依赖第 2 个），一趟建边时被依赖的板 id 还不存在。
    const ids = plan.map((p, i) => this.#board.create({
      userId,
      subject: p.subject,
      description: p.description,
      activeForm: p.activeForm,
      metadata: { batchId, batchSize: plan.length, batchIndex: i },
    }).id)
    for (let i = 0; i < plan.length; i++) {
      if (plan[i].dependsOn.length) {
        this.#board.update(ids[i], userId, { addBlockedBy: plan[i].dependsOn.map((d) => ids[d]) })
      }
    }
    this.#runner?.poke(userId)
    // 会话/记忆记账（S1/S5）——用户看到的对话事实进 transcript
    try { this.#sessions?.append(userId, text, ack, attachments) } catch (error) { logServerError('turn-pipeline', error, { userId, stage: 'session' }) }
    this.#memory?.absorb?.(userId, text, ack)?.catch?.(() => {})
    return { batchId, taskIds: ids }
  }
}
