/** 错误对用户的呈现 + 可重试性判定——统一收口点（2026-09-18 事故整改，第 2/3 件事）。
 *
 * 背景：`message-router.mjs`/`group-command-watcher.mjs` 此前各自把
 * `agent.respond()` 抛出的原始异常（如 LLM 网关 `402 litellm.APIError:
 * ...账户余额不足或未开通套餐...`）直接拼进回复发给用户——技术报错、中英文
 * 夹杂，用户根本看不懂也没法处理，还被用户吐槽"很不友好"。同一批事故里，
 * `task-scheduler.mjs` 的报告/日报生成失败重试是"不分青红皂白"的：402/401
 * 这类"重试也没用"的错误，和 429/5xx/网络超时这类"重试大概率会好"的错误，
 * 被同样按 `retryMax` 机械重试——账户余额没充值前，重试只会原地烧 retryMax
 * 次日志，不解决任何问题（ADR-0026/0028 的重试机制默认"失败=值得重试"，
 * 没有对错误类型分类）。
 *
 * 本模块被 `message-router.mjs`/`group-command-watcher.mjs`（用户主动对话
 * 失败的文案+日志）和 `task-scheduler.mjs`（定时任务生成失败的重试判定）
 * 共用，避免"改了一处、另一处没同步"的分裂（历史教训见 ADR-0026 对
 * `get_daily_report`/`resend_daily_report` 分工不清的复盘）。 */

// 不可重试：账户/鉴权/参数问题，立刻重试大概率还是同样的结果，只会浪费
// LLM 调用配额和重试预算——402 正是 2026-09-18 事故的直接触发点。
const NON_RETRYABLE_PATTERNS = [
  /\b402\b/, /余额不足|insufficient balance|未开通套餐|insufficient_quota/i,
  /\b401\b/, /unauthorized|invalid api key|鉴权失败|authentication/i,
  /\b400\b/, /invalid_request|bad request|参数错误/i,
]
// 可重试：限流/网关抖动/网络超时，等一等大概率会自愈。
const RETRYABLE_PATTERNS = [
  /\b429\b/, /rate ?limit|too many requests/i,
  /\b5\d\d\b/, // 500-599
  /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network/i,
]

/** 该错误值不值得按 ADR-0026/0028 的重试节奏再试一次。
 * 未识别的错误类型默认按"可重试"处理（维持既有保守策略：宁可多试几次，
 * 也不要把一个没见过的错误误判成"不用重试"而白白放弃）。 */
export function isRetryableError(error) {
  const msg = String(error?.message || error || '')
  if (NON_RETRYABLE_PATTERNS.some((re) => re.test(msg))) return false
  if (RETRYABLE_PATTERNS.some((re) => re.test(msg))) return true
  return true
}

/** 完整错误（含 stack）记进服务端日志——不给用户看不代表排查不需要它。 */
export function logServerError(scope, error, extra = {}) {
  const detail = error?.stack || error?.message || String(error)
  const extraStr = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ''
  console.error(`[${scope}]${extraStr} ${detail}`)
}

/** 用户主动对话时失败的口语化文案（不训导、不复述技术细节）。
 * 按是否可重试稍作区分——可重试的更像"临时卡顿"，不可重试的更像"这功能
 * 现在用不了"，但两者都不出现任何错误码/英文报错原文。 */
export function friendlyChatErrorText(error) {
  return isRetryableError(error)
    ? '⚠️ 我这边刚才处理时卡了一下，稍等我再试一次；要是连着几次都不行，麻烦把这句话发给我一次。'
    : '⚠️ 我这边的服务暂时用不了，看起来不是你这边的问题，我已经记下来了，过一会儿再试试，或者先做点别的。'
}

/** 生成结果是否"看起来像没解析成功、原样漏出来的结构化 JSON"（而不是模型
 * 说的一句人话，比如"抱歉今天没有合适的新闻"）——绝不能把这种内容直接当
 * 推送文案发给用户（2026-09-18 事故：用户收到一整段 `{"focus":...,"items":
 * [...]}` 原文）。启发式：去掉前导自然语言后，很快（20 字内）出现 `{`/`[`，
 * 且带典型的带引号 JSON 字段名——纯粹的"抱歉"式道歉文本不会命中。 */
export function looksLikeRawJsonPayload(text) {
  const t = String(text || '').trim()
  if (!t) return false
  const start = t.search(/[{[]/)
  if (start === -1 || start > 20) return false
  return /"[A-Za-z_][A-Za-z0-9_]*"\s*:/.test(t)
}
