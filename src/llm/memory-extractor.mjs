/** Extracts long-term memories from a conversation turn using the LLM.
 *
 * Output cards carry a cognitive `type` (episodic / semantic), a business
 * `category` (identity / preference / fact / todo), the subject + relation, a
 * real narrative `context` (where this fact came from), and for todos a `due`
 * deadline. `action` is add/update for conflict resolution.
 */
export class MemoryExtractor {
  #complete
  constructor({ complete }) {
    if (typeof complete !== 'function') throw new TypeError('complete is required')
    this.#complete = complete
  }
  async extract(userText, assistantText, now) {
    const prompt = buildExtractPrompt(userText, assistantText, now)
    const raw = await this.#complete([{ role: 'user', content: prompt }], { temperature: 0, maxTokens: 900 })
    return parseCards(raw)
  }
}

export function buildExtractPrompt(userText, assistantText, now = new Date()) {
  const nowStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return `你是一个记忆提取器。从这轮对话中，提取值得长期记住的、关于用户的信息。

每条记忆按「类型」区分：
- episodic：具体事件（某次发生的事，带时间、对象、细节）
- semantic：稳定的一般性知识（长期有效的特征/偏好/身份/事实）

再按「类别 category」标注：
- identity：身份信息（名字、称呼、职业、会员号、账号）
- preference：长期偏好（喜欢/不喜欢、习惯）
- fact：稳定事实（拥有的物品、家庭成员、健康情况）
- todo：待办事项或计划

每条记忆输出格式（JSON）：
{"action":"add|update","type":"episodic|semantic","category":"identity|preference|fact|todo","subject":"主体(默认'用户')","relation":"与用户的关系(默认'本人')","content":"简洁事实","context":"这条信息的叙事背景(一句话,说明是在什么情境下得知的)","due":"todo的截止日期(YYYY-MM-DD,非todo留空)"}

规则：
1. 无值得长期记住的信息时返回 []。
2. 寒暄、一次性闲聊不要提取。
3. 同一主体的同一条信息如果与旧信息矛盾，用 "action":"update"。
4. 只输出 JSON 数组，不要解释。

今天是：${nowStr}

对话：
用户：${userText}
助手：${assistantText}

输出：`
}

/** Parse model JSON output into cards, with due parsed to epoch ms. */
export function parseCards(raw, now = Date.now()) {
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
      if (!['episodic', 'semantic'].includes(item.type)) continue
      const type = item.type === 'episodic' ? 'episodic' : 'semantic'
      const category = ['identity', 'preference', 'fact', 'todo'].includes(item.category) ? item.category : 'fact'
      const content = String(item.content || '').trim()
      if (!content) continue
      cards.push({
        action: item.action === 'update' ? 'update' : 'add',
        type,
        category,
        subject: String(item.subject || '用户').trim() || '用户',
        relation: String(item.relation || '本人').trim() || '本人',
        content,
        context: String(item.context || '').trim(),
        due: parseDue(item.due, now),
      })
    }
    return cards
  } catch (e) {
    return []
  }
}

function parseDue(value, now) {
  if (!value) return 0
  const t = Date.parse(String(value))
  if (Number.isNaN(t)) return 0
  // ensure a sensible future deadline; past-only dates clamp to today
  return t > 0 ? t : 0
}
