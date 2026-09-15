// 临时测试：新设计 prompt 跑 Z.俊 完整历史，模拟真实 absorb 逐轮累积，输出最终记忆库。
// docker cp 进 wechat-agent 容器 /app，docker exec -w /app node tmp-extract-full.mjs
import { MemoryStore } from './src/services/memory-store.mjs'
import { parseCards } from './src/llm/memory-extractor.mjs'
import OpenAI from 'openai'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'

const USER = process.env.TEST_USER || 'o9cq80wXtSkIXBJDDLCggTI4WQPY@im.wechat'
const MODEL = process.env.OPENAI_MODEL || 'deepseek-flash'
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL })
const NOW = new Date('2026-09-14T04:00:00Z')

const OFF = 8 * 3600 * 1000
function bjDate(ms) { const d = new Date(new Date(ms).getTime() + OFF); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}` }

function buildExtractPromptNew(userText, assistantText, now = new Date(), existingMemories = []) {
  const nowStr = bjDate(now.getTime())
  return `你是一个记忆提取器。从这轮对话中，提取值得长期记住的、关于用户的信息。

【核心判断：值得吗？】提取前先问自己：这条信息 3 天后（或更久）对用户还有用吗？
- 没用（一次性流水账、临时琐事）→ 不提取
- 有用（身份、稳定偏好、影响后续行动的事实/事件）→ 提取

每条记忆按「类型」区分：
- episodic：对未来有影响的具体事件（项目推进会、重要约定、待办产生）。纯流水账（"群里发了张图""某人@了我"）即使发生了也不提取。
- semantic：稳定的一般性知识（长期有效的特征/偏好/身份/事实）

再按「类别 category」标注：
- identity：身份信息（名字、称呼、职业、会员号、账号）
- preference：稳定的做事方式与习惯——不只是"喜欢/不喜欢"，还包括"我习惯先看摘要""文件按 X 格式发我""回复要简洁"这类长期偏好
- fact：稳定事实（拥有的物品、家庭成员、健康情况、参与的项目）
- todo：用户明确要求记住/跟进/完成的事项。只有明确表达"帮我记着/提醒我/跟进/记得做"等意图时才提取；顺带提及（"记得看下群消息"）不算

当用户给助手（你）起名或改名时（例如"以后你就叫小新"），提取为一条 identity 记忆：subject='助手'、relation='助手'、content='助手命名为{名字}'。用户首次明确要求某种称呼时提取为 identity 记忆；此后对话里被称呼/称呼他人不算新信息，不要重复提取。

每条记忆输出格式（JSON）：
{"action":"add|update","type":"episodic|semantic","category":"identity|preference|fact|todo","subject":"主体(默认'用户')","relation":"与用户的关系(默认'本人')","content":"简洁事实","context":"这条信息的叙事背景(一句话,说明是在什么情境下得知的)","due":"todo的截止日期(YYYY-MM-DD,非todo留空)"}

规则：
1. 无值得长期记住的信息时返回 []。
2. 寒暄、一次性闲聊、流水账不提取。
3. 同一主体的同一条信息如果与旧信息矛盾，用 "action":"update"（新信息覆盖旧信息）。
4. todo 有明确截止日期才填 due；没有截止的 todo 也可提取（due 留空），但仅限用户明确要求记住的事项。
5. 只输出 JSON 数组，不要解释。

今天是：${nowStr}

已有相关记忆（用于判断新增还是更新）：
${existingMemories.length ? existingMemories.map((m) => `- [${m.type}/${m.category}] ${m.subject}/${m.relation}: ${m.content}`).join('\n') : '（暂无）'}

对话：
用户：${userText}
助手：${assistantText}

输出：`
}

async function extract(prompt) {
  try {
    const resp = await client.chat.completions.create({ model: MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 900 })
    return parseCards(resp.choices?.[0]?.message?.content || '')
  } catch (e) { return [] }
}

const db = new DatabaseSync('/data/sessions.db')
const row = db.prepare('SELECT transcript FROM sessions WHERE user_id = ?').get(USER)
const t = JSON.parse(row.transcript)

const TEST_DB = '/tmp/test-memories-full.db'
try { fs.rmSync(TEST_DB, { force: true }) } catch (e) {}
const store = new MemoryStore({ file: TEST_DB })

let updated = 0
for (let i = 0; i + 1 < t.length; i += 2) {
  const u = t[i]?.content || ''
  const a = t[i + 1]?.content || ''
  if (!u.trim() || !a.trim()) continue
  const cards = await extract(buildExtractPromptNew(u, a, NOW, store.list(USER)))
  for (const c of cards) {
    if (c.action === 'update') { store.update(USER, c); updated++ } else { store.insert(USER, c) }
  }
  if ((i / 2 + 1) % 20 === 0) console.error(`progress ${i / 2 + 1}/${t.length / 2}`)
}

const cards = store.list(USER)
console.log(`TOTAL ${cards.length} (${updated} updates applied)`)
console.log(JSON.stringify(cards.map((c) => ({ type: c.type, category: c.category, subject: c.subject, relation: c.relation, content: c.content, context: c.context, due: c.due ? new Date(c.due).toISOString().slice(0, 10) : 0 })), null, 1))
