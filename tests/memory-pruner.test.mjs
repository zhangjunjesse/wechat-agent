import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { MemoryStore } from '../src/services/memory-store.mjs'
import { pruneTodos, TODO_AGED_DAYS } from '../src/services/memory-pruner.mjs'

const DAY = 86400000
// 相对基准：卡片 updatedAt 由真实时钟写入，测试必须以真实 now 为起点做偏移，
// 否则硬编码日期会在 7/15 天边界上产生假失败。
const NOW = Date.now()

function newStore() {
  const file = path.join(os.tmpdir(), `prune-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  return { file, store: new MemoryStore({ file }) }
}
const cleanup = (file) => { try { fs.rmSync(file, { force: true }) } catch (e) {} }

test('pruneTodos archives todos whose due date is overdue beyond the grace window', () => {
  const { file, store } = newStore()
  try {
    const fresh = store.insert('u1', { category: 'todo', content: '今天要交的方案', due: NOW - 3 * DAY })
    const stale = store.insert('u1', { category: 'todo', content: '两周前就该做的事', due: NOW - 9 * DAY })
    const out = pruneTodos(store, 'u1', NOW)
    assert.equal(out.expired, 1)
    assert.equal(out.archived, 1)
    assert.deepEqual(store.listCategory('u1', 'todo').map((c) => c.id), [fresh.id])   // 宽限期内保留
    assert.equal(store.get('u1', stale.id).status, 'archived')
    assert.equal(store.listArchived('u1')[0].reason, 'expired_todo')
  } finally { cleanup(file) }
})

test('pruneTodos archives due-less todos untouched beyond the aging window', () => {
  const { file, store } = newStore()
  try {
    const card = store.insert('u1', { category: 'todo', content: '查看群里发的图片' })
    // 用 now 参数模拟时间流逝，而不是改库
    assert.equal(pruneTodos(store, 'u1', NOW + 5 * DAY).archived, 0)                 // 未到老化窗
    const out = pruneTodos(store, 'u1', NOW + (TODO_AGED_DAYS + 1) * DAY)
    assert.equal(out.aged, 1)
    assert.equal(out.archived, 1)
    assert.equal(store.get('u1', card.id).status, 'archived')
    assert.equal(store.listArchived('u1')[0].reason, 'aged_todo')
  } finally { cleanup(file) }
})

test('pruneTodos never touches identity/preference/fact, and spares fresh todos', () => {
  const { file, store } = newStore()
  try {
    const identity = store.insert('u1', { category: 'identity', content: '用户称呼为张工' })
    const preference = store.insert('u1', { category: 'preference', content: '偏好结构化回复' })
    const fact = store.insert('u1', { category: 'fact', content: '居住在深圳蛇口' })
    const todo = store.insert('u1', { category: 'todo', content: '跟进 NAS 清理' })
    const out = pruneTodos(store, 'u1', NOW + 400 * DAY)          // 极久之后
    assert.equal(out.archived, 1)                                  // 只有那条无 due 的 todo
    for (const id of [identity.id, preference.id, fact.id]) {
      assert.equal(store.get('u1', id).status, 'active')           // 保护栏：永不自动清理
    }
    assert.equal(store.get('u1', todo.id).status, 'archived')
  } finally { cleanup(file) }
})

test('pruned todos stay restorable (archive, not delete)', () => {
  const { file, store } = newStore()
  try {
    const card = store.insert('u1', { category: 'todo', content: '查看四川银行群里发的图片' })
    pruneTodos(store, 'u1', NOW + (TODO_AGED_DAYS + 2) * DAY)
    assert.equal(store.listCategory('u1', 'todo').length, 0)
    assert.equal(store.restore('u1', [card.id], NOW), 1)           // 可回滚
    assert.equal(store.listCategory('u1', 'todo').length, 1)
  } finally { cleanup(file) }
})

test('pruneTodos is per-user: another user\'s identical todo is untouched', () => {
  const { file, store } = newStore()
  try {
    const mine = store.insert('u1', { category: 'todo', content: '查看图片' })
    const theirs = store.insert('u2', { category: 'todo', content: '查看图片' })
    pruneTodos(store, 'u1', NOW + 400 * DAY)
    assert.equal(store.get('u1', mine.id).status, 'archived')
    assert.equal(store.get('u2', theirs.id).status, 'active')      // 多租户隔离
  } finally { cleanup(file) }
})
