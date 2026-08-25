import { SessionStore } from '../services/session-store.mjs'
import { MemoryStore } from '../services/memory-store.mjs'
import { SessionCompactor, buildSummarizePrompt } from './session-compactor.mjs'
import { MemoryExtractor } from './memory-extractor.mjs'
import { MemoryManager } from './memory-manager.mjs'

export class OpenAICompatibleAgent {
  #fetch
  #baseUrl
  #apiKey
  #model
  #sessions
  #context
  #historyProvider
  #compactor
  #memory

  constructor({ fetchImpl = globalThis.fetch, baseUrl = 'https://api.openai.com/v1', apiKey = process.env.OPENAI_API_KEY, model = 'gpt-4o-mini', contextProvider = null, historyProvider = null, sessionStore = null, memoryStore = null, tokenBudget = 128_000, threshold = 0.8, keepTurns = 30 } = {}) {
    if (typeof fetchImpl !== 'function' || !apiKey) throw new TypeError('fetchImpl and apiKey are required')
    this.#fetch = fetchImpl; this.#baseUrl = baseUrl.replace(/\/$/, ''); this.#apiKey = apiKey; this.#model = model; this.#context = contextProvider; this.#historyProvider = historyProvider
    this.#sessions = sessionStore || new SessionStore({ file: process.env.SESSIONS_FILE || 'data/sessions.db' })
    this.#compactor = new SessionCompactor({ summarize: async (turns) => this.#summarize(turns), tokenBudget, threshold, keepTurns })
    this.#memory = new MemoryManager({ store: memoryStore || new MemoryStore({ file: process.env.MEMORIES_FILE || 'data/memories.db' }), extractor: new MemoryExtractor({ complete: (messages, opts) => this.#complete(messages, opts) }) })
  }

  async #summarize(turns) {
    try {
      const r = await this.#fetch(`${this.#baseUrl}/chat/completions`, { method: 'POST', headers: this.#headers(), body: JSON.stringify({ model: this.#model, messages: [{ role: 'user', content: buildSummarizePrompt(turns) }], temperature: 0, max_tokens: 800 }) })
      if (!r.ok) return ''
      const d = await r.json(); return (d.choices?.[0]?.message?.content || '').trim()
    } catch (e) { return '' }
  }

  async #complete(messages, { temperature = 0, maxTokens = 600 } = {}) {
    const r = await this.#fetch(`${this.#baseUrl}/chat/completions`, { method: 'POST', headers: this.#headers(), body: JSON.stringify({ model: this.#model, messages, temperature, max_tokens: maxTokens }) })
    if (!r.ok) return ''
    const d = await r.json(); return (d.choices?.[0]?.message?.content || '').trim()
  }

  #headers() {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` }
  }

  async respond({ userId, text, profile }) {
    if (!profile?.nickname && !profile?.wxid) return { text: '请先完成身份验证。请在网页中添加微信“助手”，并向助手发送页面显示的验证码。验证通过后，我才能为你提供服务。' }
    const session = this.#sessions.get(userId)
    const context = await this.#context?.(userId)
    const recentWechat = await this.#historyProvider?.(userId, context) || []
    const historyContext = recentWechat.map((m) => `[${m.chat || '微信'}][${m.sender_display || ''}] ${m.content || ''}`).join('\n')
    const memories = this.#memory.recall(userId)
    const system = `你是一个微信个人助手。请用中文简洁回答。当前用户昵称：${context?.nickname || '未知'}，微信wxid：${context?.wxid || '未知'}。如需使用聊天记录，先按昵称/wxid识别用户本人消息，并明确区分本人发送与@用户内容。\n${this.#memory.nowLine()}\n${memories}\n${session.summary ? '此前对话要点：\n' + session.summary + '\n' : ''}以下是已同步的相关聊天记录：\n${historyContext || '暂无相关记录'}`
    const messages = [{ role: 'system', content: system }, ...session.transcript, { role: 'user', content: text }]
    const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, { method: 'POST', headers: this.#headers(), body: JSON.stringify({ model: this.#model, messages, temperature: 0.3 }) })
    if (!response.ok) throw new Error(`LLM request failed: ${response.status}`)
    const data = await response.json(); const answer = data.choices?.[0]?.message?.content?.trim() || '暂时无法生成回复。'
    let { transcript } = this.#sessions.append(userId, text, answer)
    if (this.#compactor.needsFold(transcript)) {
      const folded = await this.#compactor.fold(transcript, session.summary)
      this.#sessions.fold(userId, folded.summary, folded.keptTranscript)
    }
    this.#memory.absorb(userId, text, answer).catch(() => {})
    return { text: answer }
  }
}
