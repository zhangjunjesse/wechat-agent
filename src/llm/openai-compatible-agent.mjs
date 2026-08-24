export class OpenAICompatibleAgent {
  #fetch
  #baseUrl
  #apiKey
  #model
  #history = new Map()
  #context
  constructor({ fetchImpl = globalThis.fetch, baseUrl = 'https://api.openai.com/v1', apiKey = process.env.OPENAI_API_KEY, model = 'gpt-4o-mini', contextProvider = null } = {}) {
    if (typeof fetchImpl !== 'function' || !apiKey) throw new TypeError('fetchImpl and apiKey are required')
    this.#fetch = fetchImpl; this.#baseUrl = baseUrl.replace(/\/$/, ''); this.#apiKey = apiKey; this.#model = model; this.#context = contextProvider
  }
  async respond({ userId, text }) {
    const history = this.#history.get(userId) || []
    const context = await this.#context?.(userId)
    const system = `你是一个微信个人助手。请用中文简洁回答。当前用户昵称：${context?.nickname || '未知'}，微信wxid：${context?.wxid || '未知'}。如需使用聊天记录，先按昵称/wxid识别用户本人消息，并明确区分本人发送与@用户内容。`
    const messages = [{ role: 'system', content: system }, ...history.slice(-20), { role: 'user', content: text }]
    const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` }, body: JSON.stringify({ model: this.#model, messages, temperature: 0.3 }) })
    if (!response.ok) throw new Error(`LLM request failed: ${response.status}`)
    const data = await response.json(); const answer = data.choices?.[0]?.message?.content?.trim() || '暂时无法生成回复。'
    this.#history.set(userId, [...messages.filter((m) => m.role !== 'system'), { role: 'assistant', content: answer }])
    return { text: answer }
  }
}
