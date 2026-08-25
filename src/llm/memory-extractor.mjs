/** Extracts long-term memories from a conversation turn using the LLM.
 *
 * The model is asked to return a JSON array of memory cards, each of which
 * either `adds` a new fact or `updates` an existing one (conflict resolution).
 * The extractor itself is provider-agnostic: it receives a `complete` function
 * that takes messages and returns text, so both agents can reuse it.
 */
export class MemoryExtractor {
  #complete
  constructor({ complete }) {
    if (typeof complete !== 'function') throw new TypeError('complete is required')
    this.#complete = complete
  }

  /** Parse the user turn (with the assistant reply for context) into cards. */
  async extract(userText, assistantText) {
    const prompt = buildExtractPrompt(userText, assistantText)
    const raw = await this.#complete([{ role: 'user', content: prompt }], { temperature: 0, maxTokens: 600 })
    return parseCards(raw)
  }
}

export function buildExtractPrompt(userText, assistantText) {
  return `你是一个记忆提取器。从下面这轮对话中，提取值得长期记住的、关于用户的信息。

只提取这四类：
- identity：用户身份信息（名字、称呼、职业、账号、会员号等）
- preference：用户长期偏好（喜欢/不喜欢、习惯）
- fact：关于用户的稳定事实（拥有的物品、家庭成员、健康情况等）
- todo：用户的待办事项或计划

每条记忆格式：
{"action":"add"|"update","type":"...","subject":"这条信息的主体(默认'用户')","relation":"与用户的关系(默认'本人')","content":"简洁的事实"}

规则：
1. 无值得长期记住的信息时，返回空数组 []。
2. 寒暄、一次性的闲聊不要提取。
3. 如果新信息与旧信息矛盾，用 "action":"update" 表示更新（同一 type+subject 会覆盖）。
4. 只输出 JSON 数组，不要任何解释或多余文字。

对话：
用户：${userText}
助手：${assistantText}

输出：`
}

/** Safely parse the model's JSON output into an array of card dicts. */
export function parseCards(raw) {
  const text = String(raw || '').trim()
  if (!text) return []
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end < 0 || end <= start) return []
  try {
    const arr = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(arr)) return []
    const cards = []
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue
      const type = String(item.type || '').toLowerCase()
      if (!['identity', 'preference', 'fact', 'todo'].includes(type)) continue
      const content = String(item.content || '').trim()
      if (!content) continue
      cards.push({
        action: item.action === 'update' ? 'update' : 'add',
        type,
        subject: String(item.subject || '用户').trim() || '用户',
        relation: String(item.relation || '本人').trim() || '本人',
        content,
        context: `用户说：${String(item.content || '').slice(0, 200)}`,
      })
    }
    return cards
  } catch (e) {
    return []
  }
}
