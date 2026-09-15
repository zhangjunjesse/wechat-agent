import { beijingDateStr, beijingWeekday } from '../services/time.mjs'

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
  async extract(userText, assistantText, now, existingMemories = []) {
    const prompt = buildExtractPrompt(userText, assistantText, now, existingMemories)
    const raw = await this.#complete([{ role: 'user', content: prompt }], { temperature: 0, maxTokens: 900 })
    return parseCards(raw)
  }
}

export function buildExtractPrompt(userText, assistantText, now = new Date(), existingMemories = []) {
  const nowStr = beijingDateStr(now)
  return `你是一个记忆提取器。从这轮对话中，提取值得长期记住的、关于用户的信息。

【核心判断：值得吗？】提取前先问自己：这条信息 3 天后（或更久）对用户还有用吗？
- 没用（一次性流水账、临时琐事）→ 不提取
- 有用（身份、稳定偏好、影响后续行动的事实/事件）→ 提取

每条记忆按「类型」区分：
- episodic：对未来有影响的具体事件（项目推进会、重要约定、待办产生）。纯流水账（"群里发了张图""某人@了我"）即使发生了也不提取。
- semantic：稳定的一般性知识（长期有效的特征/偏好/身份/事实）

再按「类别 category」标注：
- identity：身份信息（名字、称呼、职业、会员号、账号）
- preference：稳定的做事方式与习惯——不只是"喜欢/不喜欢"，还包括交互偏好："回复简短直接、结构化（列表/表格）"、"决策时给多个选项和证据"、"宁可诚实说明能力不足也不要强行变通"、"文件直接发给我而不是只给链接"
- fact：稳定事实（拥有的物品、家庭成员、健康情况、参与的项目）
- todo：用户明确要求记住/跟进/完成的事项。只有明确表达"帮我记着/提醒我/跟进/记得做"等意图时才提取；顺带提及（"记得看下群消息"）不算

当用户给助手（你）起名或改名时（例如"以后你就叫小新"），提取为一条 identity 记忆：subject='助手'、relation='助手'、content='助手命名为{名字}'。用户首次明确要求某种称呼时提取为 identity 记忆；此后对话里被称呼、或称呼他人，都不算新信息，不要重复提取。

每条记忆输出格式（JSON）：
{"action":"add|update","type":"episodic|semantic","category":"identity|preference|fact|todo","subject":"主体(默认'用户')","relation":"与用户的关系(默认'本人')","content":"简洁事实","context":"这条信息的叙事背景(一句话,说明是在什么情境下得知的)","due":"todo的截止日期(YYYY-MM-DD,非todo留空)","emotion":0.0}

emotion = 这条信息的情感强度（0-1）：用户表达强烈情绪，或涉及健康/家庭/金钱等重要事项时偏高（0.6-1.0）；日常事务性信息偏低（0.0-0.3）；不确定时给 0.3。

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
        emotion: clampTo01(item.emotion),
      })
    }
    return cards
  } catch (e) {
    return []
  }
}

function parseDue(value, now) {
  if (!value) return 0
  const raw = String(value).trim()
  const t = Date.parse(raw)
  if (!Number.isNaN(t)) return t
  const base = new Date(now)
  const m = raw.match(/^(?:第)?([一二三四五六七八九十\d]+)天后$/)
  if (m) return base.getTime() + Number(toNumber(m[1])) * 86400000
  if (raw === '明天') return base.getTime() + 86400000
  if (raw === '后天') return base.getTime() + 2 * 86400000
  const weekday = {'周一':1,'周二':2,'周三':3,'周四':4,'周五':5,'周六':6,'周日':0,'星期一':1,'星期二':2,'星期三':3,'星期四':4,'星期五':5,'星期六':6,'星期日':0}[raw]
  if (weekday !== undefined) {
    const days = (weekday - beijingWeekday(base) + 7) % 7 || 7
    return base.getTime() + days * 86400000
  }
  const nextWeek = raw.match(/^下周([一二三四五六日天])$/)
  if (nextWeek) {
    const target = {'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'日':0,'天':0}[nextWeek[1]]
    const days = 7 + ((target - beijingWeekday(base) + 7) % 7)
    return base.getTime() + days * 86400000
  }
  return 0
}
function toNumber(value) {
  const map = {一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10}
  return map[value] || Number(value) || 0
}

/** emotion 是模型给出的软信号（0-1）。无法解析时归 0，由评分层把「0/缺失」
 * 统一按 0.3 中性基线处理（见 DESIGN-memory-lifecycle §4.2）。 */
function clampTo01(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}
