import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { MemoryStore } from '../src/services/memory-store.mjs'
import {
  IMPORTANCE_WEIGHTS, CATEGORY_BASE, DECAY_FLOOR, EMOTION_BASELINE, GENERALIZED_BASE,
  ARCHIVE_THRESHOLD, ARCHIVE_MIN_AGE_DAYS,
  ngrams, jaccard, maxSimilarity, lastTouchedAt, scoreCard, isArchiveCandidate,
  scoreUser, archiveLowImportance,
} from '../src/services/memory-importance.mjs'

const DAY = 86400000
const NOW = Date.now()
const baseCard = (over = {}) => ({
  id: 'c1', category: 'fact', status: 'active', kind: 'atomic',
  content: '用户居住在深圳蛇口', accessCount: 0, emotion: 0,
  createdAt: NOW, updatedAt: NOW, ...over,
})
const tmpFile = () => path.join(os.tmpdir(), `imp-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
const cleanup = (file) => { try { fs.rmSync(file, { force: true }) } catch (e) {} }

test('weights sum to 1 (a drifting weight silently rescales every score)', () => {
  const sum = Object.values(IMPORTANCE_WEIGHTS).reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sum - 1) < 1e-9, `权重和应为 1，实际 ${sum}`)
})

test('ngrams normalize punctuation/space and split by code point (emoji safe)', () => {
  assert.ok(jaccard(ngrams('联合银行 POC，测试！'), ngrams('联合银行POC测试')) > 0.8)
  assert.ok(ngrams('🍊发的图片').size > 0)          // 代理对不被切碎
  assert.deepEqual([...ngrams('短')], ['短'])       // 短于 n 时退化为整串
  assert.equal(ngrams('').size, 0)
  assert.ok(ngrams('A B').has('ab'))               // 大小写 + 空白归一化
})

test('jaccard: identical → 1, disjoint → 0', () => {
  assert.equal(jaccard(ngrams('完全一样的内容'), ngrams('完全一样的内容')), 1)
  assert.equal(jaccard(ngrams('苹果发布会'), ngrams('明天要下雨')), 0)
  assert.equal(jaccard(ngrams(''), ngrams('任何内容')), 0)
})

test('category prior outranks behaviour: identity beats a fresh fact-like card without access', () => {
  const id = scoreCard(baseCard({ category: 'identity', content: '用户称呼为张工' }), { now: NOW }).importance
  const pref = scoreCard(baseCard({ category: 'preference', content: '偏好结构化回复' }), { now: NOW }).importance
  const fact = scoreCard(baseCard({ category: 'fact' }), { now: NOW }).importance
  assert.ok(id > pref && pref > fact, `identity(${id}) > preference(${pref}) > fact(${fact})`)
  // 冷启动：零访问、无情感标注的身份卡依然明显高于阈值（0.30·1.0 + 0.20·1 + 0.03 + 0.20 ≈ 0.73）
  assert.ok(id > 0.7, `身份卡冷启动得分应 > 0.7，实际 ${id}`)
  assert.equal(scoreCard(baseCard({ kind: 'generalized' }), { now: NOW }).factors.base, GENERALIZED_BASE)
})

test('frequency saturates at 5 accesses', () => {
  const freq = (n) => scoreCard(baseCard({ accessCount: n }), { now: NOW }).factors.frequency
  assert.equal(freq(0), 0)
  assert.equal(freq(3), 0.6)
  assert.equal(freq(5), 1)
  assert.equal(freq(50), 1)                        // 饱和，热点不垄断
})

test('decay: identity/preference never decay; fact slow; episodic fast but floored', () => {
  const old = (category) => baseCard({ category, createdAt: NOW - 400 * DAY, updatedAt: NOW - 400 * DAY })
  assert.equal(scoreCard(old('identity'), { now: NOW }).factors.decay, 1)
  assert.equal(scoreCard(old('preference'), { now: NOW }).factors.decay, 1)
  // fact 半衰期 180 天：100 天时仍是 0.68（远离下限），400 天时已触底
  const fact100 = baseCard({ category: 'fact', createdAt: NOW - 100 * DAY, updatedAt: NOW - 100 * DAY })
  assert.ok(Math.abs(scoreCard(fact100, { now: NOW }).factors.decay - 0.5 ** (100 / 180)) < 1e-9)
  assert.equal(scoreCard(old('fact'), { now: NOW }).factors.decay, DECAY_FLOOR)
  const episodic = scoreCard(baseCard({ category: 'episodic', createdAt: NOW - 400 * DAY, updatedAt: NOW - 400 * DAY }), { now: NOW })
  assert.equal(episodic.factors.decay, DECAY_FLOOR)     // 下限兜底
})

test('recency counts access: a recalled old card decays from last_access_at', () => {
  const card = baseCard({ createdAt: NOW - 400 * DAY, updatedAt: NOW - 400 * DAY, lastAccessAt: NOW - 1 * DAY, accessCount: 3 })
  assert.ok(scoreCard(card, { now: NOW }).factors.decay > 0.9)   // 访问即刷新（复述强化）
  assert.equal(lastTouchedAt(card), NOW - 1 * DAY)
})

test('missing emotion falls back to the neutral baseline, never to 0', () => {
  assert.equal(scoreCard(baseCard({ emotion: 0 }), { now: NOW }).factors.emotion, EMOTION_BASELINE)
  assert.equal(scoreCard(baseCard({ emotion: 0.9 }), { now: NOW }).factors.emotion, 0.9)
  assert.equal(scoreCard(baseCard({ emotion: 5 }), { now: NOW }).factors.emotion, 1)   // 截断
})

test('uniqueness: an exact duplicate scores 0, a distinct card scores high', () => {
  const a = baseCard({ id: 'a', content: '用户居住在深圳蛇口' })
  const b = baseCard({ id: 'b', content: '用户居住在深圳蛇口' })
  const c = baseCard({ id: 'c', content: '明天下午三点开项目评审会' })
  const all = [a, b, c]
  const grams = new Map(all.map((x) => [x.id, ngrams(x.content)]))
  assert.equal(scoreCard(a, { now: NOW, siblings: all, gramsById: grams }).factors.uniqueness, 0)
  assert.ok(scoreCard(c, { now: NOW, siblings: all, gramsById: grams }).factors.uniqueness > 0.7)
  assert.equal(maxSimilarity(a, all, grams), 1)
})

test('archive threshold stays reachable — parameter regression guard', () => {
  // 极旧 + 零访问 + 情感基线 + 完全重复（uniq=0）时各类别的最低可达分
  const dup = (category) => {
    const a = baseCard({ id: 'a', category, content: '群里发了图片和文件', createdAt: NOW - 3000 * DAY, updatedAt: NOW - 3000 * DAY })
    const b = { ...a, id: 'b' }
    const all = [a, b]
    const grams = new Map(all.map((x) => [x.id, ngrams(x.content)]))
    return scoreCard(a, { now: NOW, siblings: all, gramsById: grams }).importance
  }
  // 可归档：fact（含 type=episodic 的流水账）最低分必须低于阈值，否则规则永不触发
  assert.ok(dup('fact') < ARCHIVE_THRESHOLD, `fact 最低分 ${dup('fact')} 应 < 阈值 ${ARCHIVE_THRESHOLD}`)
  // 保护类别无论如何都高于阈值（双保险：即使保护栏失效也不会被误判）
  assert.ok(dup('identity') > ARCHIVE_THRESHOLD)
  assert.ok(dup('preference') > ARCHIVE_THRESHOLD)
})

test('a 90-day-old unique address fact survives (the "forgets where you live" regression)', () => {
  const address = baseCard({ category: 'fact', content: '用户居住在深圳蛇口', createdAt: NOW - 90 * DAY, updatedAt: NOW - 90 * DAY })
  const { importance } = scoreCard(address, { now: NOW })
  assert.ok(importance > ARCHIVE_THRESHOLD, `90 天未召回的住址不应跌破归档线，实际 ${importance}`)
  assert.equal(isArchiveCandidate(address, importance, NOW), false)
})

test('guard rails: identity/preference/todo are never archive candidates; young cards are spared', () => {
  const ancient = (category) => baseCard({ category, createdAt: NOW - 500 * DAY, updatedAt: NOW - 500 * DAY })
  for (const category of ['identity', 'preference', 'todo']) {
    assert.equal(isArchiveCandidate(ancient(category), 0.01, NOW), false, `${category} 应受保护`)
  }
  assert.equal(isArchiveCandidate(ancient('fact'), 0.01, NOW), true)
  const young = baseCard({ createdAt: NOW - 3 * DAY, updatedAt: NOW - 3 * DAY })
  assert.equal(isArchiveCandidate(young, 0.01, NOW), false)            // 新卡不判死
  const exactlyMinAge = baseCard({ createdAt: NOW - ARCHIVE_MIN_AGE_DAYS * DAY, updatedAt: NOW - ARCHIVE_MIN_AGE_DAYS * DAY })
  assert.equal(isArchiveCandidate(exactlyMinAge, 0.01, NOW), false)    // 边界：等于门槛不归档
  const merged = { ...ancient('fact'), status: 'merged' }
  assert.equal(isArchiveCandidate(merged, 0.01, NOW), false)           // 非 active 不重复归档
})

test('scoreUser writes importance back to the store and reports factors', () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    const name = store.insert('u1', { category: 'identity', content: '用户称呼为张工' })
    const fact = store.insert('u1', { category: 'fact', content: '用户居住在深圳蛇口' })
    const scored = scoreUser(store, 'u1', NOW)
    assert.equal(scored.length, 2)
    const persisted = Object.fromEntries(store.listActive('u1').map((c) => [c.id, c]))
    assert.ok(persisted[name.id].importance > persisted[fact.id].importance)   // 身份 > 事实
    const one = scored.find((s) => s.id === name.id)
    assert.equal(one.factors.base, CATEGORY_BASE.identity)
    assert.deepEqual(scoreUser(store, 'nobody', NOW), [])
  } finally { cleanup(file) }
})

test('archiveLowImportance archives only duplicated old cards, keeps unique + protected ones', () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    const address = store.insert('u1', { category: 'fact', content: '用户居住在深圳蛇口' })
    const name = store.insert('u1', { category: 'identity', content: '用户称呼为张工' })
    // 同内容的流水账卡（用不同 subject 绕过内容去重，构造 uniq=0 的最坏情况）
    const junkA = store.insert('u1', { type: 'episodic', category: 'fact', subject: '用户', content: '群里发了图片和文件' })
    const junkB = store.insert('u1', { type: 'episodic', category: 'fact', subject: '群A', content: '群里发了图片和文件' })

    const later = NOW + 500 * DAY            // 用 now 模拟老化，不改库
    const out = archiveLowImportance(store, 'u1', later)
    assert.equal(out.scored, 4)
    assert.equal(out.archived, 2)
    assert.deepEqual(out.candidates.map((c) => c.content).sort(), ['群里发了图片和文件', '群里发了图片和文件'])
    assert.ok(out.candidates.every((c) => c.importance < ARCHIVE_THRESHOLD))

    assert.equal(store.get('u1', junkA.id).status, 'archived')
    assert.equal(store.get('u1', junkB.id).status, 'archived')
    assert.equal(store.get('u1', address.id).status, 'active')   // 独特事实保留
    assert.equal(store.get('u1', name.id).status, 'active')      // 保护类别保留
    assert.equal(store.listArchived('u1').every((a) => a.reason === 'low_importance'), true)
    assert.equal(store.restore('u1', [junkA.id], later), 1)      // 可回滚
  } finally { cleanup(file) }
})
