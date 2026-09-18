import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { AgentTaskStore } from '../src/services/agent-task-store.mjs'

function setup() {
  const file = path.join(os.tmpdir(), `board-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  return { file, store: new AgentTaskStore({ file }) }
}

test('create/get/list basics; deps derive blocked; claimable skips blocked and picks lowest id', () => {
  const { file, store } = setup()
  try {
    const a = store.create({ userId: 'u1', subject: '查资料', description: 'd' })
    const b = store.create({ userId: 'u1', subject: '写文档', description: 'd', blockedBy: [a.id] })
    const c = store.create({ userId: 'u1', subject: '发通知', description: 'd' })
    assert.equal(store.openBlockers(b.id).length, 1)
    assert.equal(store.openBlockers(a.id).length, 0)
    // 可认领：b 被阻塞跳过；a、c 里选最小 id = a
    assert.equal(store.nextClaimable('u1').id, a.id)
    assert.deepEqual(store.usersWithClaimable(), ['u1'])
    // a 完成 → b 解锁
    store.claim(a.id, 'worker:x')
    store.complete(a.id, { result: 'ok' })
    assert.equal(store.openBlockers(b.id).length, 0)
    assert.equal(store.nextClaimable('u1').id, b.id)
    // 列表：活跃按 id 升序 + openBlockerIds
    const list = store.list('u1')
    assert.deepEqual(list.map((t) => t.id), [b.id, c.id])
    assert.equal(list[0].openBlockerIds.length, 0)
    // includeCompleted 追加已完成
    const withDone = store.list('u1', { includeCompleted: true })
    assert.ok(withDone.some((t) => t.id === a.id && t.status === 'completed'))
  } finally { store.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('claim is a CAS: exactly one winner (A2)', () => {
  const { file, store } = setup()
  try {
    const t = store.create({ userId: 'u1', subject: 's', description: 'd' })
    const first = store.claim(t.id, 'worker:a')
    const second = store.claim(t.id, 'worker:b')
    assert.ok(first)
    assert.equal(first.owner, 'worker:a')
    assert.equal(second, null)
  } finally { store.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('dependency cycles are rejected (A4); cross-user deps rejected', () => {
  const { file, store } = setup()
  try {
    const a = store.create({ userId: 'u1', subject: 'a', description: '' })
    const b = store.create({ userId: 'u1', subject: 'b', description: '', blockedBy: [a.id] })
    // a blockedBy b → a→b→a 成环
    assert.throws(() => store.update(a.id, 'u1', { addBlockedBy: [b.id] }), /成环/)
    // 传递环：c blockedBy b, a blockedBy c
    const c = store.create({ userId: 'u1', subject: 'c', description: '', blockedBy: [b.id] })
    assert.throws(() => store.update(a.id, 'u1', { addBlockedBy: [c.id] }), /成环/)
    // 自阻塞
    assert.throws(() => store.update(a.id, 'u1', { addBlockedBy: [a.id] }), /自己/)
    // 跨用户
    const other = store.create({ userId: 'u2', subject: 'x', description: '' })
    assert.throws(() => store.update(a.id, 'u1', { addBlockedBy: [other.id] }), /不存在/)
  } finally { store.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('cross-user isolation (A5): get/list/update never see another user\'s tasks', () => {
  const { file, store } = setup()
  try {
    const mine = store.create({ userId: 'u1', subject: 's', description: '' })
    assert.equal(store.get(mine.id, 'u2'), null)
    assert.equal(store.getDetail(mine.id, 'u2'), null)
    assert.equal(store.list('u2').length, 0)
    assert.equal(store.update(mine.id, 'u2', { subject: 'hacked' }), null)
    assert.equal(store.get(mine.id, 'u1').subject, 's')
  } finally { store.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('terminal states are immutable; completed requires no open blockers', () => {
  const { file, store } = setup()
  try {
    const a = store.create({ userId: 'u1', subject: 'a', description: '' })
    const b = store.create({ userId: 'u1', subject: 'b', description: '', blockedBy: [a.id] })
    assert.throws(() => store.update(b.id, 'u1', { status: 'completed' }), /前置任务/)
    store.update(a.id, 'u1', { status: 'completed' })
    store.update(b.id, 'u1', { status: 'completed' }) // 解锁后允许
    assert.throws(() => store.update(b.id, 'u1', { status: 'pending' }), /终态/)
    const del = store.create({ userId: 'u1', subject: 'd', description: '' })
    store.update(del.id, 'u1', { status: 'deleted' })
    assert.throws(() => store.update(del.id, 'u1', { status: 'pending' }), /终态/)
    // deleted 不出现在任何列表
    assert.ok(!store.list('u1', { includeCompleted: true }).some((t) => t.id === del.id))
  } finally { store.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('manual retry (status→pending) resets owner/auto_attempts/last_error; auto_attempts gates claimable', () => {
  const { file, store } = setup()
  try {
    const t = store.create({ userId: 'u1', subject: 's', description: '' })
    store.claim(t.id, 'worker:x')
    store.release(t.id, { error: 'boom', countAttempt: true })
    store.claim(t.id, 'worker:x')
    store.release(t.id, { error: 'boom', setAutoAttempts: 3 }) // 不可重试：直接顶到上限
    assert.equal(store.get(t.id).autoAttempts, 3)
    assert.equal(store.nextClaimable('u1', { maxAutoAttempts: 3 }), null, '退避上限后不再自动重挑')
    assert.equal(store.usersWithClaimable({ maxAutoAttempts: 3 }).length, 0)
    const back = store.update(t.id, 'u1', { status: 'pending' })
    assert.equal(back.autoAttempts, 0)
    assert.equal(back.lastError, '')
    assert.equal(back.owner, '')
    assert.ok(store.nextClaimable('u1'), '人工重试后重新可认领')
  } finally { store.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('recoverStale releases dead claims without charging the backoff budget (A3 board half)', () => {
  const { file, store } = setup()
  try {
    const t = store.create({ userId: 'u1', subject: 's', description: '' })
    store.claim(t.id, 'worker:dead-process:1')
    const released = store.recoverStale({ shouldRelease: (task) => !['worker:live'].includes(task.owner) })
    assert.equal(released.length, 1)
    const cur = store.get(t.id)
    assert.equal(cur.status, 'pending')
    assert.equal(cur.owner, '')
    assert.equal(cur.autoAttempts, 0, '重启恢复不占退避预算')
    // live owner 不被释放
    store.claim(t.id, 'worker:live')
    const again = store.recoverStale({ shouldRelease: (task) => task.owner !== 'worker:live' })
    assert.equal(again.length, 0)
    assert.equal(store.get(t.id).status, 'in_progress')
  } finally { store.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('complete() on a deleted task is a no-op (cancel semantics); metadata merge; activeForms; prune', () => {
  const { file, store } = setup()
  try {
    const t = store.create({ userId: 'u1', subject: 's', description: '', activeForm: '正在导出' })
    store.claim(t.id, 'worker:x')
    assert.deepEqual(store.activeForms('u1'), [{ id: t.id, text: '正在导出' }])
    store.update(t.id, 'u1', { status: 'deleted' })
    assert.equal(store.complete(t.id, { result: 'late' }), null)
    assert.equal(store.get(t.id).status, 'deleted')
    // metadata 浅合并 + null 删键
    const m = store.create({ userId: 'u1', subject: 'm', description: '' })
    store.update(m.id, 'u1', { metadata: { a: 1, b: 2 } })
    store.update(m.id, 'u1', { metadata: { b: null, c: 3 } })
    assert.deepEqual(store.get(m.id).metadata, { a: 1, c: 3 })
    // prune：老的终态被删、边表清孤儿
    const old = store.create({ userId: 'u1', subject: 'old', description: '', now: Date.now() - 40 * 86_400_000 })
    store.claim(old.id, 'w'); store.complete(old.id, { now: Date.now() - 40 * 86_400_000 })
    assert.equal(store.pruneFinished({ days: 30 }), 1)
    assert.equal(store.get(old.id), null)
  } finally { store.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('board state survives reopen (SQLite is the authority, not process memory)', () => {
  const file = path.join(os.tmpdir(), `board-reopen-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const s1 = new AgentTaskStore({ file })
  const t = s1.create({ userId: 'u1', subject: 's', description: 'd' })
  s1.claim(t.id, 'worker:old')
  s1.close()
  const s2 = new AgentTaskStore({ file })
  try {
    const cur = s2.get(t.id)
    assert.equal(cur.status, 'in_progress')
    assert.equal(cur.owner, 'worker:old')
  } finally { s2.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }) }
})
