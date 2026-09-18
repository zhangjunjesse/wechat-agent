/** 有界的 JSON 修复（2026-09-18 事故第 2 件整改，ADR-0035）。
 *
 * 目标只有一种形态：模型输出的 JSON 里，字符串值内部出现了**未转义的双引号**
 * ——如 `"title":"Anthropic把Claude Cowork与chat合并为"一个Claude""`——导致
 * `JSON.parse` 在该位置提前把字符串截断，抛 `Expected ',' or '}' after
 * property value`。
 *
 * 明确不做的事（避免"自制 JSON 解析器"）：
 * - 不构建 AST、不理解嵌套对象/数组的语义，只做一次线性字符扫描定位字符串边界；
 * - 只在 `JSON.parse` 已经失败之后才尝试，且只尝试一次。
 *
 * ⚠️ 安全保证在哪一层（**别记错，这是唯一的护栏**）：二次 `JSON.parse` 校验在
 * `tryParseWithRepair()` 里，**不在** `repairUnescapedQuotes()` 里。
 * `repairUnescapedQuotes()` 是纯字符串变换，对纯乱码输入同样会返回一个（没用的）
 * 字符串，**它自己不做任何校验、永远不返回 null**。所以调用方一律用
 * `tryParseWithRepair()`；直接调 `repairUnescapedQuotes()` 拿不到任何保护。
 * 实测（2026-09-18）：截断 JSON / 多余逗号 / 纯乱码 / 歧义引号四类输入，
 * `repairUnescapedQuotes()` 都返回非 null，全靠 `tryParseWithRepair()` 的二次
 * 校验挡下来，最终 `ok:false`——失败方向是"丢掉这份报告"，不是"发出一份被改坏
 * 内容的报告"。
 *
 * 启发式：逐字符扫描，进入字符串后每遇到一个引号，向后跳过空白看下一个非空白
 * 字符——如果是 `,` `}` `]` `:` 之一（或已到末尾），判定这是字符串的真实
 * 结束引号；否则判定这是字符串内部一个"忘了转义"的引号，补上反斜杠继续留在
 * 字符串状态里。这个启发式是"启发式，不是语义分析"（与 failure-messaging.mjs
 * 的 looksLikeRawJsonPayload 同一类保守取舍）：理论上存在"内容本身就以逗号/
 * 冒号开头"这种边界会被误判，但那种情况下修复后大概率仍然通不过 JSON.parse，
 * 会被下面的二次校验挡住，不会产出看似合法实则错误的数据。 */

const TERMINATOR_CHARS = new Set([',', '}', ']', ':'])

/** 修复字符串值内部未转义的双引号。只做字符级转写，不解析结构。 */
export function repairUnescapedQuotes(text) {
  const src = String(text || '')
  let out = ''
  let inString = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (!inString) {
      out += ch
      if (ch === '"') inString = true
      continue
    }
    if (ch === '\\') { out += ch + (src[i + 1] ?? ''); i++; continue }
    if (ch === '"') {
      let j = i + 1
      while (j < src.length && /\s/.test(src[j])) j++
      const next = src[j]
      if (next === undefined || TERMINATOR_CHARS.has(next)) { inString = false; out += ch; continue }
      out += '\\"' // 不像终止符：视为字符串内部忘了转义的引号
      continue
    }
    out += ch
  }
  return out
}

/** `JSON.parse(jsonSlice)` 已经失败后尝试一次有界修复；修复后仍不能 parse、
 * 或者根本没有可修的地方（修复结果和原文一字不差，说明问题不是这种形态）
 * 都返回 null——调用方应照旧走 `ok:false`，不能把 null 硬凑成一个结果。 */
export function tryParseWithRepair(jsonSlice) {
  const repaired = repairUnescapedQuotes(jsonSlice)
  if (repaired === jsonSlice) return null
  try { return JSON.parse(repaired) } catch { return null }
}
