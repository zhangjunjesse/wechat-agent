/** 第一层：重要性评分筛选（DESIGN-memory-lifecycle.md §4.2，MEMORY-SPEC 第一层）。
 *
 * 四因子加权 + 类别基线，全部集中为可调常量（env 可覆盖）：
 *   base       类别先验（identity 1.0 / preference 0.9 / todo 0.8 / fact 0.6 / episodic 0.5）
 *   frequency  召回访问频率（access_count，5 次饱和）
 *   decay      时间衰减（按类别分半衰期 + DECAY_FLOOR 下限）
 *   emotion    情感强度（提取时由 LLM 标注；缺失按 0.3 中性基线）
 *   uniqueness 信息独特性（与同用户其他 active 卡的最高 3-gram Jaccard 相似度取反）
 *
 * 为什么是加权而不是纯行为统计：类别本身就是最强的价值先验——「用户叫张工」不该因为
 * 没有被召回访问过就被判低价值（冷启动问题）。
 *
 * 归档阈值与保护栏见 isArchiveCandidate()：低价值卡片进入二级存储（archived_memories），
 * identity/preference 永不自动归档，todo 交给 memory-pruner 按时间规则处理。
 *
 * 纯计算模块：不依赖 LLM、不直接写库（写库由 scoreUser / archiveLowImportance 通过
 * 传入的 store 完成），便于单测与人工审查"为什么这条被判低分"。 */

const envNumber = (name, fallback) => {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

/** 权重（和为 1）。 */
export const IMPORTANCE_WEIGHTS = Object.freeze({
  base: envNumber('IMPORTANCE_W_BASE', 0.30),
  frequency: envNumber('IMPORTANCE_W_FREQ', 0.20),
  decay: envNumber('IMPORTANCE_W_DECAY', 0.20),
  emotion: envNumber('IMPORTANCE_W_EMOTION', 0.10),
  uniqueness: envNumber('IMPORTANCE_W_UNIQUENESS', 0.20),
})

/** 类别基线（0-1）。 */
export const CATEGORY_BASE = Object.freeze({
  identity: 1.0,
  preference: 0.9,
  todo: 0.8,
  fact: 0.6,
  episodic: 0.5,
})

/** 泛化卡（kind='generalized'，第三层产物）的基线：介于 fact 与 preference 之间。 */
export const GENERALIZED_BASE = envNumber('IMPORTANCE_BASE_GENERALIZED', 0.7)

/** 类别半衰期（天）。Infinity = 不衰减（画像核心）。 */
export const HALF_LIFE_DAYS = Object.freeze({
  identity: Infinity,
  preference: Infinity,
  todo: Infinity,   // todo 的生命周期由 memory-pruner 管，不靠衰减
  fact: envNumber('IMPORTANCE_HALFLIFE_FACT_DAYS', 180),
  episodic: envNumber('IMPORTANCE_HALFLIFE_EPISODIC_DAYS', 45),
})

/** 衰减下限：长期未访问的重要事实不会被衰减到归档线下（评审修订 —— 统一 45 天半衰期
 * 会让 90 天未召回的「用户居住在蛇口」跌破阈值而被归档，等于模型忘掉核心事实）。 */
export const DECAY_FLOOR = envNumber('IMPORTANCE_DECAY_FLOOR', 0.35)

/** 缺失情感强度时的中性基线（不按 0 计，避免"未标注"被系统性当成"无情感"）。 */
export const EMOTION_BASELINE = envNumber('IMPORTANCE_EMOTION_BASELINE', 0.3)

/** 访问频率饱和点（次）。 */
export const FREQUENCY_SATURATION = envNumber('IMPORTANCE_FREQ_SATURATION', 5)

/** 归档阈值。
 *
 * 阈值必须**高于**任何类别在「极旧 + 零访问 + 情感基线 + 完全重复」下的最低可达分，
 * 否则归档规则永不触发。按 category 计算（episodic 是 **type** 不是 category，
 * `CATEGORY_BASE.episodic` 仅作旧数据兜底）：
 *   fact 0.28（含 type=episodic 的流水账卡）| preference 0.50 | identity 0.53（todo 不参与）
 * 取 0.30：只清「几乎完全重复且已老化」的卡片；独特卡片由 uniqueness 因子自保
 * （唯一且极旧的 fact 仍 ≈0.50）。相似但不相同的长尾由第二层聚类合并承担。
 * 详见 DESIGN §4.2 阈值可达性推导。 */
export const ARCHIVE_THRESHOLD = envNumber('IMPORTANCE_ARCHIVE_THRESHOLD', 0.30)
export const ARCHIVE_MIN_AGE_DAYS = envNumber('IMPORTANCE_ARCHIVE_MIN_AGE_DAYS', 14)

/** 永不自动归档的类别（用户画像核心）。 */
export const PROTECTED_CATEGORIES = Object.freeze(['identity', 'preference'])

const NGRAM = 3
const DAY_MS = 86400000

/** 归一化 + 按**码点**切分的字符 n-gram 集合（emoji 是代理对，substring 会切碎）。 */
export function ngrams(text, n = NGRAM) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
  const chars = Array.from(normalized)
  const grams = new Set()
  if (!chars.length) return grams
  if (chars.length <= n) {
    grams.add(chars.join(''))
    return grams
  }
  for (let i = 0; i + n <= chars.length; i++) grams.add(chars.slice(i, i + n).join(''))
  return grams
}

