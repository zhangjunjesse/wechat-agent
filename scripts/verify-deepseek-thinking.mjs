import OpenAI from 'openai'
import { wrapClientForDeepSeek } from '../src/llm/deepseek-thinking-client.mjs'

/** 冒烟测试：验证「当前配置的 OPENAI_* 端点/模型」真的支持本仓库对 DeepSeek
 * thinking 模式的假设（reasoning_content 必须原样回传，否则多轮工具调用 400）。
 * 默认读生产同名 env（OPENAI_API_KEY/OPENAI_BASE_URL/OPENAI_MODEL），可退回
 * 旧的 DS_KEY + 官方端点。**换端点/换模型后必须重跑**——这不是一次性验证。 */
const apiKey = process.env.OPENAI_API_KEY || process.env.DS_KEY
const baseURL = process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1'
const model = process.env.OPENAI_MODEL || 'deepseek-flash'
if (!apiKey) { console.error('FAIL: 未设置 OPENAI_API_KEY（或 DS_KEY）'); process.exit(1) }
console.log(`target: baseURL=${baseURL} model=${model}`)

const raw = new OpenAI({ apiKey, baseURL })
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
const messages = [{ role: 'user', content: '帮我搜一下苹果发布会内容，搜完后用一句话总结' }]
let toolRounds = 0
let failed = false
for (let i = 0; i < 4; i++) {
  let r
  try {
    // 首轮强制调用工具（tool_choice），确保真的触发「assistant(tool_calls) → tool
    // → assistant」这条会 400 的路径，而不是靠模型自己决定要不要调工具。
    r = await client.chat.completions.create({ model, messages, tools, ...(i === 0 ? { tool_choice: 'required' } : {}) })
  } catch (e) {
    console.error(`turn ${i}: THROW ${e.message}`)
    failed = true
    break
  }
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
if (failed) { console.log('FAIL: 见上方异常'); process.exit(1) }
if (toolRounds === 0) { console.log('FAIL: 首轮 tool_choice=required 但模型未产生 tool_calls，未测到 reasoning_content 回传路径'); process.exit(1) }
console.log(`PASS: ${toolRounds} 轮工具调用 + reasoning_content 回传均未 400`)
