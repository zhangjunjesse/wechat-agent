/** Approximate token count for mixed Chinese/English text.
 *
 * Not an exact BPE tokenizer — a cheap heuristic is enough for deciding when
 * to fold a session. Chinese ≈ 1 token/char, English ≈ 4 chars/token, other
 * CJK handled as 1 token/char too. Rounds up so the trigger is conservative
 * (folds a little early rather than overflowing the window).
 */
export function estimateTokens(text) {
  const s = String(text || '')
  let tokens = 0
  for (const ch of s) {
    const code = ch.codePointAt(0)
    // CJK, full-width forms, and common ideographic punctuation.
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3000 && code <= 0x30ff) || (code >= 0xff00 && code <= 0xffef)) {
      tokens += 1
    } else if (ch === ' ' || ch === '\n' || ch === '\t') {
      tokens += 0.25
    } else {
      tokens += 0.25
    }
  }
  return Math.max(1, Math.ceil(tokens))
}

export function estimateMessagesTokens(messages) {
  let total = 0
  for (const m of messages || []) {
    // account for role/format overhead per message (~4 tokens)
    total += 4 + estimateTokens(m.content || '')
  }
  return total
}
