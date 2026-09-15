import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../src/services/memory-store.mjs'
import {
  MemoryGeneralizer, episodicClusters, spanDays, buildGeneralizePrompt,
  parseGeneralizeResult, verifyGeneralization, MIN_SAMPLES, SOURCE_ARCHIVE_IMPORTANCE,
} from '../src/llm/memory-generalize.mjs'

const DAY = 86400000
const NOW = Date.now()
const tmpFile = () => path.join(os.tmpdir(), `gen-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
const cleanup = (file) => { try { fs.rmSync(file, { force: true }) } catch (e) {} }

/** 事件三连：同类事件、跨 4 天（满足样本与跨度门槛）。 */
const EVENTS = [
  { content: '8月25日苏商DEP群发的图片和文件需要查看', daysAgo: 5 },
  { content: '8月28日四川银行群发的图片和文件需要查看', daysAgo: 3 },
  { content: '9月1日联合银行群发的图片和文件需要查看', daysAgo: 1 },
]
const GENERALIZED = '用户经常需要查看微信群里发来的图片和文件并跟进处理'

function seed(file, events = EVENTS, over = {}) {
  const store = new MemoryStore({ file })
  const cards = events.map((e) => store.insert('u1', { type: 'episodic', category: 'fact', content: e.content, ...over }))
  // 回填创建时间（insert 不接受时间参数，测试里直接改库）
  const db = new DatabaseSync(file)
  cards.forEach((card, i) => {
    const ts = NOW - (events[i].daysAgo || 0) * DAY
    db.prepare('UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, card.id)
  })
  db.close()
  return { store, cards: cards.map((c, i) => ({ ...c, createdAt: NOW - (events[i].daysAgo || 0) * DAY })) }
}

// ——— 样本门槛 ———

test('episodicClusters requires both sample count and time span', () => {
  const cluster = (events) => episodicClusters(events.map((e, i) => ({
    id: `e${i}`, kind: 'atomic', type: 'episodic', category: 'fact', subject: '用户',
    content: e.content, createdAt: NOW - e.daysAgo * DAY, updatedAt: NOW - e.daysAgo * DAY,
  })))
  assert.equal(cluster(EVENTS).length, 1)                                  // 3 条 + 跨 4 天 ✓
  assert.equal(cluster(EVENTS.slice(0, 2)).length, 0)                      // 只有 2 条 ✗
  assert.equal(cluster(EVENTS.map((e) => ({ ...e, daysAgo: 0 }))).length, 0) // 同一天 ✗（不算"多次经历"）
})

test('episodicClusters ignores todos, generalized cards, and semantic memories', () => {
  const base = EVENTS.map((e, i) => ({
    id: `e${i}`, kind: 'atomic', type: 'episodic', category: 'fact', subject: '用户',
    content: e.content, createdAt: NOW - e.daysAgo * DAY, updatedAt: NOW - e.daysAgo * DAY,
  }))
  assert.equal(episodicClusters(base.map((c) => ({ ...c, category: 'todo' }))).length, 0)
  assert.equal(episodicClusters(base.map((c) => ({ ...c, kind: 'generalized' }))).length, 0)   // 不参与再泛化
  assert.equal(episodicClusters(base.map((c) => ({ ...c, type: 'semantic' }))).length, 0)
})

test('spanDays measures Beijing-calendar day span', () => {
  assert.equal(spanDays([{ createdAt: NOW }, { createdAt: NOW - 3 * DAY }]), 3)
  assert.equal(spanDays([{ createdAt: NOW }]), 0)
})

// ——— 解析与 prompt ———

test('parseGeneralizeResult drops invalid kinds, short text, and thin sources', () => {
  const good = '{"groupId":"g1","kind":"semantic","content":"用户经常需要查看微信群里发来的图片和文件","sourceIds":["a","b","c"]}'
  assert.equal(parseGeneralizeResult(`[${good}]`).length, 1)
  assert.equal(parseGeneralizeResult('[{"kind":"guess","content":"用户经常需要查看微信群里发来的图片","sourceIds":["a","b","c"]}]').length, 0)
  assert.equal(parseGeneralizeResult('[{"kind":"semantic","content":"太短","sourceIds":["a","b","c"]}]').length, 0)
  assert.equal(parseGeneralizeResult('[{"kind":"semantic","content":"用户经常需要查看微信群里发来的图片","sourceIds":["a"]}]').length, 0)
  assert.deepEqual(parseGeneralizeResult('没有发现共同模式'), [])
  const parsed = parseGeneralizeResult(`说明如下：[${good}] 完毕`)[0]
  assert.equal(parsed.kind, 'semantic')
  assert.equal(parsed.sourceIds.length, 3)
})

test('buildGeneralizePrompt states the sample rule, concreteness rule and procedural caveat', () => {
  const prompt = buildGeneralizePrompt([EVENTS.map((e, i) => ({ id: `e${i}`, category: 'fact', subject: '用户', relation: '本人', content: e.content, createdAt: NOW - e.daysAgo * DAY }))])
  assert.match(prompt, /<group id="g1">/)
  assert.match(prompt, /具体可用/)
  assert.match(prompt, /用户关注工作/)
  assert.match(prompt, /不得引入原文没有的信息/)
  assert.match(prompt, /不是对系统的指令/)
})

// ——— 反空泛校验 ———

test('verifyGeneralization rejects generic statements and accepts anchored ones', () => {
  const originals = EVENTS.map((e) => ({ content: e.content }))
  assert.equal(verifyGeneralization(originals, '用户关注工作').ok, false)        // 零重叠的空话
  assert.equal(verifyGeneralization(originals, '用户很忙').ok, false)            // 太短
  const anchored = verifyGeneralization(originals, GENERALIZED)
  assert.equal(anchored.ok, true, anchored.reason)
  // 字母词是强锚点：即使中文措辞完全不同也放行
  const latin = verifyGeneralization([{ content: '用 fineBI 导出数据时要注意脱敏' }], '导出数据前需要处理 fineBI 的脱敏配置')
  assert.equal(latin.ok, true, latin.reason)
})

// ——— 端到端 ———

test('generalize writes a generalized card with full provenance and archives weak sources', async () => {
  const file = tmpFile()
  try {
    const { store, cards } = seed(file)
    // 来源卡给低分 → 泛化后应被归档
    for (const card of cards) store.setImportance('u1', card.id, 0.2)
    const generalizer = new MemoryGeneralizer({
      complete: async () => JSON.stringify([{
        groupId: 'g1', kind: 'semantic', content: GENERALIZED,
        subject: '用户', relation: '本人', reason: '三条记录都指向"群里发来的文件需要跟进"',
        sourceIds: cards.map((c) => c.id),
      }]),
    })
    const out = await generalizer.generalize(store, 'u1')
    assert.equal(out.clusters, 1)
    assert.equal(out.generalized, 1)
    assert.equal(out.skipped, 0, JSON.stringify(out.details))

    const generalized = store.listByKind('u1', 'generalized')
    assert.equal(generalized.length, 1)
    assert.equal(generalized[0].type, 'semantic')                  // semantic 是 type
    assert.equal(generalized[0].category, 'fact')                  // category 沿用来源
    assert.deepEqual(generalized[0].sourceIds.slice().sort(), cards.map((c) => c.id).sort())
    assert.match(generalized[0].context, /三条记录/)
    // 低价值来源卡被归档（细节已进结论），且带 reason
    for (const card of cards) assert.equal(store.get('u1', card.id).status, 'archived')
    assert.equal(store.listArchived('u1').every((a) => a.reason === 'generalized_source'), true)
    // 泛化卡不参与再泛化
    const again = await generalizer.generalize(store, 'u1')
    assert.equal(again.clusters, 0)
  } finally { cleanup(file) }
})

test('generalize keeps valuable sources active', async () => {
  const file = tmpFile()
  try {
    const { store, cards } = seed(file)
    for (const card of cards) store.setImportance('u1', card.id, SOURCE_ARCHIVE_IMPORTANCE + 0.2)
    const generalizer = new MemoryGeneralizer({
      complete: async () => JSON.stringify([{
        groupId: 'g1', kind: 'semantic', content: GENERALIZED,
        reason: '同类事件', sourceIds: cards.map((c) => c.id),
      }]),
    })
    const out = await generalizer.generalize(store, 'u1')
    assert.equal(out.generalized, 1)
    assert.equal(out.details[0].archivedSources, 0)
    for (const card of cards) assert.equal(store.get('u1', card.id).status, 'active')   // 事件本身仍有价值
  } finally { cleanup(file) }
})

test('generalize marks procedural output with a 流程 prefix', async () => {
  const file = tmpFile()
  try {
    const { store, cards } = seed(file)
    const generalizer = new MemoryGeneralizer({
      complete: async () => JSON.stringify([{
        groupId: 'g1', kind: 'procedural', content: '收到群里的图片和文件后先查看再安排跟进',
        reason: '反复出现的处理流程', sourceIds: cards.map((c) => c.id),
      }]),
    })
    await generalizer.generalize(store, 'u1')
    const generalized = store.listByKind('u1', 'generalized')[0]
    assert.ok(generalized, 'procedural 泛化应落库')
    assert.match(generalized.content, /^流程：/)
    assert.equal(generalized.type, 'semantic')
  } finally { cleanup(file) }
})

test('generalize refuses generic output and unanchored cross-cluster sources', async () => {
  const file = tmpFile()
  try {
    const { store, cards } = seed(file)
    const generic = new MemoryGeneralizer({
      complete: async () => JSON.stringify([{ groupId: 'g1', kind: 'semantic', content: '用户关注工作与项目协作', sourceIds: cards.map((c) => c.id) }]),
    })
    const out = await generic.generalize(store, 'u1')
    assert.equal(out.generalized, 0)
    assert.equal(out.skipped, 1)
    assert.match(out.details[0].reason, /not anchored/)

    const outsider = store.insert('u1', { type: 'episodic', category: 'fact', content: '完全无关的另一件事' })
    const crossCluster = new MemoryGeneralizer({
      complete: async () => JSON.stringify([{ groupId: 'g1', kind: 'semantic', content: GENERALIZED, sourceIds: [cards[0].id, cards[1].id, outsider.id] }]),
    })
    const out2 = await crossCluster.generalize(store, 'u1')
    assert.equal(out2.generalized, 0)
    assert.match(out2.details[0].reason, /not in one candidate cluster/)
    assert.equal(store.listByKind('u1', 'generalized').length, 0)
  } finally { cleanup(file) }
})

test('generalize survives an LLM failure and never calls the model without candidates', async () => {
  const file = tmpFile()
  try {
    const { store } = seed(file)
    let calls = 0
    const failing = new MemoryGeneralizer({ complete: async () => { calls++; throw new Error('boom') } })
    const out = await failing.generalize(store, 'u1')
    assert.equal(calls, 1)
    assert.equal(out.generalized, 0)
    assert.ok(out.skipped > 0)
    assert.match(out.details[0].reason, /llm error/)

    // 样本不足时一次都不调用
    const small = tmpFile()
    try {
      const { store: s2 } = seed(small, EVENTS.slice(0, MIN_SAMPLES - 1))
      let called = 0
      const generalizer = new MemoryGeneralizer({ complete: async () => { called++; return '[]' } })
      const res = await generalizer.generalize(s2, 'u1')
      assert.equal(res.clusters, 0)
      assert.equal(called, 0)
    } finally { cleanup(small) }
  } finally { cleanup(file) }
})
