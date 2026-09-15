import { MemoryStore } from '../services/memory-store.mjs'
import { MemoryExtractor } from './memory-extractor.mjs'
import { estimateTokens } from '../services/tokenizer.mjs'
import { beijingDateStr, beijingMidnight, beijingNowLine } from '../services/time.mjs'
import { pruneTodos } from '../services/memory-pruner.mjs'

/** 召回分层预算（DESIGN-memory-lifecycle §4.7）：档案优先，卡片按用途分配。 */
export const PROFILE_TOKEN_BUDGET = 1200
export const GENERALIZED_TOKEN_BUDGET = 800
export const TODO_RECALL_LIMIT = 20

export class MemoryManager {
  #store; #extractor; #now; #maxRecallTokens
  constructor({ store = new MemoryStore(), extractor, now = () => new Date(), maxRecallTokens = 6000 }) {
    if (!extractor) throw new TypeError('extractor is required')
    this.#store = store; this.#extractor = extractor; this.#now = now; this.#maxRecallTokens = maxRecallTokens
  }
  get store() { return this.#store }
  /** 分层召回（DESIGN-memory-lifecycle §4.7）。
   *
   * 有档案时：[用户档案]（派生视图，≤1200 token）→【泛化】（≤800）→【待办】（分层优先，
   * 上限 20 条 + 溢出提示）→【新近】（**档案生成时间之后**更新的卡片，真增量、与档案零重叠）。
   * 无档案时回退到按 category 分节的旧行为（灰度与回滚安全）。
   *
   * 只注入 active 卡片（归档/合并卡不出现），并在注入后回写访问统计——第一层评分里
   * frequency 因子的唯一来源。档案本身是投影，不计入访问统计。 */
  recall(userId) {
    const cards = this.#store.listActive(userId)
    const profile = this.#store.getProfile(userId)
    // 档案是独立投影：即使所有卡片都被归档/合并（active 为空），档案仍然要注入；
    // 两者都空才是真的没有任何可召回内容。
    if (!cards.length && !profile?.content) return ''
    const now = this.#now()
    const cap = this.#maxRecallTokens
    const lines = []
    const injected = []
    let tokens = 0
    const push = (line) => {
      const cost = estimateTokens(line)
      if (tokens + cost > cap) return false
      lines.push(line)
      tokens += cost
      return true
    }

    if (profile?.content) {
      lines.push('[用户档案]')
      const profileText = clipToTokens(profile.content, PROFILE_TOKEN_BUDGET)
      lines.push(profileText)
      tokens += estimateTokens(profileText)

      // 【泛化】第三层产物：稳定的规律与流程
      const byImportance = (a, b) => (Number(b.importance || 0) - Number(a.importance || 0)) || (b.updatedAt - a.updatedAt)
      const generalized = cards.filter((c) => c.kind === 'generalized').sort(byImportance)
      if (generalized.length) {
        lines.push('【泛化】')
        let used = 0
        for (const card of generalized) {
          const line = `- ${card.content}`
          const cost = estimateTokens(line)
          if (used + cost > GENERALIZED_TOKEN_BUDGET) break
          if (!push(line)) break
          used += cost
          injected.push(card.id)
        }
      }

      // 【待办】行动项优先，但非无限（上限 + 溢出提示）
      const todos = cards.filter((c) => c.category === 'todo')
        .sort((a, b) => (Number(a.due || 0) || Number.MAX_SAFE_INTEGER) - (Number(b.due || 0) || Number.MAX_SAFE_INTEGER))
      if (todos.length) {
        lines.push('【待办】')
        const shown = todos.slice(0, TODO_RECALL_LIMIT)
        for (const card of shown) {
          if (!push(cardLine(card, now))) break
          injected.push(card.id)
        }
        if (todos.length > shown.length) lines.push(`…另有 ${todos.length - shown.length} 条待办，需要我列出来吗？`)
      }

      // 【新近】档案没覆盖到的部分：档案生成之后新增/更新的卡片
      const recent = cards
        .filter((c) => c.category !== 'todo' && c.kind !== 'generalized' && c.updatedAt > Number(profile.generatedAt || 0))
        .sort((a, b) => b.updatedAt - a.updatedAt)
      if (recent.length) {
        lines.push('【新近】')
        for (const card of recent) {
          if (!push(cardLine(card, now))) break
          injected.push(card.id)
        }
      }
    } else {
      // 回退路径：无档案的库（新部署 / 未跑过维护 / 卡片不足）保持旧行为
      const sections = [
        { category: 'identity', label: '身份' },
        { category: 'preference', label: '偏好' },
        { category: 'fact', label: '事实' },
        { category: 'todo', label: '待办' },
      ]
      lines.push('[用户长期记忆]')
      for (const section of sections) {
        let group = cards.filter((c) => c.category === section.category)
        // 助手命名由 assistantName() 单独承载，不在记忆正文重复展示，避免两处冲突
        if (section.category === 'identity') group = group.filter((c) => c.subject !== '助手')
        group.sort((a, b) => b.updatedAt - a.updatedAt)
        if (!group.length) continue
        const header = `【${section.label}】`
        if (!push(header)) break
        for (const card of group) {
          const line = cardLine(card, now)
          if (!push(line)) break
          injected.push(card.id)
        }
      }
    }

    if (injected.length) {
      try { this.#store.markAccessed(userId, injected, now.getTime()) } catch (e) { /* 统计失败不影响召回 */ }
    }
    return lines.join('\n')
  }
  /** 助手的自称名，单一来源：记忆里用户设定的命名（identity / subject=助手），
   * 没有则回退默认 '助手'。不再有第二个来源（避免与系统提示词硬编码冲突）。 */
  assistantName(userId) {
    const cards = this.#store.list(userId)
      .filter((c) => c.category === 'identity' && c.subject === '助手')
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const latest = cards[0]
    if (!latest) return '助手'
    const m = String(latest.content || '').match(/助手(?:命名为|改名为|叫|名为)(.+)/)
    return m ? m[1].trim().replace(/[，。,.!！?？\s]/g, '') : '助手'
  }
  async absorb(userId, userText, assistantText) {
    let cards = []
    try { cards = await this.#extractor.extract(userText, assistantText, this.#now(), this.#store.listActive(userId)) } catch (e) { cards = [] }
    for (const card of cards) card.action === 'update' ? this.#store.update(userId, card) : this.#store.insert(userId, card)
    // 轻量维护（DESIGN-memory-lifecycle §4.6）：todo 过期/老化 → 归档（不物理删除）。
    // 放在 absorb 的异步链里，既不阻塞用户回复，也不引入 LLM 调用。
    try { pruneTodos(this.#store, userId, this.#now().getTime()) } catch (e) { /* 清理失败不影响本轮记忆写入 */ }
    return cards.length
  }
  nowLine() { return beijingNowLine(this.#now().getTime()) }
}

function cardLine(card, now) {
  const subject = card.subject === '用户' ? '' : `(${card.relation}:${card.subject})`
  const extra = card.category === 'todo' && card.due ? `【截止 ${fmtDate(card.due)}，${relativeDue(card.due, now)}】` : ''
  return `- ${card.content}${subject}${extra}`
}

/** 按 token 预算逐行截断（用于档案这类整体文本块）。 */
function clipToTokens(text, budget) {
  const source = String(text || '')
  const kept = []
  let tokens = 0
  for (const line of source.split('\n')) {
    const cost = estimateTokens(line)
    if (tokens + cost > budget) break
    kept.push(line)
    tokens += cost
  }
  return kept.length ? kept.join('\n') : source.slice(0, budget)
}

export function fmtDate(ms) { return beijingDateStr(ms) }

export function relativeDue(dueMs, now = new Date()) {
  const a = beijingMidnight(dueMs)
  const b = beijingMidnight(now)
  const n = Math.round((a - b) / 86400000)
  return n < 0 ? `已过期 ${-n} 天` : n === 0 ? '今天到期' : n === 1 ? '明天到期' : `还剩 ${n} 天`
}
