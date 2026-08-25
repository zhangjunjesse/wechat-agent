import { estimateMessagesTokens } from '../services/tokenizer.mjs'

/** Folding policy + summary generation, separated from storage.
 *
 * Mirrors Claude Code's approach:
 *   - trigger by context-occupancy ratio (tokenBudget * threshold), not turns;
 *   - keep the most recent `keepTurns` turns verbatim;
 *   - fold the older turns into an LLM summary and re-inject it.
 */
export class SessionCompactor {
  #summarize
  #tokenBudget
  #threshold
  #keepTurns

  constructor({ summarize, tokenBudget = 128_000, threshold = 0.8, keepTurns = 30 } = {}) {
    if (typeof summarize !== 'function') throw new TypeError('summarize is required')
    this.#summarize = summarize
    this.#tokenBudget = tokenBudget
    this.#threshold = threshold
    this.#keepTurns = keepTurns
  }

  get triggerTokens() { return Math.floor(this.#tokenBudget * this.#threshold) }
  get keepTurns() { return this.#keepTurns }

  /** True when the active transcript has grown past the fold threshold. */
  needsFold(transcript) {
    return estimateMessagesTokens(transcript) >= this.triggerTokens
  }

  /** Fold the oldest turns into a summary, keep the recent keepTurns. */
  async fold(transcript, existingSummary = '') {
    if (transcript.length <= this.#keepTurns) {
      return { summary: existingSummary, keptTranscript: [...transcript], folded: false }
    }
    const split = transcript.length - this.#keepTurns
    const oldTurns = transcript.slice(0, split)
    const kept = transcript.slice(split)
    const freshSummary = await this.#summarize(oldTurns)
    const summary = [existingSummary, freshSummary].filter(Boolean).join('\n').slice(-6000)
    return { summary, keptTranscript: kept, folded: true }
  }
}

/** Default summarization prompt for a personal assistant. */
export function buildSummarizePrompt(turns) {
  const text = turns.map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`).join('\n')
  return `请把以下对话历史压缩成一段简洁的要点摘要。只保留会影响后续对话的信息：用户的称呼/偏好、关键事实、用户提出的要求或承诺、尚未完成的待办、已做出的决定。不要概括寒暄和一次性闲聊。\n\n${text.slice(-12000)}\n\n只输出摘要本身，不要解释。`
}
