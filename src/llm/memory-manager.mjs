import { MemoryStore } from '../services/memory-store.mjs'
import { MemoryExtractor } from './memory-extractor.mjs'
import { estimateTokens } from '../services/tokenizer.mjs'

export class MemoryManager {
  #store; #extractor; #now; #maxRecallTokens
  constructor({ store = new MemoryStore(), extractor, now = () => new Date(), maxRecallTokens = 6000 }) {
    if (!extractor) throw new TypeError('extractor is required')
    this.#store = store; this.#extractor = extractor; this.#now = now; this.#maxRecallTokens = maxRecallTokens
  }
  recall(userId) {
    const cards = this.#store.list(userId)
    if (!cards.length) return ''
    cards.sort((a, b) => memoryPriority(b) - memoryPriority(a) || b.updatedAt - a.updatedAt)
    const labels = { identity: '身份', preference: '偏好', fact: '事实', todo: '待办' }
    const lines = ['[用户长期记忆]']
    for (const card of cards) {
      const label = labels[card.category] || card.category
      const subject = card.subject === '用户' ? '' : `(${card.relation}:${card.subject})`
      const extra = card.category === 'todo' && card.due ? `【截止 ${fmtDate(card.due)}，${relativeDue(card.due, this.#now())}】` : ''
      const line = `- ${label}: ${card.content}${subject}${extra}`
      if (estimateTokens([...lines, line].join('\n')) <= this.#maxRecallTokens) lines.push(line)
    }
    return lines.join('\n')
  }
  async absorb(userId, userText, assistantText) {
    let cards = []
    try { cards = await this.#extractor.extract(userText, assistantText, this.#now(), this.#store.list(userId)) } catch (e) { cards = [] }
    for (const card of cards) card.action === 'update' ? this.#store.update(userId, card) : this.#store.insert(userId, card)
    return cards.length
  }
  nowLine() { const d = this.#now(); return `今天是 ${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}（周${'日一二三四五六'[d.getDay()]}）。` }
}
function memoryPriority(card) { return card.category === 'identity' ? 4 : card.category === 'todo' ? 3 : card.category === 'preference' ? 2 : 1 }
export function fmtDate(ms) { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }
export function relativeDue(dueMs, now = new Date()) { const a = new Date(dueMs); const b = new Date(now.getTime()); a.setHours(0,0,0,0); b.setHours(0,0,0,0); const n = Math.round((a-b)/86400000); return n < 0 ? `已过期 ${-n} 天` : n === 0 ? '今天到期' : n === 1 ? '明天到期' : `还剩 ${n} 天` }
