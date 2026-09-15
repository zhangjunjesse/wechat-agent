import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { TaskStore } from '../src/services/task-store.mjs'
import { ReportStore } from '../src/services/report-store.mjs'
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

test('get_daily_report returns the latest report only for subscribed/owned tasks', async () => {
  const file = path.join(os.tmpdir(), `tk-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const repFile = file + '.rep.db'
  const store = new TaskStore({ file })
  const reportStore = new ReportStore({ file: repFile })
  const tools = taskTools({ taskStore: store, reportStore })
  const ctx = (userId = 'u1') => ({ context: { userId } })
  try {
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', instruction: 'x', kind: 'report' }])
    reportStore.saveReport({
      taskId: 'global-每日早报', name: '每日早报', runAt: Date.now(), focus: '关注点X',
      items: [{ title: 'T1', summary: 'S1', source: '源', url: 'https://a.com' }, { title: 'T2', summary: 'S2' }],
    })
    // 未订阅 → 找不到（不泄露他人/全局报告）
    const notSub = await call(tools.getDailyReport, {}, ctx('u2'))
    assert.match(notSub, /未找到报告/)
    const denied = await call(tools.getDailyReport, { name: '每日早报' }, ctx('u2'))
    assert.match(denied, /未订阅/)
    // 订阅后可见
    store.subscribe('每日早报', 'u1')
    const out = await call(tools.getDailyReport, {}, ctx('u1'))
    assert.match(out, /T1/)
    assert.match(out, /S1/)
    assert.match(out, /https:\/\/a\.com/)
    assert.match(out, /关注点X/)
    const out2 = await call(tools.getDailyReport, { name: '每日早报' }, ctx('u1'))
    assert.match(out2, /T2/)
    // 无 reportStore 时优雅返回
    const plain = taskTools({ taskStore: store })
    const out3 = await call(plain.getDailyReport, {}, ctx('u1'))
    assert.match(out3, /未启用/)
  } finally {
    store?.close?.(); reportStore?.close?.(); fs.rmSync(file, { force: true }); fs.rmSync(repFile, { force: true })
  }
})

test('update/list report topics are per-user and gated on subscription', async () => {
  const file = path.join(os.tmpdir(), `tk-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const repFile = file + '.rep.db'
  const store = new TaskStore({ file })
  const reportStore = new ReportStore({ file: repFile })
  const tools = taskTools({ taskStore: store, reportStore })
  const ctx = (userId = 'u1') => ({ context: { userId } })
  try {
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', instruction: 'x', kind: 'report' }])
    // 未订阅设置主题 → 拒绝
    const denied = await call(tools.updateReportTopics, { name: '每日早报', topics: ['AI'] }, ctx('u1'))
    assert.match(denied, /未订阅/)
    store.subscribe('每日早报', 'u1')
    store.subscribe('每日早报', 'u2')
    // u1 设置主题，u2 看不到
    const ok = await call(tools.updateReportTopics, { name: '每日早报', topics: ['AI', '芯片'] }, ctx('u1'))
    assert.match(ok, /AI、芯片/)
    const mine = await call(tools.listReportTopics, {}, ctx('u1'))
    assert.match(mine, /每日早报：AI、芯片/)
    const other = await call(tools.listReportTopics, {}, ctx('u2'))
    assert.match(other, /还没有设置个性化主题/)
    // 清除
    const cleared = await call(tools.updateReportTopics, { name: '每日早报', topics: [] }, ctx('u1'))
    assert.match(cleared, /清除/)
    assert.equal(store.getReportTopics('每日早报', 'u1').length, 0)
    // get_daily_report 优先个性化版（u1 有主题报告时返回它而非公共版）
    store.setReportTopics({ globalName: '每日早报', userId: 'u1', topics: ['AI'] })
    reportStore.saveReport({ taskId: 'global-每日早报', name: '每日早报', runAt: Date.now() - 1000, items: [{ title: '公共条', summary: 's' }] })
    reportStore.saveReport({ taskId: 'global-每日早报', name: '每日早报', runAt: Date.now(), userId: 'u1', items: [{ title: '我的个性化条', summary: 's' }] })
    const out = await call(tools.getDailyReport, {}, ctx('u1'))
    assert.match(out, /我的个性化条/)
    assert.doesNotMatch(out, /公共条/)
  } finally {
    store?.close?.(); reportStore?.close?.(); fs.rmSync(file, { force: true }); fs.rmSync(repFile, { force: true })
  }
})
