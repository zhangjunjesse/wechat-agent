import { JSON_RETRY_HINT } from '../services/failure-messaging.mjs'
import { tryParseWithRepair } from '../services/json-repair.mjs'

/** 分诊器（ADR-0038，两段式修订）——固定反馈管道的第一跳。
 *
 * **为什么拆两段**（2026-09-18 生产实测倒逼的修订）：单次调用里"判定 + 回执 +
 * 完整 plan"的输出太大，任务类消息在生产网关上要 9-15+ 秒——超时旋钮拧到 15s
 * 仍被真实消息（"总结昆山农商…做成图片报告"，15.2s）击穿，回执承诺失效。
 * 拆开后：
 *   - classify：只输出 kind + ack（≤150 token）——回执延迟 = 这一跳；
 *   - plan：只在 task 时调用，且发生在**回执已发出之后**（commit 内），它的
 *     10-20 秒被藏在回执后面，用户无感。
 *
 * 职责边界不变：两段都只产出数据，所有"决定"（发不发、落不落板、降不降级）
 * 都是调用方的代码规则。LLM 只能影响内容。
 *
 * 固定降级规则：
 *   - classify 失败/超时/空/坏 JSON → chat（系统退化成管道上线前，不会更糟）；
 *   - plan 失败/超时/校验不过 → **返回 null**，由 TurnPipeline 落一个
 *     单任务兜底（subject=用户原话）——回执已经发出去了，承诺必须有载体，
 *     此时降级 chat 已经来不及也不诚实。 */

const MAX_PLAN = 5
const ACK_MAX_CHARS = 80
const CLASSIFY_TIMEOUT_MS = Number(process.env.TRIAGE_TIMEOUT_MS || 12_000)
const PLAN_TIMEOUT_MS = Number(process.env.TRIAGE_PLAN_TIMEOUT_MS || 30_000)

const CLASSIFY_SYSTEM = [
  '你是微信个人助手的消息分诊器。判断用户这条消息是「闲聊/问答」还是「交代任务」，只输出 JSON，不输出任何其他文字。',
  '',
  '核心判据：这轮对话结束时，助手给用户的是**结果**还是**承诺**？',
  '- 能当场给出结果（问答、查询、闲聊、能力咨询、对已有任务的追问或操作如"重试""怎么样了""不用做了"）→ {"kind":"chat"}',
  '- 只能给承诺（要产出交付物：文件/文档/报告/图片；导出/下载；批量处理；抓取多篇再汇总；要等外部异步接口）→ {"kind":"task","ack":"..."}',
  '',
  '判 chat 的额外规则（拿不准一律 chat）：',
  '- 信息不完整、需要先向用户澄清的（如"帮我改一下那个方案"没说改哪份）→ chat（主助手会追问）',
  '- 用户在问能力（"你能导出文档吗"）而不是交代活 → chat',
  '- 消息只是补充/修改之前交代过的事 → chat',
  '',
  'ack：一句自然的受理确认（≤60字）：复述你理解用户要什么、打算怎么做。不承诺具体结果、不客套。',
  '输出必须是能被 JSON.parse 直接解析的合法 JSON。',
].join('\n')

const PLAN_SYSTEM = [
  '你是微信个人助手的任务规划器。用户交代了一件事，助手已受理。把它拆成可后台执行的子任务清单，只输出 JSON，不输出任何其他文字。',
  '',
  '输出格式：',
  '{"plan":[{"subject":"...","description":"...","activeForm":"...","dependsOn":[]}]}',
  `- plan：1-${MAX_PLAN} 个子任务。每个是**有意义的交付单元**（不是琐碎步骤），且单个应能在几分钟内完成。能一个任务办完就不要拆。`,
  '- subject：祈使句标题。description：自包含详情（背景+目标+交付形式+成功标准）——执行者**看不到本对话**，只看到这段；消息带附件时把附件路径写进 description。',
  '- activeForm：现在进行时文案，如"正在导出季度总结"。',
  '- dependsOn：必须先完成的其他子任务的**数组下标**（如第二步依赖第一步则 [0]）；无依赖为 []。',
  '',
  '输出必须是能被 JSON.parse 直接解析的合法 JSON；字符串内部的双引号必须写成 \\"。',
].join('\n')

