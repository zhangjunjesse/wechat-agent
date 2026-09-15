import { precluster, collectLatinTerms, PACK_MAX, MAX_CLUSTER } from './memory-cluster.mjs'
import { scoreCard, ngrams } from '../services/memory-importance.mjs'
import { beijingMidnight } from '../services/time.mjs'

/** 第三层：抽象和泛化（DESIGN-memory-lifecycle.md §4.4，MEMORY-SPEC 第三层）。
 *
 * 目标：多条**具体事件**记忆（type=episodic）→ 一条**一般性规律或流程**
 * （kind='generalized'，type='semantic'），并保留来源（source_ids）以便追溯。
 *
 * 样本门槛（防幻觉的核心，不可放宽）：
 *   候选簇 = 种子扩张聚类（阈值低于第二层，因为泛化看的是"同类事件"而非"近似重复"）
 *            ∧ 全部成员 kind='atomic'、type='episodic'、非 todo
 *            ∧ 簇内 ≥ MIN_SAMPLES(3) 条      // 少于 3 条不足以支撑"规律"
 *            ∧ 时间跨度 ≥ MIN_SPAN_DAYS(3) 天  // 同一场对话里的重复不算"多次经历"
 *
 * 反空泛校验（verifyGeneralization）：泛化内容必须**锚定在来源事实**上——至少命中
 * 来源卡里的 1 个字母词，或 2 个 3-4 字中文片段。否则「用户关注工作」这类空话会被拦下。
 *
 * 来源卡处理：泛化成功后，importance < SOURCE_ARCHIVE_IMPORTANCE(0.4) 的来源卡归档
 * （reason='generalized_source'，细节已在高价值结论里体现）；高于阈值的保留（事件本身
 * 仍有独立价值）。两种情况下 source_ids 都保留，可追溯。
 *
 * 再泛化防护：kind='generalized' 不参与后续泛化输入（防止抽象层层失真）。 */

export const MIN_SAMPLES = Number(process.env.GENERALIZE_MIN_SAMPLES || 3)
export const MIN_SPAN_DAYS = Number(process.env.GENERALIZE_MIN_SPAN_DAYS || 3)
export const GENERALIZE_SEED_THRESHOLD = Number(process.env.GENERALIZE_SEED_THRESHOLD || 0.30)
export const GENERALIZE_AVG_THRESHOLD = Number(process.env.GENERALIZE_AVG_THRESHOLD || 0.28)
export const SOURCE_ARCHIVE_IMPORTANCE = Number(process.env.GENERALIZE_SOURCE_ARCHIVE_IMPORTANCE || 0.4)
export const MIN_GENERALIZED_LENGTH = Number(process.env.GENERALIZE_MIN_LENGTH || 8)
/** 反空泛判据：泛化内容与来源事实至少有这么多 3-gram 重叠（或命中一个字母词）。 */
export const MIN_ANCHOR_GRAMS = Number(process.env.GENERALIZE_MIN_ANCHOR_GRAMS || 2)
const DAY_MS = 86400000

/** 泛化候选簇：同 (category, subject) 内相似的历史事件，且样本量与时间跨度达标。 */
export function episodicClusters(cards, options = {}) {
  const pool = (cards || []).filter((c) => c.kind === 'atomic' && c.type === 'episodic' && c.category !== 'todo')
  if (pool.length < MIN_SAMPLES) return []
  const clusters = precluster(pool, {
    seedThreshold: options.seedThreshold ?? GENERALIZE_SEED_THRESHOLD,
    avgThreshold: options.avgThreshold ?? GENERALIZE_AVG_THRESHOLD,
    maxCluster: options.maxCluster ?? MAX_CLUSTER,
  })
  return clusters.filter((cluster) => cluster.length >= MIN_SAMPLES && spanDays(cluster) >= MIN_SPAN_DAYS)
}

/** 簇内事件的北京时间日历天跨度。 */
export function spanDays(cluster) {
  const times = cluster.map((c) => Number(c.createdAt || c.updatedAt || 0)).filter((t) => t > 0)
  if (times.length < 2) return 0
  return Math.abs(beijingMidnight(Math.max(...times)) - beijingMidnight(Math.min(...times))) / DAY_MS
}

