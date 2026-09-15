import { ngrams, jaccard } from '../services/memory-importance.mjs'

/** 第二层：聚类压缩（DESIGN-memory-lifecycle.md §4.3，MEMORY-SPEC 第二层）。
 *
 * 目标：相似卡片 → 一条代表记忆；原文进二级存储（archived_memories）。**不丢信息**是硬约束。
 *
 * 两阶段：
 *   阶段 A 规则预聚（零成本）：按 (category, subject) 分组后做**种子扩张聚类**
 *     ——与种子相似度 ≥ SEED_THRESHOLD 且与簇内已有成员的平均相似度 ≥ AVG_THRESHOLD，
 *     簇大小上限 MAX_CLUSTER。**刻意不用连通分量**：多数卡片 subject='用户'，连通分量
 *     会因传递性把互不相关的卡片连成巨型簇（住址+天气+群文件），既爆 token 又诱导幻觉合并。
 *   阶段 B LLM 决策：把多个候选簇**打包**进一次调用（`<group>` 分隔，PACK_MAX 组/批），
 *     让模型判断"是不是真在讲同一件事"，返回合并结果；不硬凑、允许一条都不合并。
 *
 * 安全网（三重，任一不过则放弃该次合并——保守回退优先于丢信息）：
 *   1. cardIds 必须全部落在同一个预聚簇内（LLM 不得跨簇合并）；
 *   2. verifyMerge 信息保留校验：日期（归一化）+ 数字 + 字母词 + 跨卡共享中文实体覆盖率；
 *   3. 原卡只被标记 merged 并归档，永不物理删除（可回滚、可审计）。
 *
 * 幂等：合并后原卡 status='merged'，listActive() 天然排除 → 同一组不会被二次合并。
 * 保护栏：todo 不参与（行动项粒度）；generalized 不参与（防止层层抽象漂移）；identity
 * 只能与同 category+subject 的卡片合并（分组键天然保证）。 */

export const SEED_THRESHOLD = Number(process.env.CLUSTER_SEED_THRESHOLD || 0.35)
export const AVG_THRESHOLD = Number(process.env.CLUSTER_AVG_THRESHOLD || 0.30)
export const MAX_CLUSTER = Number(process.env.CLUSTER_MAX_MEMBERS || 12)
export const MIN_CLUSTER = 2
export const PACK_MAX = Number(process.env.CLUSTER_PACK_MAX || 6)
export const CONTENT_INPUT_LIMIT = Number(process.env.CLUSTER_CONTENT_INPUT_LIMIT || 400)
export const SUMMARY_LIMIT = Number(process.env.CLUSTER_SUMMARY_LIMIT || 600)
export const ENTITY_COVERAGE_MIN = Number(process.env.CLUSTER_ENTITY_COVERAGE || 0.5)

/** 通用字（含它们的中文片段是词边界碎片或泛用词，不作为"实体保留"的判据）：
 * 实测把 2 字片段算作实体时，「需要」这类通用词会进集合，覆盖率随措辞抖动；
 * 故实体只取 **3-4 字**片段，并过滤含通用字的片段。 */
const STOP_CHARS = new Set('的了在是和有与你我他她它们也都就还又很不没这那之其以及为对从到把被让给需要完成提供可已相关进跟'.split(''))

/** 阶段 A：种子扩张聚类（纯函数，可单测，不调 LLM）。
 * @returns {Array<Array<card>>} 每簇 ≥ MIN_CLUSTER 条；单条不成簇。 */