export function createTriage({ complete, timeoutMs = CLASSIFY_TIMEOUT_MS, planTimeoutMs = PLAN_TIMEOUT_MS, maxPlan = MAX_PLAN } = {}) {
  if (typeof complete !== 'function') throw new TypeError('complete is required')

  /** 快路：只判 kind + ack（≤150 token 输出）。永不 throw。
   * @returns {Promise<{kind:'chat', reason?:string} | {kind:'task', ack:string}>} */
  async function classify({ text, transcript = [], activeTasks = [], attachments = [] }) {
    const messages = [
      { role: 'system', content: CLASSIFY_SYSTEM },
      { role: 'user', content: buildUserPrompt({ text, transcript, activeTasks, attachments }) },
    ]
    const raw = await callWithEmptyRetry(complete, messages, { maxTokens: 150 }, timeoutMs)
    if (raw.error) return { kind: 'chat', reason: raw.error }
    const parsed = parseLooseJson(raw.text)
    if (!parsed) return { kind: 'chat', reason: `triage_unparsable:${snippet(raw.text)}` }
    if (parsed.kind !== 'task') return { kind: 'chat' }
    let ack = String(parsed.ack || '').trim()
    if (!ack) ack = `收到，这就去办：${String(text || '').slice(0, 30)}` // R3 兜底：回执必须有一句
    if (ack.length > ACK_MAX_CHARS) ack = `${ack.slice(0, ACK_MAX_CHARS)}…`
    return { kind: 'task', ack }
  }

  /** 慢路：生成 plan（回执已发出后调用，延迟对用户不可见）。失败返回 null，
   * 调用方用单任务兜底。永不 throw。 */
  async function plan({ text, ack = '', transcript = [], activeTasks = [], attachments = [] }) {
    const messages = [
      { role: 'system', content: PLAN_SYSTEM },
      { role: 'user', content: `${buildUserPrompt({ text, transcript, activeTasks, attachments })}\n\n【助手已发出的受理回执】\n${ack}` },
    ]
    let raw = await callWithEmptyRetry(complete, messages, { maxTokens: 600 }, planTimeoutMs)
    if (raw.error) return null
    let parsed = parseLooseJson(raw.text)
    if (!parsed) {
      // 坏 JSON：带纠正提示重试一次（ADR-0035 手法）
      try {
        const retry = await withTimeout(complete([...messages, { role: 'assistant', content: raw.text }, { role: 'user', content: JSON_RETRY_HINT }], { temperature: 0, maxTokens: 600 }), planTimeoutMs)
        parsed = parseLooseJson(retry)
      } catch { /* fall through */ }
    }
    if (!parsed) return null
    // 归一化：小模型高频返回字符串数组（生产实锤）——语义合法，转对象
    const rawPlan = Array.isArray(parsed.plan) ? parsed.plan : (Array.isArray(parsed) ? parsed : [])
    const items = rawPlan.map((p) => (typeof p === 'string' ? { subject: p, description: '', activeForm: '', dependsOn: [] } : p))
    if (items.length < 1 || items.length > maxPlan) return null
    const cleaned = []
    for (let i = 0; i < items.length; i++) {
      const p = items[i] || {}
      const subject = String(p.subject || '').trim()
      if (!subject) return null
      const deps = Array.isArray(p.dependsOn) ? p.dependsOn.map(Number) : []
      for (const d of deps) if (!Number.isInteger(d) || d < 0 || d >= items.length || d === i) return null
      cleaned.push({ subject, description: String(p.description || '').trim(), activeForm: String(p.activeForm || '').trim(), dependsOn: deps })
    }
    if (hasCycle(cleaned)) return null
    return cleaned
  }

  return { classify, plan }
}

/** 调一次 LLM；空返回原样重试一次（生产实测：网关偶发数百 ms 返回 200+空 content）。 */
async function callWithEmptyRetry(complete, messages, opts, timeoutMs) {
  try {
    let text = await withTimeout(complete(messages, { temperature: 0, ...opts }), timeoutMs)
    if (!String(text || '').trim()) {
      text = await withTimeout(complete(messages, { temperature: 0, ...opts }), timeoutMs)
      if (!String(text || '').trim()) return { error: 'triage_empty' }
    }
    return { text: String(text) }
  } catch (e) {
    return { error: `triage_failed:${e?.message || e}` }
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
    lines.push('【本条消息附带的文件】（把需要用到的路径写进对应子任务的 description）')
    for (const a of attachments) lines.push(`- ${a.name || '未命名'}：${a.path || '路径不可用'}`)
    lines.push('')
  }
  lines.push('【用户消息】')
  lines.push(String(text || '（无文字，只发了附件）'))
  return lines.join('\n')
}

function parseLooseJson(raw) {
  const t = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = t.search(/[{[]/)
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'))
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

function snippet(raw) {
  return String(raw || '').slice(0, 120).replace(/\s+/g, ' ')
}

function hasCycle(plan) {
  const state = new Array(plan.length).fill(0)
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

/** 超时定时器不 unref、结算即清（unref 定时器在事件循环空时永不触发，
 * LLM 连接悬死时降级路径走不到——2026-09-18 实测修复）。 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`triage timeout ${ms}ms`)), ms)
    promise.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}