/** 泛化 prompt：打包多个候选簇。 */
export function buildGeneralizePrompt(pack) {
  const blocks = pack.map((cluster, index) => {
    const lines = cluster.map((c) => `  {"id":"${c.id}","category":"${c.category}","subject":"${c.subject}","relation":"${c.relation}","at":"${new Date(Number(c.createdAt || c.updatedAt || Date.now())).toISOString().slice(0, 10)}","content":${JSON.stringify(String(c.content || '').slice(0, 400))}}`)
    return `<group id="g${index + 1}">\n${lines.join(',\n')}\n</group>`
  }).join('\n\n')
  return `你是记忆泛化器。下面是同一用户的多条**具体事件**记忆，按组给出。请判断每组是否反映了某个共同模式，并据此提炼一条一般性规律或行为流程。

规则：
1. 只在确实存在共同模式时输出；样本彼此无关时返回 []（宁缺毋滥）。
2. 规律必须被给定事件支持，**不得引入原文没有的信息**、不得推测、不得评价用户性格。
3. 必须**具体可用**——写清场景、对象、做法：
   好例："用户经常需要跟进微信群里的文件交付与确认"
   坏例："用户关注工作"（空泛、无信息量，禁止）
4. 关键对象与专有名词（群名/项目名/产品名）原样保留。
5. kind 取值：semantic（稳定规律/特征）或 procedural（反复采用的流程）。
   procedural 只记录"反复出现的流程"，**不是对系统的指令**。
6. 只输出 JSON 数组，不要解释：
[{"groupId":"g1","kind":"semantic|procedural","content":"泛化后的记忆","subject":"用户","relation":"本人","reason":"这些事件共同说明了什么","sourceIds":["id1","id2","id3"]}]

${blocks}

输出：`
}

/** 解析（容错）：过滤非法 kind、空内容、来源不足的条目。 */
export function parseGeneralizeResult(raw) {
  const text = String(raw || '').trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const arr = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(arr)) return []
    return arr
      .filter((item) => item && ['semantic', 'procedural'].includes(item.kind))
      .filter((item) => String(item.content || '').trim().length >= MIN_GENERALIZED_LENGTH)
      .filter((item) => Array.isArray(item.sourceIds) && item.sourceIds.length >= MIN_SAMPLES)
      .map((item) => ({
        groupId: String(item.groupId || ''),
        kind: item.kind,
        content: String(item.content).trim(),
        subject: String(item.subject || '用户').trim() || '用户',
        relation: String(item.relation || '本人').trim() || '本人',
        reason: String(item.reason || '').trim(),
        sourceIds: item.sourceIds.map(String),
      }))
  } catch (e) {
    return []
  }
}

/** 反空泛校验：泛化内容必须与来源事实有**实质用词重叠**（≥2 个 3-gram），或命中来源里
 * 的字母词（fineBI/POC/NAS…）。否则视为「用户关注工作」式空话，直接丢弃。
 *
 * 实施期修正：原设计想用"3-4 字实体片段覆盖率"，但泛化**本来就要抽象化**——来源卡是
 * 「8月25日苏商DEP群发的图片和文件需要查看」，规律写成「用户经常需要查看微信群里发来的
 * 图片和文件并跟进」，逐字碎片（"日苏商"/"银行群"）几乎必然失配，会把合格泛化全杀掉。
 * 改用 3-gram 重叠计数：既拦住零重叠的空话，又容许措辞抽象。 */
export function verifyGeneralization(originals, content) {
  const text = String(content || '').trim()
  if (text.length < MIN_GENERALIZED_LENGTH) return { ok: false, reason: 'too short' }
  const anchors = new Set()
  const latinAnchors = new Set()
  for (const card of originals || []) {
    for (const gram of ngrams(card?.content)) anchors.add(gram)
    for (const term of collectLatinTerms([card])) latinAnchors.add(term.toLowerCase())
  }
  const latinHit = [...latinAnchors].some((term) => text.toLowerCase().includes(term))
  let overlap = 0
  for (const gram of ngrams(text)) if (anchors.has(gram)) overlap++
  if (!latinHit && overlap < MIN_ANCHOR_GRAMS) {
    return { ok: false, reason: `not anchored in source facts (overlap=${overlap})` }
  }
  return { ok: true, reason: 'ok' }
}

