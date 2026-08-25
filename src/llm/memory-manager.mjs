import { MemoryStore } from '../services/memory-store.mjs'
import { MemoryExtractor } from './memory-extractor.mjs'

/** Orchestrates the memory lifecycle for one agent:
 *   - recall(userId) -> injectable text block (with time-awareness on todos);
 *   - absorb(userId, userText, assistantText) -> extract + persist.
 */
export class MemoryManager {
  #store
  #extractor
  #now

  constructor({ store = new MemoryStore(), extractor, now = () => new Date() }) {
    if (!extractor) throw new TypeError('extractor is required')
    this.#store = store
    this.#extractor = extractor
    this.#now = now
  }

  /** Full recall of a user's memories, formatted for prompt injection.
   * Todos get relative-time annotations (e.g. "还剩 3 天"). */
  recall(userId) {
    const cards = this.#store.list(userId)
    if (!cards.length) return ''
    const catLabel = { identity: '身份', preference: '偏好', fact: '事实', todo: '待办' }
    const lines = ['[用户长期记忆]']
    for (const card of cards) {
      const label = catLabel[card.category] || card.category
      const subject = card.subject === '用户' ? '' : `(${card.relation}:${card.subject})`
      let extra = ''
      if (card.category === 'todo' && card.due) {
        extra = `【截止 ${fmtDate(card.due)}，${relativeDue(card.due, this.#now())}】`
      }
      lines.push(`- ${label}: ${card.content}${subject}${extra}`)
    }
    return lines.join('\n')
  }

  async absorb(userId, userText, assistantText) {
    let cards = []
    try { cards = await this.#extractor.extract(userText, assistantText, this.#now()) } catch (e) { cards = [] }
    for (const card of cards) {
      if (card.action === 'update') this.#store.update(userId, card)
      else this.#store.insert(userId, card)
    }
    return cards.length
  }

  nowLine() {
    const d = this.#now()
    return `今天是 ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}（周${'日一二三四五六'[d.getDay()]}）。`
  }
}

export function fmtDate(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function relativeDue(dueMs, now = new Date()) {
  const dueDay = new Date(dueMs); dueDay.setHours(0, 0, 0, 0)
  const nowDay = new Date(now.getTime()); nowDay.setHours(0, 0, 0, 0)
  const diffDays = Math.round((dueDay.getTime() - nowDay.getTime()) / 86400000)
  if (diffDays < 0) return `已过期 ${-diffDays} 天`
  if (diffDays === 0) return '今天到期'
  if (diffDays === 1) return '明天到期'
  return `还剩 ${diffDays} 天`
}
