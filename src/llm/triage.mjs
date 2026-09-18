import { JSON_RETRY_HINT } from '../services/failure-messaging.mjs'
import { tryParseWithRepair } from '../services/json-repair.mjs'

/** 分诊器（DESIGN-turn-pipeline / ADR-0038）——固定反馈管道的第一跳。
 *
 * 职责边界（这是整个设计的立足点）：分诊器**只产出数据**（kind / ack 文案 /
 * plan 结构），所有"决定"——发不发回执、落不落板、走哪条路——都是调用方
 * （TurnPipeline + message-router）的代码规则。LLM 只能影响内容，不能影响流程。
 *
 * 固定降级规则（R1，最重要的一条）：LLM 调用失败、超时、JSON 修不好、plan
 * 校验不过——**一律降级为 chat**（主 agent 完整 respond，即本管道上线前的
 * 行为）。分诊器彻底坏掉时系统恰好退化成昨天的样子，不会更糟。
 *
 * 保守偏置（R4）：误判方向不对称——闲聊被建成任务（凭空多出流程感）比任务
 * 被慢答一条（退化为现状）更伤体验，所以 prompt 明示"不确定→chat"，且
 * temperature=0。对已有任务的追问/操作（"任务3怎么样了""重试一下"）也归
 * chat：主 agent 有 task_* 工具，chat 路本来就能处理。 */

const MAX_PLAN = 5
const ACK_MAX_CHARS = 80
const DEFAULT_TIMEOUT_MS = 8_000

const TRIAGE_SYSTEM = [
  '你是微信个人助手的消息分诊器。判断用户这条消息是「闲聊/问答」还是「交代任务」，只输出 JSON，不输出任何其他文字。',
  '',
  '核心判据：这轮对话结束时，助手给用户的是**结果**还是**承诺**？',
  '- 能当场给出结果（问答、查询、闲聊、能力咨询、对已有任务的追问或操作如"重试""怎么样了""不用做了"）→ {"kind":"chat"}',
  '- 只能给承诺（要产出交付物：文件/文档/报告/图片；导出/下载；批量处理；抓取多篇再汇总；要等外部异步接口）→ kind=task',
  '',
  '判 chat 的额外规则（拿不准一律 chat）：',
  '- 信息不完整、需要先向用户澄清的（如"帮我改一下那个方案"没说改哪份）→ chat（主助手会追问）',
  '- 用户在问能力（"你能导出文档吗"）而不是交代活 → chat',
  '- 消息只是补充/修改之前交代过的事 → chat',
  '',
  'kind=task 时输出：',
  '{"kind":"task","ack":"...","plan":[{"subject":"...","description":"...","activeForm":"...","dependsOn":[]}]}',
  '- ack：一句自然的受理确认（≤60字）：复述你理解用户要什么、打算怎么做。不承诺具体结果、不客套。',
  `- plan：1-${MAX_PLAN} 个子任务。每个是**有意义的交付单元**（不是琐碎步骤），且单个应能在几分钟内完成。`,
  '- subject：祈使句标题。description：自包含详情（背景+目标+交付形式+成功标准）——执行者**看不到本对话**，只看到这段；消息带附件时把附件路径写进 description。',
  '- activeForm：现在进行时文案，如"正在导出季度总结"。',
  '- dependsOn：必须先完成的其他子任务的**数组下标**（如第二步依赖第一步则 [0]）；无依赖为 []。',
  '',
  '输出必须是能被 JSON.parse 直接解析的合法 JSON；字符串内部的双引号必须写成 \\"。',
].join('\n')

