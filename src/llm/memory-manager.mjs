import { MemoryStore } from '../services/memory-store.mjs'
import { MemoryExtractor } from './memory-extractor.mjs'
import { estimateTokens } from '../services/tokenizer.mjs'
import { beijingDateStr, beijingMidnight, beijingNowLine } from '../services/time.mjs'

export class MemoryManager {
  #store; #extractor; #now; #maxRecallTokens
  constructor({ store = new MemoryStore(), extractor, now = () => new Date(), maxRecallTokens = 6000 }) {
    if (!extractor) throw new TypeError('extractor is required')
    this.#store = store; this.#extractor = extractor; this.#now = now; this.#maxRecallTokens = maxRecallTokens
  }
  get store() { return this.#store }
  /** Recalled memories, sectioned by category (身份/偏好/事实/待办) so the model
   * can locate facts faster, with a hard token cap. */
  recall(userId) {
    const cards = this.#store.list(userId)
    if (!cards.length) return ''
    const sections = [
      { category: 'identity', label: '身份' },
      { category: 'preference', label: '偏好' },
      { category: 'fact', label: '事实' },
      { category: 'todo', label: '待办' },
    ]
    const lines = ['[用户长期记忆]']
    for (const section of sections) {
      const group = cards.filter((c) => c.category === section.category).sort((a, b) => b.updatedAt - a.updatedAt)
      if (!group.length) continue
      const header = `【${section.label}】`
      if (estimateTokens([...lines, header].join('\n')) > this.#maxRecallTokens) break
      lines.push(header)
      for (const card of group) {
        const line = cardLine(card, this.#now())
        if (estimateTokens([...lines, line].join('\n')) > this.#maxRecallTokens) break
        lines.push(line)
      }
    }
    return lines.join('\n')
  }
  async absorb(userId, userText, assistantText) {
    let cards = []
    try { cards = await this.#extractor.extract(userText, assistantText, this.#now(), this.#store.list(userId)) } catch (e) { cards = [] }
    for (const card of cards) card.action === 'update' ? this.#store.update(userId, card) : this.#store.insert(userId, card)
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