/** Jaccard 相似度（0-1）。 */
export function jaccard(a, b) {
  if (!a?.size || !b?.size) return 0
  let intersection = 0
  for (const gram of a) if (b.has(gram)) intersection++
  return intersection / (a.size + b.size - intersection)
}

/** 与同用户其他 active 卡的最高相似度（排除自己）。 */
export function maxSimilarity(card, siblings = [], gramsById = null) {
  const mine = gramsById?.get(card.id) || ngrams(card.content)
  let best = 0
  for (const other of siblings) {
    if (other.id === card.id) continue
    const theirs = gramsById?.get(other.id) || ngrams(other.content)
    const score = jaccard(mine, theirs)
    if (score > best) best = score
  }
  return best
}

/** 卡片最后一次"活动"时间：更新或被访问，取较晚者（复述强化）。 */
export function lastTouchedAt(card) {
  return Math.max(Number(card?.updatedAt || 0), Number(card?.lastAccessAt || 0), Number(card?.createdAt || 0))
}

/** 单卡评分。返回 { importance, factors }——factors 用于测试与人工审查。 */
export function scoreCard(card, { now = Date.now(), siblings = [], gramsById = null } = {}) {
  const base = card.kind === 'generalized'
    ? GENERALIZED_BASE
    : (CATEGORY_BASE[card.category] ?? 0.5)
  const frequency = Math.min(1, Math.max(0, Number(card.accessCount || 0)) / FREQUENCY_SATURATION)
  const halfLife = HALF_LIFE_DAYS[card.category]
  const ageDays = Math.max(0, (now - lastTouchedAt(card)) / DAY_MS)
  const decay = halfLife === Infinity
    ? 1
    : Math.max(DECAY_FLOOR, 0.5 ** (ageDays / (halfLife || HALF_LIFE_DAYS.episodic)))
  const emotion = Number(card.emotion) > 0 ? clamp01(card.emotion) : EMOTION_BASELINE
  const uniqueness = clamp01(1 - maxSimilarity(card, siblings, gramsById))
  const importance = clamp01(
    IMPORTANCE_WEIGHTS.base * base +
    IMPORTANCE_WEIGHTS.frequency * frequency +
    IMPORTANCE_WEIGHTS.decay * decay +
    IMPORTANCE_WEIGHTS.emotion * emotion +
    IMPORTANCE_WEIGHTS.uniqueness * uniqueness
  )
  return { importance, factors: { base, frequency, decay, emotion, uniqueness, ageDays } }
}

/** 是否应归档（保守，评审后的保护栏）。 */
export function isArchiveCandidate(card, importance, now = Date.now()) {
  if (!card || card.status !== 'active') return false
  if (PROTECTED_CATEGORIES.includes(card.category)) return false   // 画像核心
  if (card.category === 'todo') return false                       // 交给 pruner 按时间规则
  const ageDays = (now - lastTouchedAt(card)) / DAY_MS
  if (ageDays <= ARCHIVE_MIN_AGE_DAYS) return false                // 新卡不判死
  return Number(importance) < ARCHIVE_THRESHOLD
}

/** 给该用户全部 active 卡打分并回写 importance。返回评分明细（供维护日志/人工审查）。 */
export function scoreUser(store, userId, now = Date.now()) {
  const cards = store.listActive(userId)
  if (!cards.length) return []
  const gramsById = new Map(cards.map((c) => [c.id, ngrams(c.content)]))
  const scored = []
  for (const card of cards) {
    const { importance, factors } = scoreCard(card, { now, siblings: cards, gramsById })
    store.setImportance(userId, card.id, importance)
    scored.push({ id: card.id, category: card.category, kind: card.kind, content: card.content, importance, factors })
  }
  return scored
}

/** 第一层的完整动作：打分 → 归档低价值卡（进二级存储，可回滚）。 */
export function archiveLowImportance(store, userId, now = Date.now()) {
  const scored = scoreUser(store, userId, now)
  if (!scored.length) return { scored: 0, archived: 0, candidates: [] }
  const cards = new Map(store.listActive(userId).map((c) => [c.id, c]))
  const candidates = scored.filter((s) => isArchiveCandidate(cards.get(s.id), s.importance, now))
  const archived = candidates.length
    ? store.archive(userId, candidates.map((c) => c.id), 'low_importance', now)
    : 0
  return {
    scored: scored.length,
    archived,
    candidates: candidates.map((c) => ({ id: c.id, importance: round3(c.importance), category: c.category, content: c.content })),
  }
}

function clamp01(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

function round3(value) {
  return Math.round(Number(value) * 1000) / 1000
}
