import OpenAI from 'openai'
import { wrapClientForDeepSeek } from '../src/llm/deepseek-thinking-client.mjs'

const raw = new OpenAI({ apiKey: process.env.DS_KEY, baseURL: 'https://api.deepseek.com/v1' })
const { client, reset } = wrapClientForDeepSeek(raw)

const tools = [{
  type: 'function',
  function: {
    name: 'gzh_search',
    description: '搜索微信公众号文章列表（关键词不超过10字符）',
    parameters: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] },
  },
}]

reset()
const messages = [{ role: 'user', content: '帮我搜一下苹果发布会内容' }]
let toolRounds = 0
for (let i = 0; i < 4; i++) {
  const r = await client.chat.completions.create({ model: 'deepseek-flash', messages, tools })
  const m = r.choices[0].message
  console.log(`turn ${i}: finish=${r.choices[0].finish_reason} reasoning=${(m.reasoning_content || '').length}ch content=${JSON.stringify((m.content || '').slice(0, 30))} tools=${m.tool_calls?.length || 0}`)
  messages.push(m)
  const tc = m.tool_calls
  if (!tc || !tc.length) break
  toolRounds++
  for (const t of tc) {
    messages.push({ role: 'tool', tool_call_id: t.id, content: '搜到3篇文章：苹果秋季发布会9月10日举行，iPhone 17系列发布' })
  }
}
console.log(toolRounds > 0 ? 'PASS: multi-turn tool calls OK with reasoning_content round-trip' : 'PASS: single turn OK')
