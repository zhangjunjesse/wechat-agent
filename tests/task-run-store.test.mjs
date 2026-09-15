import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { TaskRunStore } from '../src/services/task-run-store.mjs'

function setup() {
  const file = path.join(os.tmpdir(), `tstore-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  return { file, store: new TaskRunStore({ file }) }
}

test('create → running → settle(done); terminal state is immutable (first result wins)', () => {
  const { file, store } = setup()
  try {
    const t = store.create({ userId: 'u1', goal: '导出文档', context: '链接 X' })
    assert.equal(t.status, 'pending')
    assert.match(t.id, /^task-\d+$/)
    store.markRunning(t.id)
    assert.equal(store.get(t.id).status, 'running')
    const done = store.settle(t.id, { status: 'done', result: '已发送 报告.pdf' })
    assert.equal(done.status, 'done')
    assert.ok(done.finishedAt >= done.startedAt)
    // 晚到的结果被丢弃（首次结果优先）
    const late = store.settle(t.id, { status: 'failed', error: 'late failure' })
    assert.equal(late.status, 'done')
    assert.equal(late.error, '')
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})

test('notify flag is claimed exactly once', () => {
  const { file, store } = setup()
  try {
    const t = store.create({ userId: 'u1', goal: 'x' })
    store.settle(t.id, { status: 'done', result: 'ok' })
    assert.equal(store.markNotified(t.id), true)
    assert.equal(store.markNotified(t.id), false) // 第二次抢不到通知权
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})

test('retry resets a terminal task to pending and bumps attempts', () => {
  const { file, store } = setup()
  try {
    const t = store.create({ userId: 'u1', goal: 'x' })
    store.markRunning(t.id)
    store.settle(t.id, { status: 'failed', error: 'boom' })
    const again = store.markRetry(t.id)
    assert.equal(again.status, 'pending')
    assert.equal(again.attempts, 2)
    assert.equal(again.error, '')
    assert.equal(again.notified, false)
    // 运行中的任务不能重试
    store.markRunning(t.id)
    assert.equal(store.markRetry(t.id), null)
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})

test('tasks are per-user isolated; runningCount drives concurrency', () => {
  const { file, store } = setup()
  try {
    const a = store.create({ userId: 'u1', goal: 'a' })
    store.create({ userId: 'u2', goal: 'b' })
    assert.equal(store.listByUser('u1').length, 1)
    assert.equal(store.listByUser('u2').length, 1)
    assert.equal(store.runningCount('u1'), 1)
    store.markRunning(a.id)
    store.settle(a.id, { status: 'done', result: 'ok' })
    assert.equal(store.runningCount('u1'), 0)
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})

test('stats surface the calibration signals (short-task rate / failure rate / avg seconds)', () => {
  const { file, store } = setup()
  try {
    const now = Date.now()
    const fast = store.create({ userId: 'u1', goal: 'fast', createdAt: now - 1000 })
    store.markRunning(fast.id, now - 800)
    store.settle(fast.id, { status: 'done', result: 'ok', atMs: now - 780 }) // 0.02s → 短任务
    const slow = store.create({ userId: 'u1', goal: 'slow' })
    store.markRunning(slow.id, now - 90_000)
    store.settle(slow.id, { status: 'done', result: 'ok', atMs: now - 30_000 }) // 60s
    const bad = store.create({ userId: 'u1', goal: 'bad' })
    store.settle(bad.id, { status: 'failed', error: 'x' })
    const s = store.stats()
    assert.equal(s.total, 3)
    assert.equal(s.done, 2)
    assert.equal(s.failed, 1)
    assert.ok(s.shortTaskRate > 0, `shortTaskRate=${s.shortTaskRate}`) // 判据过松信号
    assert.ok(s.failureRate > 0)
    assert.ok(s.avgSeconds >= 30)
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})

test('pruneFinished removes old terminal tasks only', () => {
  const { file, store } = setup()
  try {
    const old = store.create({ userId: 'u1', goal: 'old', createdAt: Date.now() - 30 * 86_400_000 })
    store.markRunning(old.id, Date.now() - 30 * 86_400_000)
    store.settle(old.id, { status: 'done', result: 'x', atMs: Date.now() - 30 * 86_400_000 })
    const running = store.create({ userId: 'u1', goal: 'running' })
    store.markRunning(running.id)
    const removed = store.pruneFinished({ days: 7 })
    assert.equal(removed, 1)
    assert.equal(store.get(old.id), null)
    assert.ok(store.get(running.id)) // 进行中的不动
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})

test('ids continue after reopening the store', () => {
  const { file, store } = setup()
  try {
    store.create({ userId: 'u1', goal: 'a' })
    store.create({ userId: 'u1', goal: 'b' })
    store.close()
    const reopened = new TaskRunStore({ file })
    const t = reopened.create({ userId: 'u1', goal: 'c' })
    assert.equal(t.id, 'task-3') // 不重复 id
    reopened.close()
  } finally {
    fs.rmSync(file, { force: true })
  }
})
