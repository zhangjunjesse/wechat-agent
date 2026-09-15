import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../src/services/memory-store.mjs'

const tmpFile = () => path.join(os.tmpdir(), `mem-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
const cleanup = (file) => { try { fs.rmSync(file, { force: true }) } catch (e) {} }

test('memory store inserts, dedupes by content, and isolates', () => {
  const file = path.join(os.tmpdir(), `mem-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  try {
    const store = new MemoryStore({ file })
    store.insert('u1', { category: 'identity', content: '叫俊哥' })
    assert.equal(store.list('u1').length, 1)
    // same content dedupes
    store.insert('u1', { category: 'identity', content: '叫俊哥' })
    assert.equal(store.list('u1').length, 1)
    // isolation
    assert.equal(store.list('u2').length, 0)
  } finally {
    try { fs.rmSync(file, { force: true }) } catch (e) {}
  }
})

test('conflict resolution: update replaces same key; different relation coexists', () => {
  const file = path.join(os.tmpdir(), `mem-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  try {
    const store = new MemoryStore({ file })
    store.insert('u1', { category: 'identity', content: '叫俊哥' })
    store.update('u1', { category: 'identity', content: '现在别叫俊哥' })
    assert.equal(store.list('u1').length, 1)
    assert.equal(store.list('u1')[0].content, '现在别叫俊哥')

    // same subject "张医生", different relation → coexist
    store.insert('u1', { category: 'fact', subject: '张医生', relation: '牙科医生', content: '是用户自己的牙科医生' })
    store.insert('u1', { category: 'fact', subject: '张医生', relation: '父亲的心脏病医生', content: '是用户父亲的心脏病医生' })
    const zhang = store.list('u1').filter((c) => c.subject === '张医生')
    assert.equal(zhang.length, 2)
  } finally {
    try { fs.rmSync(file, { force: true }) } catch (e) {}
  }
})

test('different content coexists (two cars are two memories)', () => {
  const file = path.join(os.tmpdir(), `mem-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  try {
    const store = new MemoryStore({ file })
    store.insert('u1', { category: 'fact', subject: '车', content: '有一辆特斯拉' })
    store.insert('u1', { category: 'fact', subject: '车', content: '有一辆宝马' })
    assert.equal(store.list('u1').length, 2)
  } finally {
    try { fs.rmSync(file, { force: true }) } catch (e) {}
  }
})

// ——— v2（DESIGN-memory-lifecycle）：迁移 / 归档 / 访问统计 / 合并 / 档案 / 维护 ———

test('v2 migration: a legacy DB gains every column and table, old rows stay readable', () => {
  const file = tmpFile()
  try {
    const legacy = new DatabaseSync(file)
    legacy.exec(`CREATE TABLE memories (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, category TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '用户', relation TEXT NOT NULL DEFAULT '本人',
      content TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', due INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
    legacy.prepare('INSERT INTO memories (id,user_id,type,category,subject,relation,content,context,due,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run('old-1', 'u1', 'semantic', 'identity', '用户', '本人', '叫俊哥', '', 0, 1, 1)
    legacy.close()

    const store = new MemoryStore({ file })          // 触发逐列迁移
    const card = store.get('u1', 'old-1')
    assert.equal(card.content, '叫俊哥')              // 老数据可读
    assert.equal(card.status, 'active')              // 新列拿到默认值
    assert.equal(card.kind, 'atomic')
    assert.equal(card.importance, 0.5)
    assert.deepEqual(card.sourceIds, [])
    assert.equal(card.accessCount, 0)
    // 三张新表可用
    assert.equal(store.getProfile('u1'), null)
    assert.equal(store.getMaintenance('u1').lastRunAt, 0)
    assert.deepEqual(store.listArchived('u1'), [])
    assert.equal(store.listActive('u1').length, 1)
    // 重新打开（迁移可重入）
    assert.equal(new MemoryStore({ file }).listActive('u1').length, 1)
  } finally { cleanup(file) }
})

test('archive hides a card from active lists but keeps a restorable payload', () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    const card = store.insert('u1', { category: 'fact', content: '有一辆特斯拉' })
    assert.equal(store.listActive('u1').length, 1)
    assert.equal(store.archive('u1', [card.id], 'low_importance', 1000), 1)
    assert.equal(store.listActive('u1').length, 0)       // 召回看不见
    assert.equal(store.list('u1').length, 1)             // 没被物理删除
    assert.equal(store.get('u1', card.id).status, 'archived')
    const archived = store.listArchived('u1')
    assert.equal(archived.length, 1)
    assert.equal(archived[0].reason, 'low_importance')
    assert.equal(archived[0].card.content, '有一辆特斯拉') // payload 完整可审计
    // 归档不改 updated_at（归档不是"活动"）
    assert.equal(store.get('u1', card.id).updatedAt, card.updatedAt)
    // 回滚
    assert.equal(store.restore('u1', [card.id], 2000), 1)
    assert.equal(store.listActive('u1').length, 1)
    assert.equal(store.listArchived('u1')[0].restoredAt, 2000)
  } finally { cleanup(file) }
})

test('markAccessed bumps only that user\'s listed cards (the recall feedback signal)', () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    const a = store.insert('u1', { category: 'fact', content: '住蛇口' })
    const b = store.insert('u1', { category: 'fact', content: '工作在南山' })
    store.insert('u2', { category: 'fact', content: '别人的卡片' })
    assert.equal(store.markAccessed('u1', [a.id, a.id, b.id], 5000), 2)  // 去重后命中 2 条
    const cards = Object.fromEntries(store.listActive('u1').map((c) => [c.id, c]))
    assert.equal(cards[a.id].accessCount, 1)
    assert.equal(cards[a.id].lastAccessAt, 5000)
    assert.equal(cards[b.id].accessCount, 1)
    // 其他用户不受影响
    assert.equal(store.listActive('u2')[0].accessCount, 0)
    // 跨用户越权：非本人 id 不生效
    assert.equal(store.markAccessed('u1', ['not-mine'], 6000), 0)
  } finally { cleanup(file) }
})

test('mergeInto inserts the merged card and archives the sources as merged', () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    const a = store.insert('u1', { category: 'fact', content: '8月28日跟进NAS数据定时清理' })
    const b = store.insert('u1', { category: 'fact', content: '8月28日跟进行员信息同步模板' })
    const merged = store.mergeInto('u1', [a.id, b.id], { category: 'fact', content: '8月28日跟进昆山农商项目：NAS数据定时清理与行员信息同步模板' }, 3000)
    assert.ok(merged)
    assert.deepEqual(merged.sourceIds.slice().sort(), [a.id, b.id].sort())
    assert.equal(store.listActive('u1').length, 1)                        // 只剩合并卡
    assert.equal(store.get('u1', a.id).status, 'merged')
    assert.equal(store.get('u1', b.id).status, 'merged')
    assert.equal(store.listArchived('u1').filter((x) => x.reason === 'merged').length, 2)
    // 幂等：源卡已非 active，再合并不动它们
    assert.equal(store.listActiveUserIds().length, 1)
    assert.equal(store.countActive('u1'), 1)
  } finally { cleanup(file) }
})

test('profile is a rebuildable projection; maintenance tracks dirty/run state', () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    assert.equal(store.getProfile('u1'), null)          // 无档案 → recall 走回退路径
    const first = store.upsertProfile('u1', '【工作背景】（暂无）\n【个人背景】偏好结构化回复', 3, 5000)
    assert.equal(first.version, 1)
    assert.equal(first.sourceCount, 3)
    const second = store.upsertProfile('u1', '【工作背景】信格科技', 4, 6000)
    assert.equal(second.version, 2)                     // 重建递增版本
    assert.equal(second.generatedAt, 6000)

    store.touchChange('u1', 7000)
    assert.equal(store.getMaintenance('u1').lastChangeAt, 7000)
    store.markMaintenanceRun('u1', 8000, 'archived=1 merged=2 generalized=1')
    const m = store.getMaintenance('u1')
    assert.equal(m.lastRunAt, 8000)
    assert.match(m.lastResult, /merged=2/)
    assert.equal(m.lastChangeAt, 7000)                  // 跑维护不清脏标记
  } finally { cleanup(file) }
})

test('insert/update mark the user dirty so maintenance can find active users', () => {
  const file = tmpFile()
  try {
    const store = new MemoryStore({ file })
    assert.deepEqual(store.listActiveUserIds(), [])
    store.insert('u1', { category: 'fact', content: '住蛇口' })
    assert.ok(store.getMaintenance('u1').lastChangeAt > 0)
    assert.deepEqual(store.listActiveUserIds(), ['u1'])
    // 归档掉最后一张 active 卡后，该用户不再进入维护扫描
    const card = store.listActive('u1')[0]
    store.archive('u1', [card.id], 'low_importance', 9000)
    assert.deepEqual(store.listActiveUserIds(), [])
  } finally { cleanup(file) }
})
