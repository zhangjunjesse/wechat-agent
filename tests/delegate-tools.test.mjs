import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { TaskRunStore } from '../src/services/task-run-store.mjs'
import { delegateTools } from '../src/tools/delegate-tools.mjs'

function call(toolFn, input, ctx) {
  return toolFn.invoke(ctx, JSON.stringify(input))
}

function setup() {
  const file = path.join(os.tmpdir(), `dtools-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const store = new TaskRunStore({ file })
  const enqueued = []
  const runner = { enqueue: (item) => { enqueued.push(item); return true } }
  const tools = delegateTools({ taskRunStore: store, runner })
  const ctx = (userId = 'u1') => ({ context: { userId, profile: { nickname: 'Z.俊' }, channel: { type: 'ilink', contextToken: 'tok' } } })
  return { file, store, tools, enqueued, ctx }
}

test('delegate_task returns immediately with a task id and does not wait for execution', async () => {
  const { file, store, tools, enqueued, ctx } = setup()
  try {
    const t0 = Date.now()
    const out = await call(tools.delegateTask, { goal: '导出飞书文档为 PDF 并发送', context: '链接 X' }, ctx('u1'))
    assert.ok(Date.now() - t0 < 500, '必须秒级返回（不等待子任务）')
    assert.match(out, /已派发任务 task-1/)
    assert.match(out, /继续接待其他问题/)
    assert.equal(enqueued.length, 1)
    assert.equal(enqueued[0].taskId, 'task-1')
    assert.equal(enqueued[0].userId, 'u1')
    assert.equal(store.get('task-1').status, 'pending')
    assert.equal(store.get('task-1').goal, '导出飞书文档为 PDF 并发送')
    // 空 goal 拒绝
    assert.match(await call(tools.delegateTask, { goal: '   ' }, ctx('u1')), /不能为空/)
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})

test('list_tasks / task_status report own tasks only; task ids are per-user scoped', async () => {
  const { file, store, tools, ctx } = setup()
  try {
    store.create({ userId: 'u1', goal: '任务一' })
    store.create({ userId: 'u2', goal: '别人的任务' })
    store.markRunning('task-1')
    store.settle('task-1', { status: 'done', result: '做好了' })
    const list = await call(tools.listTasks, {}, ctx('u1'))
    assert.match(list, /task-1/)
    assert.match(list, /已完成/)
    assert.doesNotMatch(list, /别人的任务/) // 隔离
    const detail = await call(tools.taskStatus, { id: 'task-1' }, ctx('u1'))
    assert.match(detail, /做好了/)
    const denied = await call(tools.taskStatus, { id: 'task-2' }, ctx('u1'))
    assert.match(denied, /找不到任务 task-2/)
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})

test('retry_task re-enqueues only failed/timed-out/cancelled tasks', async () => {
  const { file, store, tools, enqueued, ctx } = setup()
  try {
    const t = store.create({ userId: 'u1', goal: 'x' })
    assert.match(await call(tools.retryTask, { id: t.id }, ctx('u1')), /只有失败/)
    store.markRunning(t.id)
    store.settle(t.id, { status: 'failed', error: 'boom' })
    const out = await call(tools.retryTask, { id: t.id }, ctx('u1'))
    assert.match(out, /已重新派发任务 task-1/)
    assert.match(out, /第 2 次/)
    assert.equal(enqueued.length, 1)
    assert.equal(store.get(t.id).status, 'pending')
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})

test('delegate tools degrade gracefully when not configured', async () => {
  const tools = delegateTools({ taskRunStore: null, runner: null })
  assert.match(await call(tools.delegateTask, { goal: 'x' }, { context: { userId: 'u1' } }), /未启用/)
  assert.match(await call(tools.listTasks, {}, { context: { userId: 'u1' } }), /未启用/)
})

test('delegate_task description carries the operation-type criteria, not a seconds threshold (ADR-0025)', async () => {
  const { tools } = setup()
  const d = tools.delegateTask.description
  // 判据 = 操作类型清单（单次调用也可能很慢，不能靠估时间/数调用次数）
  assert.match(d, /导出\/下载文件/)
  assert.match(d, /生成文档\/图片/)
  assert.match(d, /外部异步接口/)
  assert.match(d, /判据看操作类型/)
  assert.match(d, /不要靠估时间/)
  // 派发前先查进行中任务
  assert.match(d, /list_tasks/)
  // 派发后不承诺结果、不自己接着做
  assert.match(d, /不要承诺具体结果/)
  // 旧的秒数判据已被移除（避免"≥30 秒"这类错代理指标回归）
  assert.doesNotMatch(d, /\d+\s*秒/)
  assert.doesNotMatch(d, /minSeconds/)
})

test('task_status / list_tasks expose elapsed seconds for in-flight tasks', async () => {
  const { file, store, tools, ctx } = setup()
  try {
    const t = store.create({ userId: 'u1', goal: '导出飞书文档' })
    const pending = await call(tools.listTasks, {}, ctx('u1'))
    assert.match(pending, /排队中/)
    store.markRunning(t.id, Date.now() - 42_000)
    const list = await call(tools.listTasks, {}, ctx('u1'))
    assert.match(list, /已用 (4[0-9]|5[0-9]) 秒/)
    const detail = await call(tools.taskStatus, { id: t.id }, ctx('u1'))
    assert.match(detail, /执行中 · 已用 (4[0-9]|5[0-9]) 秒/)
    assert.match(detail, /开始：/)
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})

test('subagent tool set is restricted: can deliver/progress, cannot delegate again or touch task catalogs', async () => {
  const { buildTools } = await import('../src/tools/index.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-tools-'))
  try {
    // 子 agent 工具集 = buildTools(taskStore: null, reportStore: null)（server.mjs 的实际做法）
    const sub = buildTools({ memoryManager: null, skillRegistry: null, fetchImpl: async () => ({ ok: true, json: async () => ({}) }), wechatLogStore: null, root, issueDownloadLink: null, provider: {}, taskStore: null, reportStore: null, lark: null })
    const names = sub.map((t) => t.name)
    // 能交付与汇报进度
    assert.ok(names.includes('send_file'), names.join(','))
    assert.ok(names.includes('notify_user'))
    assert.ok(names.includes('write_file'))
    // 不能递归委派、不能碰任务目录/日报订阅
    assert.ok(!names.includes('delegate_task'))
    assert.ok(!names.includes('list_tasks'))
    assert.ok(!names.includes('create_task'))
    assert.ok(!names.includes('subscribe_task'))
    assert.ok(!names.includes('get_daily_report'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