export function createTriage({ complete, timeoutMs = DEFAULT_TIMEOUT_MS, maxPlan = MAX_PLAN } = {}) {
  if (typeof complete !== 'function') throw new TypeError('complete is required')

  /** @returns {Promise<{kind:'chat', reason?:string} | {kind:'task', ack:string, plan:Array}>} */
  return async function triage({ text, transcript = [], activeTasks = [], attachments = [] }) {
    const userPrompt = buildUserPrompt({ text, transcript, activeTasks, attachments })
    const messages = [{ role: 'system', content: TRIAGE_SYSTEM }, { role: 'user', content: userPrompt }]
    let raw
    try {
      raw = await withTimeout(complete(messages, { temperature: 0, maxTokens: 600 }), timeoutMs)
    } catch (e) {
      return { kind: 'chat', reason: `triage_failed:${e?.message || e}` }
    }
    let parsed = parseTriageJson(raw)
    if (!parsed) {
      // 解析失败：带纠正提示就地重试一次（同 ADR-0035 报告管道的手法）
      try {
        raw = await withTimeout(complete([...messages, { role: 'assistant', content: String(raw || '') }, { role: 'user', content: JSON_RETRY_HINT }], { temperature: 0, maxTokens: 600 }), timeoutMs)
        parsed = parseTriageJson(raw)
      } catch { /* fall through to degrade */ }
    }
    if (!parsed) return { kind: 'chat', reason: 'triage_unparsable' }
    if (parsed.kind !== 'task') return { kind: 'chat' }

    // ---- plan 代码校验（R2）：不信任 LLM 结构，任何一条不过 → 降级 chat ----
    const plan = Array.isArray(parsed.plan) ? parsed.plan : []
    if (plan.length < 1 || plan.length > maxPlan) return { kind: 'chat', reason: `plan_size:${plan.length}` }
    const cleaned = []
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i] || {}
      const subject = String(p.subject || '').trim()
      if (!subject) return { kind: 'chat', reason: `plan_empty_subject:${i}` }
      const deps = Array.isArray(p.dependsOn) ? p.dependsOn.map(Number) : []
      for (const d of deps) {
        if (!Number.isInteger(d) || d < 0 || d >= plan.length || d === i) return { kind: 'chat', reason: `plan_bad_dep:${i}->${d}` }
      }
      cleaned.push({ subject, description: String(p.description || '').trim(), activeForm: String(p.activeForm || '').trim(), dependsOn: deps })
    }
    if (hasCycle(cleaned)) return { kind: 'chat', reason: 'plan_cycle' }

    // ---- ack 兜底（R3）：文案好坏是 LLM 的事，"必须有一句"是代码的事 ----
    let ack = String(parsed.ack || '').trim()
    if (!ack) ack = `收到，我来办：${cleaned.map((p) => p.subject).join('、')}`
    if (ack.length > ACK_MAX_CHARS) ack = `${ack.slice(0, ACK_MAX_CHARS)}…`

    return { kind: 'task', ack, plan: cleaned }
  }
}

function buildUserPrompt({ text, transcript, activeTasks, attachments }) {
  const lines = []
  const recent = transcript.slice(-6)
  if (recent.length) {
    lines.push('【最近对话】')
    for (const m of recent) lines.push(`${m.role === 'user' ? '用户' : '助手'}：${String(m.content || '').slice(0, 200)}`)
    lines.push('')
  }
  if (activeTasks.length) {
    lines.push('【用户当前进行中的任务】（对这些任务的追问/修改/取消一律判 chat）')
    for (const t of activeTasks) lines.push(`#${t.id} ${t.subject}（${t.status}）`)
    lines.push('')
  }
  if (attachments.length) {
    lines.push('【本条消息附带的文件】（若判 task，把需要用到的路径写进对应子任务的 description）')
    for (const a of attachments) lines.push(`- ${a.name || '未命名'}：${a.path || '路径不可用'}`)
    lines.push('')
  }
  lines.push('【用户消息】')
  lines.push(String(text || '（无文字，只发了附件）'))
  return lines.join('\n')
}

function parseTriageJson(raw) {
  const t = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  const slice = t.slice(start, end + 1)
  try {
    const v = JSON.parse(slice)
    return v && typeof v === 'object' ? v : null
  } catch {
    const repaired = tryParseWithRepair(slice)
    return repaired && typeof repaired === 'object' ? repaired : null
  }
}

function hasCycle(plan) {
  const state = new Array(plan.length).fill(0) // 0=未访问 1=在栈 2=完成
  const dfs = (i) => {
    if (state[i] === 1) return true
    if (state[i] === 2) return false
    state[i] = 1
    for (const d of plan[i].dependsOn) if (dfs(d)) return true
    state[i] = 2
    return false
  }
  for (let i = 0; i < plan.length; i++) if (dfs(i)) return true
  return false
}

/** 超时定时器**不 unref、结算即清**：unref 的定时器在事件循环空时永不触发——
 * 若底层 promise 也永不结算（LLM 连接悬死），降级路径就永远走不到。ref 的
 * 代价只在悬死场景下把进程多留 ≤ms 毫秒，正常路径定时器立即清掉、零持有。 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`triage timeout ${ms}ms`)), ms)
    promise.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}
