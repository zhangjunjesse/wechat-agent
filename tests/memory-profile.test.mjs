import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../src/services/memory-store.mjs'
import { MemoryManager, PROFILE_TOKEN_BUDGET, TODO_RECALL_LIMIT } from '../src/llm/memory-manager.mjs'
import { MemoryExtractor } from '../src/llm/memory-extractor.mjs'
import {
  MemoryProfiler, buildProfilePrompt, parseProfileResult, PROFILE_SECTIONS, MIN_PROFILE_CARDS,
} from '../src/llm/memory-profile.mjs'

const NOW = Date.now()
const tmpFile = () => path.join(os.tmpdir(), `prof-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
const cleanup = (file) => { try { fs.rmSync(file, { force: true }) } catch (e) {} }
const noopExtractor = () => new MemoryExtractor({ complete: async () => '[]' })

function backdate(file, id, ms) {
  const db = new DatabaseSync(file)
  db.prepare('UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?').run(ms, ms, id)
  db.close()
}

// ——— 解析与 prompt ———

test('parseProfileResult keeps the four sections, fills missing ones, and clips length', () => {
  const raw = `【工作背景】
- 信格科技，负责 Agent 安全网关
【个人背景】
- 偏好简短直接、结构化（列表/表格）的回复
【当前关注】
- 推进 WorkBuddy 技能系统`
  const parsed = parseProfileResult(raw)
  for (const name of PROFILE_SECTIONS) assert.match(parsed, new RegExp(`【${name}】`))
  assert.match(parsed, /信格科技/)
  assert.match(parsed, /【近期动态】\n（暂无）/)          // 缺失段补「（暂无）」
  const long = parseProfileResult(`【工作背景】\n${'内容'.repeat(2000)}`)
  assert.ok(long.length <= 801, `超长档案应被截断，实际 ${long.length}`)
  assert.equal(parseProfileResult('没有分段标题的一段话'), null)
  assert.equal(parseProfileResult(''), null)
})

test('buildProfilePrompt demands the four sections and forbids speculation', () => {
  const prompt = buildProfilePrompt([{ category: 'fact', type: 'semantic', subject: '用户', relation: '本人', content: '居住在深圳蛇口' }], NOW)
  assert.match(prompt, /【工作背景】/)
  assert.match(prompt, /【个人背景】/)
  assert.match(prompt, /【当前关注】/)
  assert.match(prompt, /【近期动态】/)
  assert.match(prompt, /只写卡片支持的内容/)
  assert.match(prompt, /可操作的描述/)
  assert.match(prompt, /居住在深圳蛇口/)
})

// ——— 生成 ———

const PROFILE_TEXT = '【工作背景】\n信格科技\n【个人背景】\n偏好结构化回复\n【当前关注】\nAgent 安全网关\n【近期动态】\n（暂无）'

test('generate writes the profile as a projection and excludes the assistant name card', async () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    for (let i = 0; i < MIN_PROFILE_CARDS; i++) store.insert('u1', { category: 'fact', content: `事实条目${i}` })
    store.insert('u1', { category: 'identity', subject: '助手', relation: '助手', content: '助手命名为小新' })
    let seen = ''
    const profiler = new MemoryProfiler({ complete: async (messages) => { seen = messages[0].content; return PROFILE_TEXT } })
    const out = await profiler.generate(store, 'u1', NOW)
    assert.equal(out.ok, true)
    assert.equal(out.version, 1)
    assert.equal(out.cards, MIN_PROFILE_CARDS)              // 助手命名卡被排除
    assert.doesNotMatch(seen, /小新/)                        // 不进 prompt（单一来源 = assistantName）
    assert.equal(store.getProfile('u1').content, PROFILE_TEXT)
    // 再生成一次 → 版本递增（派生视图可反复重建）
    const again = await profiler.generate(store, 'u1', NOW + 1000)
    assert.equal(again.version, 2)
  } finally { cleanup(file) }
})

test('generate refuses too few cards and unparsable output, and survives LLM errors', async () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    store.insert('u1', { category: 'fact', content: '只有一条' })
    const few = new MemoryProfiler({ complete: async () => PROFILE_TEXT })
    const out = await few.generate(store, 'u1', NOW)
    assert.equal(out.ok, false)
    assert.match(out.reason, /too few cards/)
    assert.equal(store.getProfile('u1'), null)              // 不足时不生成

    for (let i = 0; i < MIN_PROFILE_CARDS; i++) store.insert('u1', { category: 'fact', content: `事实条目${i}` })
    const unparsable = new MemoryProfiler({ complete: async () => '随便一段没有分段的话' })
    assert.equal((await unparsable.generate(store, 'u1', NOW)).reason, 'unparsable output')
    const failing = new MemoryProfiler({ complete: async () => { throw new Error('boom') } })
    assert.match((await failing.generate(store, 'u1', NOW)).reason, /llm error/)
    assert.equal(store.getProfile('u1'), null)
  } finally { cleanup(file) }
})

// ——— 召回分层 ———

test('layered recall: profile → generalized → todo → recent, without re-injecting profile-era facts', () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    const at = new Date()
    const manager = new MemoryManager({ store, extractor: noopExtractor(), now: () => at })
    const oldFact = store.insert('u1', { category: 'fact', content: '用户居住在深圳蛇口' })
    backdate(file, oldFact.id, NOW - 2 * 3600 * 1000)                    // 档案之前的事实
    store.upsertProfile('u1', '【工作背景】\n信格科技\n【个人背景】\n偏好结构化回复', 3, NOW - 3600 * 1000)
    const todo = store.insert('u1', { category: 'todo', content: '跟进 NAS 数据清理' })
    const generalized = store.insert('u1', { kind: 'generalized', type: 'semantic', category: 'fact', content: '用户经常需要跟进微信群里的文件交付与确认' })
    const fresh = store.insert('u1', { category: 'fact', content: '今天确认了接口超时问题' })

    const text = manager.recall('u1')
    const pos = (needle) => text.indexOf(needle)
    assert.ok(pos('[用户档案]') >= 0)
    assert.match(text, /信格科技/)
    assert.ok(pos('【泛化】') > pos('[用户档案]'))
    assert.ok(pos('【待办】') > pos('【泛化】'))
    assert.ok(pos('【新近】') > pos('【待办】'))
    assert.match(text, /跟进微信群里的文件交付/)          // 泛化
    assert.match(text, /跟进 NAS 数据清理/)                // 待办
    assert.match(text, /今天确认了接口超时问题/)            // 新近（档案之后的增量）
    assert.doesNotMatch(text, /用户居住在深圳蛇口/)         // 档案时代的事实不重复注入
    assert.doesNotMatch(text, /\[用户长期记忆\]/)           // 有档案时走分层路径

    // 访问统计：只有真正注入的卡片计数，档案本身不计
    assert.equal(store.get('u1', fresh.id).accessCount, 1)
    assert.equal(store.get('u1', todo.id).accessCount, 1)
    assert.equal(store.get('u1', generalized.id).accessCount, 1)
    assert.equal(store.get('u1', oldFact.id).accessCount, 0)
  } finally { cleanup(file) }
})

test('layered recall falls back to the sectioned path when no profile exists', () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    const manager = new MemoryManager({ store, extractor: noopExtractor(), now: () => new Date() })
    store.insert('u1', { category: 'identity', content: '用户称呼为张工' })
    store.insert('u1', { category: 'preference', content: '偏好结构化回复' })
    const text = manager.recall('u1')
    assert.match(text, /\[用户长期记忆\]/)
    assert.match(text, /【身份】/)
    assert.match(text, /【偏好】/)
    assert.match(text, /张工/)
  } finally { cleanup(file) }
})

test('todo section is capped at TODO_RECALL_LIMIT with an overflow hint', () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    const manager = new MemoryManager({ store, extractor: noopExtractor(), now: () => new Date() })
    const total = TODO_RECALL_LIMIT + 5
    for (let i = 0; i < total; i++) store.insert('u1', { category: 'todo', content: `待办事项编号${i}` })
    store.upsertProfile('u1', '【工作背景】\n信格科技', total, NOW)
    const text = manager.recall('u1')
    assert.match(text, new RegExp(`另有 ${total - TODO_RECALL_LIMIT} 条待办`))
    assert.equal((text.match(/- 待办事项编号/g) || []).length, TODO_RECALL_LIMIT)
  } finally { cleanup(file) }
})

test('an oversized profile is clipped to its token budget during recall', () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    const manager = new MemoryManager({ store, extractor: noopExtractor(), now: () => new Date() })
    const huge = ['【工作背景】', ...Array.from({ length: 600 }, (_, i) => `- 第${i}行档案内容`), '【个人背景】', '（暂无）'].join('\n')
    store.upsertProfile('u1', huge, 10, NOW)
    const text = manager.recall('u1')
    assert.match(text, /\[用户档案\]/)
    assert.doesNotMatch(text, /第599行档案内容/)          // 尾部被预算截断
    assert.ok(PROFILE_TOKEN_BUDGET > 0)
  } finally { cleanup(file) }
})

test('a profile survives recall even when every card was archived (projection outlives cards)', () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    const manager = new MemoryManager({ store, extractor: noopExtractor(), now: () => new Date() })
    const card = store.insert('u1', { category: 'fact', content: '用户居住在深圳蛇口' })
    store.upsertProfile('u1', '【工作背景】\n信格科技', 1, NOW - 1000)
    store.archive('u1', [card.id], 'low_importance', NOW)
    const text = manager.recall('u1')
    assert.match(text, /\[用户档案\]/)                     // 档案仍注入
    assert.match(text, /信格科技/)
    assert.doesNotMatch(text, /蛇口/)                      // 归档卡不注入
    // 两者都空才返回空串
    assert.equal(manager.recall('nobody'), '')
  } finally { cleanup(file) }
})
