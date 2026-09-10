import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { TaskStore } from '../src/services/task-store.mjs'

function makeStore() {
  const file = path.join(os.tmpdir(), `tsk-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  return { file, store: new TaskStore({ file }) }
}

test('user task CRUD is owner-scoped', () => {
  const { file, store } = makeStore()
  try {
    store.createUserTask({ name: '每日总结', schedule: 'daily@22:00', instruction: '回顾今天', ownerUserId: 'u1' })
    const mine = store.listUserTasks('u1')
    assert.equal(mine.length, 1)
    assert.equal(mine[0].name, '每日总结')
    assert.equal(mine[0].scope, 'user')
    assert.equal(store.listUserTasks('u2').length, 0)
    // duplicate name rejected
    assert.throws(() => store.createUserTask({ name: '每日总结', schedule: 'daily@22:00', instruction: 'x', ownerUserId: 'u1' }), /已存在/)
    // bad schedule rejected
    assert.throws(() => store.createUserTask({ name: '坏任务', schedule: 'nope', instruction: 'x', ownerUserId: 'u1' }), /非法调度/)
    // delete only by owner
    assert.equal(store.deleteUserTask({ ownerUserId: 'u2', name: '每日总结' }), false)
    assert.equal(store.deleteUserTask({ ownerUserId: 'u1', name: '每日总结' }), true)
    assert.equal(store.listUserTasks('u1').length, 0)
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

test('global tasks: subscribe/unsubscribe isolation and config upsert keeps subscribers', () => {
  const { file, store } = makeStore()
  try {
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', instruction: '早报v1' }])
    assert.equal(store.listGlobalTasks().length, 1)
    store.subscribe('每日早报', 'u1')
    store.subscribe('每日早报', 'u2')
    assert.equal(store.isSubscribed('每日早报', 'u1'), true)
    assert.equal(store.isSubscribed('每日早报', 'u2'), true)
    assert.equal(store.isSubscribed('每日早报', 'u3'), false)
    // config reload updates schedule/instruction but preserves subscribers
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@07:30', instruction: '早报v2' }])
    const t = store.listGlobalTasks()[0]
    assert.equal(t.schedule, 'daily@07:30')
    assert.equal(t.instruction, '早报v2')
    assert.deepEqual(t.subscribers, ['u1', 'u2'])
    // unsubscribe only affects the caller
    assert.equal(store.unsubscribe('每日早报', 'u1'), true)
    assert.equal(store.isSubscribed('每日早报', 'u1'), false)
    assert.equal(store.isSubscribed('每日早报', 'u2'), true)
    assert.throws(() => store.subscribe('不存在', 'u1'), /不存在/)
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

test('markRun records last run and error', () => {
  const { file, store } = makeStore()
  try {
    const t = store.createUserTask({ name: 'x', schedule: 'daily@08:00', instruction: 'i', ownerUserId: 'u1' })
    store.markRun(t.id, 1234567, 'boom')
    const after = store.getTask(t.id)
    assert.equal(after.lastRunAt, 1234567)
    assert.equal(after.lastError, 'boom')
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})
