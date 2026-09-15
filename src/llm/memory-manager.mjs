import { MemoryStore } from '../services/memory-store.mjs'
import { MemoryExtractor } from './memory-extractor.mjs'
import { estimateTokens } from '../services/tokenizer.mjs'
import { beijingDateStr, beijingMidnight, beijingNowLine } from '../services/time.mjs'
import { pruneTodos } from '../services/memory-pruner.mjs'

export class MemoryManager {
  #store; #extractor; #now; #maxRecallTokens
  constructor({ store = new MemoryStore(), extractor, now = () => new Date(), maxRecallTokens = 6000 }) {
    if (!extractor) throw new TypeError('extractor is required')
    this.#store = store; this.#extractor = extractor; this.#now = now; this.#maxRecallTokens = maxRecallTokens
  }
  get store() { return this.#store }
  /** Recalled memories, sectioned by category (身份/偏好/事实/待办) so the model
   * can locate facts faster, with a hard token cap.
   *
   * 只注入 active 卡片（归档/合并卡不再出现），并在注入后回写访问统计——
   * 这是第一层评分里 frequency 因子的唯一来源（DESIGN-memory-lifecycle §4.7）。 */
  recall(userId) {
    const cards = this.#store.listActive(userId)
    if (!cards.length) return ''
    const sections = [
      { category: 'identity', label: '身份' },
      { category: 'preference', label: '偏好' },
      { category: 'fact', label: '事实' },
      { category: 'todo', label: '待办' },
    ]
    const lines = ['[用户长期记忆]']
    const injected = []
    for (const section of sections) {
      let group = cards.filter((c) => c.category === section.category)
      // 助手命名由 assistantName() 单独承载，不在记忆正文重复展示，避免两处冲突
      if (section.category === 'identity') group = group.filter((c) => c.subject !== '助手')
      group.sort((a, b) => b.updatedAt - a.updatedAt)
      if (!group.length) continue
      const header = `【${section.label}】`
      if (estimateTokens([...lines, header].join('\n')) > this.#maxRecallTokens) break
      lines.push(header)
      for (const card of group) {
        const line = cardLine(card, this.#now())
        if (estimateTokens([...lines, line].join('\n')) > this.#maxRecallTokens) break
        lines.push(line)
        injected.push(card.id)
      }
    }
    if (injected.length) {
      try { this.#store.markAccessed(userId, injected, this.#now().getTime()) } catch (e) { /* 统计失败不影响召回 */ }
    }
    return lines.join('\n')
  }
  /** 助手的自称名，单一来源：记忆里用户设定的命名（identity / subject=助手），
   * 没有则回退默认 '助手'。不再有第二个来源（避免与系统提示词硬编码冲突）。 */
  assistantName(userId) {
    const cards = this.#store.list(userId)
      .filter((c) => c.category === 'identity' && c.subject === '助手')
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const latest = cards[0]
    if (!latest) return '助手'
    const m = String(latest.content || '').match(/助手(?:命名为|改名为|叫|名为)(.+)/)
    return m ? m[1].trim().replace(/[，。,.!！?？\s]/g, '') : '助手'
  }
  async absorb(userId, userText, assistantText) {
    let cards = []
    try { cards = await this.#extractor.extract(userText, assistantText, this.#now(), this.#store.listActive(userId)) } catch (e) { cards = [] }
    for (const card of cards) card.action === 'update' ? this.#store.update(userId, card) : this.#store.insert(userId, card)
    // 轻量维护（DESIGN-memory-lifecycle §4.6）：todo 过期/老化 → 归档（不物理删除）。
    // 放在 absorb 的异步链里，既不阻塞用户回复，也不引入 LLM 调用。
    try { pruneTodos(this.#store, userId, this.#now().getTime()) } catch (e) { /* 清理失败不影响本轮记忆写入 */ }
    return cards.length
  }
  nowLine() { return beijingNowLine(this.#now().getTime()) }
}

function cardLine(card, now) {
  const subject = card.subject === '用户' ? '' : `(${card.relation}:${card.subject})`
  const extra = card.category === 'todo' && card.due ? `【截止 ${fmtDate(card.due)}，${relativeDue(card.due, now)}】` : ''
  return `- ${card.content}${subject}${extra}`
}

export function fmtDate(ms) { return beijingDateStr(ms) }

export function relativeDue(dueMs, now = new Date()) {
  const a = beijingMidnight(dueMs)
  const b = beijingMidnight(now)
  const n = Math.round((a - b) / 86400000)
  return n < 0 ? `已过期 ${-n} 天` : n === 0 ? '今天到期' : n === 1 ? '明天到期' : `还剩 ${n} 天`
}
