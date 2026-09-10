import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { TaskStore } from '../src/services/task-store.mjs'
import { taskTools } from '../src/tools/task-tools.mjs'

function call(toolFn, input, ctx) {
  return toolFn.invoke(ctx, JSON.stringify(input))
}

function setup() {
  const file = path.join(os.tmpdir(), `tk-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const store = new TaskStore({ file })
  const tools = taskTools({ taskStore: store })
  const ctx = (userId = 'u1') => ({ context: { userId } })
  return { file, store, tools, ctx }
}

test('create_task validates and lists; delete_task is owner-scoped', async () => {
  const { file, store, tools, ctx } = setup()
  try {
    const out = await call(tools.createTask, { name: '晨报', schedule: 'daily@08:30', instruction: '搜新闻', }, ctx('u1'))
    assert.match(out, /已创建定时任务「晨报」/)
    assert.match(out, /每天 08:30/)
    const bad = await call(tools.createTask, { name: '坏', schedule: '8点', instruction: 'x' }, ctx('u1'))
    assert.match(bad, /创建失败：非法调度/)
    const dup = await call(tools.createTask, { name: '晨报', schedule: 'daily@09:00', instruction: 'x' }, ctx('u1'))
    assert.match(dup, /已存在/)
    // u2 cannot see or delete u1's task
    const u2list = await call(tools.listMyTasks, {}, ctx('u2'))
    assert.match(u2list, /你还没有定时任务/)
    const del = await call(tools.deleteTask, { name: '晨报' }, ctx('u2'))
    assert.match(del, /不存在/)
    assert.equal(store.listUserTasks('u1').length, 1)
    const delOk = await call(tools.deleteTask, { name: '晨报' }, ctx('u1'))
    assert.match(delOk, /已删除/)
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

test('global task directory + subscribe/unsubscribe via tools', async () => {
  const { file, store, tools, ctx } = setup()
  try {
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', instruction: '推送早报' }])
    const dir = await call(tools.listGlobalTasks, {}, ctx('u1'))
    assert.match(dir, /每日早报/)
    assert.match(dir, /每天 08:00/)
    assert.doesNotMatch(dir, /已订阅/)
    const sub = await call(tools.subscribeTask, { name: '每日早报' }, ctx('u1'))
    assert.match(sub, /已订阅/)
    const dir2 = await call(tools.listGlobalTasks, {}, ctx('u1'))
    assert.match(dir2, /已订阅/)
    // listed in my tasks
    const mine = await call(tools.listMyTasks, {}, ctx('u1'))
    assert.match(mine, /\[公共\] 每日早报/)
    const unsub = await call(tools.unsubscribeTask, { name: '每日早报' }, ctx('u1'))
    assert.match(unsub, /已退订/)
    assert.equal(store.isSubscribed('每日早报', 'u1'), false)
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})
