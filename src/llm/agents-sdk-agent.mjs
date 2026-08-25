import OpenAI from 'openai'
import { Agent, OpenAIChatCompletionsModel, run } from '@openai/agents'
import { SessionStore } from '../services/session-store.mjs'
import { MemoryStore } from '../services/memory-store.mjs'
import { SessionCompactor, buildSummarizePrompt } from './session-compactor.mjs'
import { MemoryExtractor } from './memory-extractor.mjs'
import { MemoryManager } from './memory-manager.mjs'

export class AgentsSdkAgent {
  #agent
  #sessions
  #compactor
  #llm
  #memory

  constructor({ model, baseUrl = 'https://api.openai.com/v1', apiKey = process.env.OPENAI_API_KEY, sessionStore = null, memoryStore = null, tokenBudget = 128_000, threshold = 0.8, keepTurns = 30 }) {
    const client = new OpenAI({ apiKey, baseURL: baseUrl })
    this.#llm = client
    const sdkModel = new OpenAIChatCompletionsModel(client, model)
    this.#agent = new Agent({ name: '微信个人助手', model: sdkModel, instructions: '你是中文微信个人助手。回答简洁、准确；已提供聊天记录时，严格区分用户本人、群成员和@用户消息。' })
    this.#sessions = sessionStore || new SessionStore({ file: process.env.SESSIONS_FILE || 'data/sessions.db' })
    this.#compactor = new SessionCompactor({ summarize: async (turns) => this.#summarize(turns), tokenBudget, threshold, keepTurns })
    this.#memory = new MemoryManager({ store: memoryStore || new MemoryStore({ file: process.env.MEMORIES_FILE || 'data/memories.db' }), extractor: new MemoryExtractor({ complete: (messages, opts) => this.#complete(messages, opts) }) })
  }

  async #summarize(turns) {
    try {
      const resp = await this.#llm.chat.completions.create({ model: process.env.OPENAI_MODEL || 'deepseek-chat', messages: [{ role: 'user', content: buildSummarizePrompt(turns) }], temperature: 0, max_tokens: 800 })
      return (resp.choices?.[0]?.message?.content || '').trim()
    } catch (e) { return '' }
  }

  async #complete(messages, { temperature = 0, maxTokens = 600 } = {}) {
    const resp = await this.#llm.chat.completions.create({ model: process.env.OPENAI_MODEL || 'deepseek-chat', messages, temperature, max_tokens: maxTokens })
    return (resp.choices?.[0]?.message?.content || '').trim()
  }

  async respond({ userId, text, profile }) {
    if (!profile?.nickname && !profile?.wxid) return { text: '请先完成身份验证。请在网页中添加微信“助手”，并向助手发送页面显示的验证码。验证通过后，我才能为你提供服务。' }
    const session = this.#sessions.get(userId)
    // WeChat history is intentionally not injected by default. It will be
    // exposed later as an explicit Agent tool to avoid leaking irrelevant data.
    const memories = this.#memory.recall(userId)
    const context = [
      `用户昵称：${profile?.nickname || '未知'}`,
      `用户wxid：${profile?.wxid || '未知'}`,
      this.#memory.nowLine(),
      memories,
      session.summary ? `此前对话要点：\n${session.summary}` : '',
    ].filter(Boolean).join('\n')
    const result = await run(this.#agent, [{ role: 'system', content: context }, ...session.transcript, { role: 'user', content: text }])
    const answer = typeof result.finalOutput === 'string' ? result.finalOutput : String(result.finalOutput || '')

    // 1) fold session if over token threshold
    let { transcript } = this.#sessions.append(userId, text, answer)
    if (this.#compactor.needsFold(transcript)) {
      const folded = await this.#compactor.fold(transcript, session.summary)
      this.#sessions.fold(userId, folded.summary, folded.keptTranscript)
    }
    // 2) extract long-term memories (best-effort, non-blocking to the reply)
    this.#memory.absorb(userId, text, answer).catch(() => {})
    return { text: answer }
  }
}
