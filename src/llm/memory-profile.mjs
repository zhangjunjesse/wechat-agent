/** 档案层：四段式用户档案（DESIGN-memory-lifecycle.md §4.5，WorkBuddy 式）。
 *
 * 档案是**派生视图**，不是真相源：内容随时可由 active 卡片重新生成，删掉
 * `memory_profiles` 行不损失任何信息；召回/工具都只读它，从不原地修改。
 * 它解决的是卡片式召回的三个短板：token 效率低、无概括、状态矛盾并存。
 *
 * 四段按「时间稳定性 + 用途」分块（对齐 WorkBuddy 的形态）：
 *   工作背景（稳定）→ 个人背景（稳定偏好/交互习惯）→ 当前关注（近期）→ 近期动态（时效）
 *
 * 约定：
 *   - **不含助手自称名**（那是 assistantName() 的单一来源，ADR-0003），生成前过滤；
 *   - active 卡片数 < MIN_PROFILE_CARDS 时不生成（信息量不足，避免"（暂无）"四连）；
 *   - 总长 ≤ PROFILE_MAX_CHARS，超出截断（预算见 memory-manager 的召回分层）。 */

export const PROFILE_SECTIONS = ['工作背景', '个人背景', '当前关注', '近期动态']
/** 档案字数上限：与召回分层里给档案的 token 预算（1200）对齐——中文约 1 字 1 token，
 *  留出段标题开销，取 1100 字（实测 800 字会在信息量大的用户身上截断【近期动态】）。 */
export const PROFILE_MAX_CHARS = Number(process.env.PROFILE_MAX_CHARS || 1100)
export const MIN_PROFILE_CARDS = Number(process.env.PROFILE_MIN_CARDS || 5)

/** 生成 prompt。 */
export function buildProfilePrompt(cards, now = Date.now()) {
  const today = new Date(Number(now)).toISOString().slice(0, 10)
  const lines = (cards || []).map((c) => `- [${c.category}/${c.type}] ${c.subject}/${c.relation}: ${c.content}`)
  return `你是用户档案生成器。根据下面的记忆卡片，生成该用户的档案，分四段：
【工作背景】职业/公司/职责/协作对象/技术栈（稳定）
【个人背景】沟通偏好/交互习惯/决策风格/生活信息（稳定）——**不要**放任务状态、待办、时效动态，那些归后两段
【当前关注】正在进行的主要事项（近期）
【近期动态】最近发生的重要事件与状态变化（时效）

规则：
1. **只写卡片支持的内容**，不推测、不补全、不评价。
2. 偏好要写成**可操作的描述**（例："偏好简短直接、结构化（编号列表/对比表格）的回复"）。
3. 每段 1-4 条要点；该段没有内容就写"（暂无）"。
4. 数字/日期/专有名词原样保留。
5. 总长不超过 ${PROFILE_MAX_CHARS} 字，**四段都要写完整**（宁可每段精简，也不要某段被挤掉）。
6. 直接输出四段内容本身（以【段名】开头），不要解释、不要前言后语。

今天是：${today}

记忆卡片：
${lines.length ? lines.join('\n') : '（暂无）'}

输出：`
}

/** 解析四段输出：缺段补「（暂无）」，超长截断；完全没有段标题则视为不可用。 */
export function parseProfileResult(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  const positions = []
  for (const name of PROFILE_SECTIONS) {
    const index = text.search(new RegExp(`【?${name}】?`))
    if (index >= 0) positions.push({ name, index })
  }
  if (!positions.length) return null
  positions.sort((a, b) => a.index - b.index)
  const bodies = new Map()
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].index
    const end = i + 1 < positions.length ? positions[i + 1].index : text.length
    const body = text
      .slice(start, end)
      .replace(new RegExp(`^\\s*#{0,6}\\s*【?${positions[i].name}】?\\s*[:：]?\\s*`), '')
      .trim()
    bodies.set(positions[i].name, body)
  }
  const content = PROFILE_SECTIONS.map((name) => `【${name}】\n${bodies.get(name) || '（暂无）'}`).join('\n')
  return content.length <= PROFILE_MAX_CHARS ? content : `${content.slice(0, PROFILE_MAX_CHARS)}…`
}

/** 档案生成器。 */
export class MemoryProfiler {
  #complete
  #options

  constructor({ complete, ...options } = {}) {
    if (typeof complete !== 'function') throw new TypeError('complete is required')
    this.#complete = complete
    this.#options = options
  }

  /** 由 active 卡片重建档案。返回 { ok, content?, version?, cards, reason? }。
   *
   * 解析失败会**重试一次**：deepseek-flash 的思考模式偶发返回空 content（原因不明、
   * 与 prompt 无关），而档案失败会让分层召回退回旧路径，代价比一次重试大得多。 */
  async generate(store, userId, now = Date.now()) {
    const minCards = this.#options.minCards || MIN_PROFILE_CARDS
    // 助手自称名不进档案（单一来源 = assistantName()）
    const cards = store.listActive(userId).filter((c) => !(c.category === 'identity' && c.subject === '助手'))
    if (cards.length < minCards) {
      return { ok: false, cards: cards.length, reason: `too few cards (${cards.length} < ${minCards})` }
    }
    const prompt = buildProfilePrompt(cards, now)
    const attempts = this.#options.attempts || 2
    let lastRaw = ''
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        lastRaw = await this.#complete([{ role: 'user', content: prompt }], { temperature: 0, maxTokens: 1600 })
      } catch (e) {
        return { ok: false, cards: cards.length, reason: `llm error: ${String(e).slice(0, 120)}` }
      }
      const content = parseProfileResult(lastRaw)
      if (content) {
        const profile = store.upsertProfile(userId, content, cards.length, now)
        return { ok: true, content, version: profile?.version || 1, cards: cards.length, attempts: attempt + 1 }
      }
    }
    return { ok: false, cards: cards.length, reason: `unparsable output: ${String(lastRaw).slice(0, 80)}` }
  }
}
