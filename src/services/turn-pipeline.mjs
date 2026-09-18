import { logServerError } from './failure-messaging.mjs'

/** 固定反馈管道（ADR-0038，两段式修订）。
 *
 * 把"一条用户消息"的处理从单一黑盒 respond() 切成代码固定的两条路：
 *
 *   classify（快路轻量 LLM，只判 kind+ack，小输出）
 *     ├─ chat → 调用方照旧走主 agent respond（一条直答，本管道零介入）
 *     └─ task → 调用方先发**受理回执**，发送成功后 await commit()：
 *               plan 生成（慢路 LLM，延迟藏在回执后面）→ 计划机械落板
 *               → poke drain → 会话/记忆记账。
 *
 * 固定规则（全部代码保证，LLM 只填内容）：
 *   - classify 失败/超时/空/坏 JSON → 一律 chat（route() 永不 throw）；
 *   - **回执发送成功之后才 commit**（防子任务极快时"完成先于回执"乱序）；
 *   - plan 生成失败 → **单任务兜底**（subject=用户原话截断、description=原话
 *     全文）——回执已发出，承诺必须有载体，此刻降级 chat 已不可能也不诚实；
 *   - 落板不依赖主 agent 自觉：plan → board.create × N（两趟建板支持前向
 *     依赖）+ 共享 metadata.batchId；
 *   - 会话一致性（S1/S5）：append(用户消息, 回执) + memory.absorb 同对。
 *
 * 已知边界：task 路不触发会话折叠（fold 连着 compactor 的 LLM 调用，活在
 * 主 agent respond 里）——用户任意一次 chat 轮次会把折叠追上。 */
export class TurnPipeline {
  #triage
  #board
  #runner
  #sessions
  #memory

  /** @param {{triage: {classify: Function, plan: Function}, board: object, runner?: object, sessions?: object, memory?: object}} deps */
  constructor({ triage, board, runner, sessions, memory = null }) {
    if (!triage || typeof triage.classify !== 'function' || typeof triage.plan !== 'function') throw new TypeError('triage {classify, plan} is required')
    if (!board) throw new TypeError('board is required')
    this.#triage = triage
    this.#board = board
    this.#runner = runner
    this.#sessions = sessions
    this.#memory = memory
  }

  /** 分诊一条用户消息。**永不 throw**：任何内部失败都返回 chat（R1 降级）。
   * @returns {{kind:'chat'} | {kind:'task', ack:string, commit:() => Promise<{batchId:string, taskIds:number[]}>}} */
  async route({ userId, text, attachments = [] }) {
    let result
    const t0 = Date.now()
    let ctx
    try {
      ctx = {
        text,
        attachments,
        transcript: this.#sessions ? this.#sessions.get(userId).transcript : [],
        activeTasks: this.#board.list(userId).map((t) => ({ id: t.id, subject: t.subject, status: t.status })),
      }
      result = await this.#triage.classify(ctx)
    } catch (error) {
      logServerError('turn-pipeline', error, { userId, stage: 'classify' })
      result = { kind: 'chat', reason: 'classify_threw' }
    }
    // 分诊决策留痕：出问题时能回答"为什么这条被当成了闲聊"
    console.log(`[triage] user=${String(userId).slice(0, 12)} kind=${result.kind}${result.reason ? ` reason=${result.reason}` : ''} ${Date.now() - t0}ms`)
    if (result.kind !== 'task') return { kind: 'chat' }
    return {
      kind: 'task',
      ack: result.ack,
      commit: async () => this.#commit({ userId, text, ack: result.ack, ctx, attachments }),
    }
  }

  /** 回执发送成功后：生成 plan（慢路，用户已拿到回执）→ 落板。 */
  async #commit({ userId, text, ack, ctx, attachments }) {
    const t0 = Date.now()
    let plan = null
    try {
      plan = await this.#triage.plan({ ...ctx, ack })
    } catch (error) {
      logServerError('turn-pipeline', error, { userId, stage: 'plan' })
    }
    if (!plan) {
      // 单任务兜底：承诺已给出（回执已发），必须有载体去兑现
      plan = [{ subject: String(text || '').slice(0, 60), description: String(text || ''), activeForm: '', dependsOn: [] }]
      console.log(`[triage] user=${String(userId).slice(0, 12)} plan=fallback-single ${Date.now() - t0}ms`)
    } else {
      console.log(`[triage] user=${String(userId).slice(0, 12)} plan=${plan.length} ${Date.now() - t0}ms`)
    }

    const batchId = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    // 两趟：先建全部任务，再补依赖边——plan 的 dependsOn 允许前向引用
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
