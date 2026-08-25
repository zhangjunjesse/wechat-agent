import OpenAI from 'openai'
import { Agent, OpenAIChatCompletionsModel, run } from '@openai/agents'
import { SessionStore } from '../services/session-store.mjs'

export class AgentsSdkAgent {
  #agent
  #sessions
  #historyProvider
  constructor({ model, baseUrl = 'https://api.openai.com/v1', apiKey = process.env.OPENAI_API_KEY, historyProvider = null, sessionStore = null }) {
    const sdkModel = new OpenAIChatCompletionsModel(new OpenAI({ apiKey, baseURL: baseUrl }), model)
    this.#agent = new Agent({ name: '微信个人助手', model: sdkModel, instructions: '你是中文微信个人助手。回答简洁、准确；已提供聊天记录时，严格区分用户本人、群成员和@用户消息。' })
    this.#historyProvider = historyProvider
    this.#sessions = sessionStore || new SessionStore({ file: process.env.SESSIONS_FILE || 'data/sessions.db' })
  }
  async respond({ userId, text, profile }) {
    if (!profile?.nickname && !profile?.wxid) return { text: '请先完成身份验证。请在网页中添加微信“助手”，并向助手发送页面显示的验证码。验证通过后，我才能为你提供服务。' }
    const { summary, messages: history } = this.#sessions.get(userId)
    const records = await this.#historyProvider?.(userId, profile) || []
    const context = [
      `用户昵称：${profile?.nickname || '未知'}`,
      `用户wxid：${profile?.wxid || '未知'}`,
      summary ? `此前对话要点：\n${summary}` : '',
      '相关微信记录：',
      ...records.map((r) => `[${r.chat || '微信'}][${r.sender_display || ''}] ${r.content || ''}`),
    ].filter(Boolean).join('\n')
    const result = await run(this.#agent, [{ role: 'system', content: context }, ...history, { role: 'user', content: text }])
    const answer = typeof result.finalOutput === 'string' ? result.finalOutput : String(result.finalOutput || '')
    this.#sessions.append(userId, text, answer)
    return { text: answer }
  }
}
