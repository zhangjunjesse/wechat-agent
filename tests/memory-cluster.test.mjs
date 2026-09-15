import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { MemoryStore } from '../src/services/memory-store.mjs'
import {
  MemoryClusterer, precluster, buildClusterPrompt, parseClusterResult, verifyMerge,
  collectDates, collectNumbers, collectLatinTerms, sharedChineseEntities,
} from '../src/llm/memory-cluster.mjs'

const NOW = Date.now()
const card = (id, content, over = {}) => ({ id, category: 'fact', subject: '用户', relation: '本人', content, importance: 0.5, emotion: 0, updatedAt: NOW, ...over })
const tmpFile = () => path.join(os.tmpdir(), `clu-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
const cleanup = (file) => { try { fs.rmSync(file, { force: true }) } catch (e) {} }

/** 一对**高度相似**的卡片（3-gram Jaccard ≈0.78，确实该合并） */
const NEAR_DUP = ['8月28日跟进行员信息同步模板获取', '8月28日跟进行员信息同步模板文件获取']
const MERGED_TEXT = '8月28日跟进行员信息同步模板与模板文件获取'

// ——— 阶段 A：种子扩张聚类 ———

test('precluster groups near-duplicates and never drags in a transitively-related card', () => {
  // a-b 相似、b-c 相似、a-c 不相似 —— 连通分量会把三条连成一片，种子扩张不会
  const a = card('a', '联合银行POC需求梳理', { importance: 0.9 })      // 最高分 → 种子
  const b = card('b', '联合银行POC需求梳理与统计安排', { importance: 0.5 })
  const c = card('c', '需求梳理与统计安排', { importance: 0.4 })
  const clusters = precluster([a, b, c])
  assert.equal(clusters.length, 1)
  assert.deepEqual(clusters[0].map((x) => x.id).sort(), ['a', 'b'])    // c 未被传递性拉入
})

test('precluster never mixes category or subject (identity/subject guard rail)', () => {
  const same = '完全一样的内容文本片段'
  const x = card('x', same)
  const y = card('y', same, { subject: '群A' })
  const z = card('z', same, { category: 'preference' })
  assert.deepEqual(precluster([x, y, z]), [])          // 没有同 (category, subject) 的一对
  assert.equal(precluster([x, card('w', same)]).length, 1)
})

test('precluster caps cluster size and splits the remainder into later clusters', () => {
  const cards = Array.from({ length: 20 }, (_, i) => card(`c${i}`, '完全相同的内容片段', { importance: 1 - i / 100 }))
  const clusters = precluster(cards, { maxCluster: 5 })
  assert.ok(clusters.every((cl) => cl.length <= 5))
  assert.equal(clusters.length, 4)                      // 20 / 5
  assert.equal(clusters.reduce((n, cl) => n + cl.length, 0), 20)   // 没有卡片丢失
})

test('precluster leaves dissimilar cards alone (no cluster at all)', () => {
  assert.deepEqual(precluster([card('a', '用户居住在深圳蛇口'), card('b', '明天下午三点开项目评审会')]), [])
  assert.deepEqual(precluster([card('only', '唯一的卡片')]), [])
})

// ——— 阶段 B：解析与 prompt ———

test('parseClusterResult tolerates prose around JSON and drops unusable entries', () => {
  assert.deepEqual(parseClusterResult('没有需要合并的'), [])
  assert.deepEqual(parseClusterResult(''), [])
  assert.equal(parseClusterResult('[{"cardIds":["a"],"content":"单条不算合并"}]').length, 0)
  assert.equal(parseClusterResult('[{"cardIds":["a","b"]}]').length, 0)          // 缺 content
  const ok = parseClusterResult('结果如下：[{"groupId":"g1","cardIds":["a","b"],"content":"合并内容"}] 完毕')
  assert.equal(ok.length, 1)
  assert.equal(ok[0].groupId, 'g1')
})

test('buildClusterPrompt packs groups with ids and demands verbatim numbers/dates', () => {
  const prompt = buildClusterPrompt([[card('a', '内容一'), card('b', '内容二')]])
  assert.match(prompt, /<group id="g1">/)
  assert.match(prompt, /"id":"a"/)
  assert.match(prompt, /数字、日期、专有名词/)
  assert.match(prompt, /不要硬凑/)
  assert.match(prompt, /不得跨组合并/)
})

// ——— 安全网 2：信息保留校验 ———

test('verifyMerge accepts a faithful summary (date formats are normalized)', () => {
  const originals = [{ content: '2026-08-28 跟进行员信息同步模板获取' }, { content: '8月28日跟进NAS数据定时清理' }]
  const result = verifyMerge(originals, '8月28日跟进昆山农商项目：行员信息同步模板与NAS数据定时清理')
  assert.equal(result.ok, true, result.reason)
})

test('verifyMerge rejects a summary that loses a latin term, a date, or a number', () => {
  const originals = [{ content: '跟进行员信息同步模板获取' }, { content: '跟进NAS数据定时清理' }]
  assert.equal(verifyMerge(originals, '行员信息同步与数据清理').ok, false)                 // NAS 丢失
  assert.equal(verifyMerge(originals, '行员信息同步模板与NAS数据定时清理').ok, true)

  const dated = [{ content: '8月28日跟进行员信息同步模板获取' }, { content: '8月28日跟进NAS数据定时清理' }]
  assert.equal(verifyMerge(dated, '8月29日跟进行员信息同步模板与NAS数据定时清理').ok, false)  // 日期被改
  assert.equal(verifyMerge(dated, '8月28日跟进行员信息同步模板与NAS数据定时清理').ok, true)

  const numbered = [{ content: '联合银行一期共12个子项' }, { content: '联合银行一期含SSO对接' }]
  assert.equal(verifyMerge(numbered, '联合银行一期子项与SSO对接').ok, false)                // 12 丢失
  assert.equal(verifyMerge(numbered, '联合银行一期12个子项与SSO对接').ok, true)

  assert.equal(verifyMerge(originals, '').ok, false)                                       // 空摘要
})

test('verifyMerge enforces shared-entity coverage: a renamed subject fails', () => {
  const originals = [{ content: '昆山农商项目需要行员信息同步' }, { content: '昆山农商项目需要数据清理' }]
  assert.equal(verifyMerge(originals, '昆山农商项目：行员信息同步与数据清理').ok, true)
  const renamed = verifyMerge(originals, '某个银行项目：行员信息同步与数据清理')
  assert.equal(renamed.ok, false)
  assert.match(renamed.reason, /entity coverage/)
})

test('extractors: dates normalize, numbers exclude date parts, entities are 3-4 char fragments', () => {
  assert.deepEqual([...collectDates([{ content: '2026-08-28 与 8月28日 与 8/28' }])], ['8-28'])
  assert.deepEqual([...collectNumbers([{ content: '8月28日 fineBI 7.0 共12项' }])].sort(), ['12', '7.0'])
  const terms = [...collectLatinTerms([{ content: 'fineBI 与 NAS 与 a 与 v8.88' }])]
  assert.ok(terms.includes('fineBI') && terms.includes('NAS') && terms.includes('v8.88'))
  assert.ok(!terms.includes('a'))                       // 单字噪声被过滤
  const shared = sharedChineseEntities([{ content: '昆山农商项目需要行员信息同步' }, { content: '昆山农商项目需要数据清理' }])
  assert.ok(shared.includes('昆山农'))
  // 只取 3-4 字：2 字片段（"需要"这类）不进集合，否则覆盖率随措辞抖动
  assert.ok(shared.every((fragment) => fragment.length >= 3 && fragment.length <= 4))
})

// ——— 端到端：compress ———

function makePair(store) {
  const a = store.insert('u1', { category: 'fact', content: NEAR_DUP[0] })
  const b = store.insert('u1', { category: 'fact', content: NEAR_DUP[1] })
  return { a, b }
}

test('compress merges a candidate cluster, archives sources, and is idempotent', async () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    const { a, b } = makePair(store)
    const other = store.insert('u1', { category: 'fact', content: '用户居住在深圳蛇口' })
    const clusterer = new MemoryClusterer({
      complete: async () => JSON.stringify([{
        groupId: 'g1',
        cardIds: [a.id, b.id],
        content: MERGED_TEXT,
        context: '合并自两条行员信息同步跟进记录',
      }]),
    })
    const out = await clusterer.compress(store, 'u1')
    assert.equal(out.clusters, 1)
    assert.equal(out.merged, 1)
    assert.equal(out.skipped, 0, JSON.stringify(out.details))

    const active = store.listActive('u1')
    assert.equal(active.length, 2)                                   // 合并卡 + 无关卡
    const merged = active.find((c) => c.content === MERGED_TEXT)
    assert.ok(merged)
    assert.deepEqual(merged.sourceIds.slice().sort(), [a.id, b.id].sort())
    assert.equal(store.get('u1', a.id).status, 'merged')
    assert.equal(store.get('u1', b.id).status, 'merged')
    assert.equal(store.get('u1', other.id).status, 'active')
    assert.equal(store.listArchived('u1').filter((x) => x.reason === 'merged').length, 2)

    // 幂等：原卡已 merged，不再进入候选
    const again = await clusterer.compress(store, 'u1')
    assert.equal(again.clusters, 0)
    assert.equal(again.merged, 0)
    assert.equal(store.listActive('u1').length, 2)
  } finally { cleanup(file) }
})

test('compress refuses a merge that would lose information (cards stay independent)', async () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    const { a, b } = makePair(store)
    const clusterer = new MemoryClusterer({
      complete: async () => JSON.stringify([{ groupId: 'g1', cardIds: [a.id, b.id], content: '跟进了一些项目事项' }]),
    })
    const out = await clusterer.compress(store, 'u1')
    assert.equal(out.merged, 0)
    assert.equal(out.skipped, 1)
    assert.match(out.details[0].reason, /date lost|number lost|entity coverage|term lost/)
    assert.equal(store.get('u1', a.id).status, 'active')             // 保守回退：原卡保持独立
    assert.equal(store.get('u1', b.id).status, 'active')
    assert.deepEqual(store.listArchived('u1'), [])
  } finally { cleanup(file) }
})

test('compress refuses cross-cluster card ids coming from the model', async () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    const { a } = makePair(store)
    const outsider = store.insert('u1', { category: 'fact', content: '用户居住在深圳蛇口' })
    const clusterer = new MemoryClusterer({
      complete: async () => JSON.stringify([{ groupId: 'g1', cardIds: [a.id, outsider.id], content: MERGED_TEXT }]),
    })
    const out = await clusterer.compress(store, 'u1')
    assert.equal(out.merged, 0)
    assert.equal(out.skipped, 1)
    assert.match(out.details[0].reason, /not in one candidate cluster/)
    assert.equal(store.get('u1', a.id).status, 'active')
    assert.equal(store.get('u1', outsider.id).status, 'active')
  } finally { cleanup(file) }
})

test('compress survives an LLM failure without touching any card', async () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    const { a, b } = makePair(store)
    const clusterer = new MemoryClusterer({ complete: async () => { throw new Error('boom') } })
    const out = await clusterer.compress(store, 'u1')
    assert.equal(out.merged, 0)
    assert.ok(out.skipped > 0)
    assert.match(out.details[0].reason, /llm error/)
    assert.equal(store.get('u1', a.id).status, 'active')
    assert.equal(store.get('u1', b.id).status, 'active')
  } finally { cleanup(file) }
})

test('compress excludes todos and generalized cards from clustering (guard rails)', async () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    store.insert('u1', { category: 'todo', subject: '用户', content: '完全相同的内容片段' })
    store.insert('u1', { category: 'todo', subject: '群A', content: '完全相同的内容片段' })
    store.insert('u1', { kind: 'generalized', category: 'fact', subject: '用户', content: '完全相同的内容片段' })
    store.insert('u1', { kind: 'generalized', category: 'fact', subject: '群B', content: '完全相同的内容片段' })
    let called = 0
    const clusterer = new MemoryClusterer({ complete: async () => { called++; return '[]' } })
    const out = await clusterer.compress(store, 'u1')
    assert.equal(out.clusters, 0)
    assert.equal(called, 0)                       // 没有候选簇 → 一次 LLM 都不该调用
  } finally { cleanup(file) }
})