export function precluster(cards, { seedThreshold = SEED_THRESHOLD, avgThreshold = AVG_THRESHOLD, maxCluster = MAX_CLUSTER } = {}) {
  const groups = new Map()
  for (const card of cards || []) {
    const key = `${card.category}\u0000${card.subject}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(card)
  }
  const clusters = []
  for (const group of groups.values()) {
    if (group.length < MIN_CLUSTER) continue
    const grams = new Map(group.map((c) => [c.id, ngrams(c.content)]))
    // 种子优先取高分卡（评分高者更可能是"主干信息"），并列时取更新的
    const ordered = [...group].sort((a, b) => (Number(b.importance || 0) - Number(a.importance || 0)) || (b.updatedAt - a.updatedAt))
    const claimed = new Set()
    for (const seed of ordered) {
      if (claimed.has(seed.id)) continue
      const seedGrams = grams.get(seed.id)
      const members = [seed]
      claimed.add(seed.id)
      for (const candidate of ordered) {
        if (members.length >= maxCluster) break
        if (claimed.has(candidate.id)) continue
        if (jaccard(seedGrams, grams.get(candidate.id)) < seedThreshold) continue
        const avg = members.reduce((sum, m) => sum + jaccard(grams.get(m.id), grams.get(candidate.id)), 0) / members.length
        if (avg < avgThreshold) continue
        members.push(candidate)
        claimed.add(candidate.id)
      }
      if (members.length >= MIN_CLUSTER) clusters.push(members)
    }
  }
  return clusters
}

/** 阶段 B prompt：打包多个候选簇，一次判定。 */
export function buildClusterPrompt(pack) {
  const blocks = pack.map((group, index) => {
    const lines = group.map((c) => `  {"id":"${c.id}","category":"${c.category}","subject":"${c.subject}","relation":"${c.relation}","updated_at":"${dateOnly(c.updatedAt)}","content":${JSON.stringify(clip(c.content, CONTENT_INPUT_LIMIT))}}`)
    return `<group id="g${index + 1}">\n${lines.join(',\n')}\n</group>`
  }).join('\n\n')
  return `你是记忆整理器。下面是同一用户的多组记忆卡片，组内卡片可能相关。请判断每组里哪些卡片确实在讲同一件事，并把它们合并成一条记忆。

规则：
1. 只合并确实重复或高度相关的卡片；讲不同事的卡片**不要硬凑**——一组里一条都不合并是完全允许的。
2. 合并后的 content 必须保留所有关键细节：**数字、日期、专有名词（群名/项目名/人名/产品名）原样保留**，不得丢失、不得换算、不得改写数字。
3. 只能合并同一组内的卡片，不得跨组合并；identity（身份）类只在同 subject/relation 内合并。
4. 每组最多输出一条合并结果（组内若有多个独立的小簇，只挑最值得合并的那个，其余保持独立）。
5. 合并结果的 category/subject/relation 与来源卡片保持一致。
6. 只输出 JSON 数组，不要解释：
[{"groupId":"g1","cardIds":["id1","id2"],"content":"合并后的记忆","context":"一句话说明这次合并的来源"}]
7. 没有任何可合并内容时返回 []。

${blocks}

输出：`
}

/** 解析模型输出（容错：找不到 JSON 数组就返回空）。 */
export function parseClusterResult(raw) {
  const text = String(raw || '').trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const arr = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(arr)) return []
    return arr
      .filter((item) => item && Array.isArray(item.cardIds) && item.cardIds.length >= MIN_CLUSTER && String(item.content || '').trim())
      .map((item) => ({
        groupId: String(item.groupId || ''),
        cardIds: item.cardIds.map(String),
        content: String(item.content).trim(),
        context: String(item.context || '').trim(),
      }))
  } catch (e) {
    return []
  }
}

/** 信息保留校验：日期（归一化后比较）+ 数字 + 字母词 + 跨卡共享中文实体覆盖率。
 * 任一不过 → 放弃本次合并（保守回退，宁可少合并也不丢信息）。 */
export function verifyMerge(originals, summary) {
  const text = String(summary || '')
  if (!text.trim()) return { ok: false, reason: 'empty summary' }

  // 1) 日期：原卡的 2026-08-25 与摘要的 8月25日 视为同一信息
  const sourceDates = collectDates(originals)
  const summaryDates = collectDates([{ content: text }])
  for (const date of sourceDates) {
    if (!summaryDates.has(date)) return { ok: false, reason: `date lost: ${date}` }
  }

  // 2) 数字（排除日期内部数字）：原卡出现过的每个数字都必须原样出现
  for (const number of collectNumbers(originals)) {
    if (!text.includes(number)) return { ok: false, reason: `number lost: ${number}` }
  }

  // 3) 字母/技术词（fineBI / POC / NAS / SSO / v8.88 ...）
  for (const term of collectLatinTerms(originals)) {
    if (!text.toLowerCase().includes(term.toLowerCase())) return { ok: false, reason: `term lost: ${term}` }
  }

  // 4) 跨卡共享的中文实体（在 ≥2 张原卡出现的片段）在摘要中的覆盖率
  const entities = sharedChineseEntities(originals)
  if (entities.length) {
    const covered = entities.filter((e) => text.includes(e)).length
    const ratio = covered / entities.length
    if (ratio < ENTITY_COVERAGE_MIN) {
      return { ok: false, reason: `entity coverage ${ratio.toFixed(2)} < ${ENTITY_COVERAGE_MIN}` }
    }
  }
  return { ok: true, reason: 'ok' }
}

/** 聚类压缩器：把 store 里该用户的相似卡片合并成代表记忆。 */
export class MemoryClusterer {
  #complete
  #options

  constructor({ complete, ...options } = {}) {
    if (typeof complete !== 'function') throw new TypeError('complete is required')
    this.#complete = complete
    this.#options = options
  }

  /** 对单个用户跑一轮聚类压缩。返回 { clusters, merged, skipped, details }。 */
  async compress(store, userId, now = Date.now()) {
    const cards = store.listActive(userId).filter((c) => c.category !== 'todo' && c.kind === 'atomic')
    const clusters = precluster(cards, this.#options)
    if (!clusters.length) return { clusters: 0, merged: 0, skipped: 0, details: [] }

    const packMax = this.#options.packMax || PACK_MAX
    const details = []
    let merged = 0
    let skipped = 0

    for (let offset = 0; offset < clusters.length; offset += packMax) {
      const pack = clusters.slice(offset, offset + packMax)
      let raw = ''
      try {
        raw = await this.#complete([{ role: 'user', content: buildClusterPrompt(pack) }], { temperature: 0, maxTokens: 1200 })
      } catch (e) {
        details.push({ ok: false, reason: `llm error: ${String(e).slice(0, 120)}` })
        skipped += pack.length
        continue
      }
      for (const result of parseClusterResult(raw)) {
        // 安全网 1：只能合并同一个预聚簇内的卡片（LLM 不得跨簇组合）
        const source = pack.find((group) => result.cardIds.every((id) => group.some((c) => c.id === id)))
        if (!source) {
          skipped++
          details.push({ ok: false, reason: 'ids not in one candidate cluster', ids: result.cardIds })
          continue
        }
        const originals = result.cardIds.map((id) => source.find((c) => c.id === id)).filter(Boolean)
        if (originals.length < MIN_CLUSTER) {
          skipped++
          details.push({ ok: false, reason: 'unknown card ids', ids: result.cardIds })
          continue
        }
        // 安全网 2：信息保留校验
        const verify = verifyMerge(originals, result.content)
        if (!verify.ok) {
          skipped++
          details.push({ ok: false, reason: verify.reason, ids: result.cardIds })
          continue
        }
        // 安全网 3：合并 = 插新卡 + 原卡标记 merged 并归档（事务，可回滚）
        store.mergeInto(userId, originals.map((c) => c.id), {
          type: originals[0].type,
          category: originals[0].category,
          subject: originals[0].subject,
          relation: originals[0].relation,
          content: clip(result.content, SUMMARY_LIMIT),
          context: result.context || `由 ${originals.length} 条记忆合并而来`,
          emotion: Math.max(...originals.map((c) => Number(c.emotion || 0))),
          importance: Math.max(...originals.map((c) => Number(c.importance || 0.5))),
        }, now)
        merged++
        details.push({ ok: true, ids: result.cardIds, content: result.content })
      }
    }
    return { clusters: clusters.length, merged, skipped, details }
  }
}

// ——— helpers ———

function clip(text, limit) {
  const value = String(text || '')
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

function dateOnly(ms) {
  const date = new Date(Number(ms) || Date.now())
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : ''
}

function stripDates(text) {
  return String(text)
    .replace(/\d{4}-\d{1,2}-\d{1,2}/g, ' ')
    .replace(/\d{1,2}月\d{1,2}日/g, ' ')
    .replace(/(?<!\d)\d{1,2}\/\d{1,2}(?!\d)/g, ' ')
}

/** 归一化的「月-日」集合（年份由数字校验覆盖）。 */
export function collectDates(items) {
  const out = new Set()
  for (const item of items || []) {
    const text = String(item?.content || '')
    for (const m of text.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})/g)) out.add(`${Number(m[2])}-${Number(m[3])}`)
    for (const m of text.matchAll(/(\d{1,2})月(\d{1,2})日/g)) out.add(`${Number(m[1])}-${Number(m[2])}`)
    for (const m of text.matchAll(/(?<!\d)(\d{1,2})\/(\d{1,2})(?!\d)/g)) out.add(`${Number(m[1])}-${Number(m[2])}`)
  }
  return out
}

/** 去掉日期后的数字（含小数，如 7.0）。 */
export function collectNumbers(items) {
  const out = new Set()
  for (const item of items || []) {
    for (const m of stripDates(item?.content || '').matchAll(/\d+(?:\.\d+)?/g)) out.add(m[0])
  }
  return out
}

/** 字母/技术词（长度 ≥2，避免 a/b 这类噪声）。 */
export function collectLatinTerms(items) {
  const out = new Set()
  for (const item of items || []) {
    for (const m of String(item?.content || '').matchAll(/[A-Za-z][A-Za-z0-9.+#-]{1,}/g)) {
      if (m[0].replace(/[^A-Za-z0-9]/g, '').length >= 2) out.add(m[0])
    }
  }
  return out
}

/** 在 ≥2 张原卡中都出现的中文实体片段（2-4 字，含停用字的片段丢弃）。 */
export function sharedChineseEntities(items) {
  const perCard = (items || []).map((item) => chineseFragments(item?.content))
  const counts = new Map()
  for (const set of perCard) for (const frag of set) counts.set(frag, (counts.get(frag) || 0) + 1)
  return [...counts.entries()].filter(([, n]) => n >= 2).map(([frag]) => frag)
}

/** 中文实体片段：连续汉字段里长度 3-4、不含通用字的片段（2 字片段噪声太大）。
 * 导出给第三层泛化复用（作为"泛化内容必须锚定在来源事实"的锚点池）。 */
export function chineseFragments(text) {
  const out = new Set()
  for (const m of String(text || '').matchAll(/[\u4e00-\u9fa5]+/g)) {
    const run = m[0]
    if (run.length < 3) continue
    for (let size = 3; size <= 4; size++) {
      for (let i = 0; i + size <= run.length; i++) {
        const frag = run.slice(i, i + size)
        if ([...frag].some((ch) => STOP_CHARS.has(ch))) continue
        out.add(frag)
      }
    }
    if (out.size > 400) return out   // 防御：超长文本不无限枚举
  }
  return out
}