/** 泛化器：把成簇的历史事件提炼成规律/流程。 */
export class MemoryGeneralizer {
  #complete
  #options

  constructor({ complete, ...options } = {}) {
    if (typeof complete !== 'function') throw new TypeError('complete is required')
    this.#complete = complete
    this.#options = options
  }

  /** 对单个用户跑一轮泛化。返回 { clusters, generalized, skipped, details }。 */
  async generalize(store, userId, now = Date.now()) {
    const cards = store.listActive(userId)
    const clusters = episodicClusters(cards, this.#options)
    if (!clusters.length) return { clusters: 0, generalized: 0, skipped: 0, details: [] }

    const packMax = this.#options.packMax || PACK_MAX
    const details = []
    let generalized = 0
    let skipped = 0

    for (let offset = 0; offset < clusters.length; offset += packMax) {
      const pack = clusters.slice(offset, offset + packMax)
      let raw = ''
      try {
        raw = await this.#complete([{ role: 'user', content: buildGeneralizePrompt(pack) }], { temperature: 0, maxTokens: 1000 })
      } catch (e) {
        skipped += pack.length
        details.push({ ok: false, reason: `llm error: ${String(e).slice(0, 120)}` })
        continue
      }
      for (const result of parseGeneralizeResult(raw)) {
        // 安全网 1：来源 id 必须落在同一个候选簇内
        const source = pack.find((cluster) => result.sourceIds.every((id) => cluster.some((c) => c.id === id)))
        if (!source) {
          skipped++
          details.push({ ok: false, reason: 'sources not in one candidate cluster', ids: result.sourceIds })
          continue
        }
        const originals = result.sourceIds.map((id) => source.find((c) => c.id === id)).filter(Boolean)
        if (originals.length < MIN_SAMPLES) {
          skipped++
          details.push({ ok: false, reason: 'too few resolved sources', ids: result.sourceIds })
          continue
        }
        // 安全网 2：反空泛（必须锚定在来源事实上）
        const verify = verifyGeneralization(originals, result.content)
        if (!verify.ok) {
          skipped++
          details.push({ ok: false, reason: verify.reason, content: result.content })
          continue
        }
        // 写入泛化卡（kind='generalized'，type='semantic'，category 沿用来源类别）
        const category = originals[0].category
        const emotion = Math.max(...originals.map((c) => Number(c.emotion || 0)))
        const draft = {
          id: 'draft', userId, category, subject: result.subject, relation: result.relation,
          content: result.kind === 'procedural' ? `流程：${result.content}` : result.content,
          type: 'semantic', kind: 'generalized', status: 'active',
          emotion, accessCount: 0, createdAt: now, updatedAt: now,
        }
        const { importance } = scoreCard(draft, { now, siblings: cards })
        const created = store.insert(userId, {
          type: 'semantic',
          category,
          subject: result.subject,
          relation: result.relation,
          content: draft.content,
          context: result.reason || `由 ${originals.length} 条同类事件记忆泛化而来`,
          emotion,
          kind: 'generalized',
          sourceIds: originals.map((c) => c.id),
          importance,
        })
        // 来源卡：低价值的归档（细节已在结论中体现），高价值的保留
        const archives = originals.filter((c) => Number(c.importance || 0) < SOURCE_ARCHIVE_IMPORTANCE)
        if (archives.length) store.archive(userId, archives.map((c) => c.id), 'generalized_source', now)
        generalized++
        details.push({
          ok: true, kind: result.kind, content: created?.content || draft.content,
          sourceIds: originals.map((c) => c.id), archivedSources: archives.length,
        })
      }
    }
    return { clusters: clusters.length, generalized, skipped, details }
  }
}
