import { MemoryStore } from '../services/memory-store.mjs'
import { MemoryExtractor } from './memory-extractor.mjs'

/** Orchestrates the memory lifecycle for one agent:
 *   - recall(userId) -> injectable text block of the user's long-term memories;
 *   - absorb(userId, userText, assistantText) -> extract + upsert/replace.
 * Time awareness is handled by injecting the current date/time and by the
 * cards' timestamps (relative-time reasoning is left to the LLM). */
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

  /** Full recall of a user's memories, formatted for prompt injection. */
  recall(userId) {
    const cards = this.#store.list(userId)
    if (!cards.length) return ''
    const groups = { identity: '身份', preference: '偏好', fact: '事实', todo: '待办' }
    const lines = ['[用户长期记忆]']
    for (const card of cards) {
      const label = groups[card.type] || card.type
      const subject = card.subject === '用户' ? '' : `(${card.relation}:${card.subject})`
      lines.push(`- ${label}: ${card.content}${subject}`)
    }
    return lines.join('\n')
  }

  /** Extract memories from a completed turn and persist them. */
  async absorb(userId, userText, assistantText) {
    let cards = []
    try { cards = await this.#extractor.extract(userText, assistantText) } catch (e) { cards = [] }
    for (const card of cards) {
      if (card.action === 'update') this.#store.replace(userId, card)
      else this.#store.upsert(userId, card)
    }
    return cards.length
  }

  nowLine() {
    const d = this.#now()
    return `今天是 ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}（周${'日一二三四五六'[d.getDay()]}）。`
  }
}
