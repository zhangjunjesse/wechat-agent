import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { AgentTaskStore } from '../src/services/agent-task-store.mjs'
import { TaskRunStore } from '../src/services/task-run-store.mjs'
import { taskBoardTools } from '../src/tools/task-board-tools.mjs'

function call(toolFn, input, userId = 'u1') {
  return toolFn.invoke({ context: { userId } }, JSON.stringify(input))
}

function setup() {
  const file = path.join(os.tmpdir(), `boardtools-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const board = new AgentTaskStore({ file })
  const runs = new TaskRunStore({ file })
  const pokes = []
  const tools = taskBoardTools({ board, runs, runner: { poke: (u) => pokes.push(u) } })
  return { file, board, runs, tools, pokes }
}

test('task_create: creates, pokes the runner, reports blockers; owner=me claims inline', async () => {
  const { file, board, runs, tools, pokes } = setup()
  try {
    const r1 = await call(tools.taskCreate, { subject: '查资料', description: '查 X 的近况' })
    assert.match(r1, /#1「查资料」/)
    assert.match(r1, /后台已排队/)
    assert.deepEqual(pokes, ['u1'])
    const r2 = await call(tools.taskCreate, { subject: '写文档', description: 'd', blockedBy: [1] })
    assert.match(r2, /等 #1 完成后开始/)
    assert.equal(pokes.length, 1, '被阻塞的任务不 poke 也无妨——create 只 poke 一次自己')
    // owner=me：当场自己做 → in_progress + owner=main，不 poke
    const r3 = await call(tools.taskCreate, { subject: '当场答复', description: 'd', owner: 'me' })
    assert.match(r3, /你自己当场做/)
    assert.equal(board.get(3).owner, 'main')
    assert.equal(board.get(3).status, 'in_progress')
  } finally { runs.close(); board.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('task_list / task_get: terse board view, cross-user invisible, latest run surfaced', async () => {
  const { file, board, runs, tools } = setup()
  try {
    await call(tools.taskCreate, { subject: 'a', description: 'da' })
    await call(tools.taskCreate, { subject: 'b', description: 'db', blockedBy: [1] })
    const list = await call(tools.taskList, {})
    assert.match(list, /#1｜排队中｜a/)
    assert.match(list, /#2｜排队中｜等 #1｜b/)
    // 跨用户不可见
    assert.equal(await call(tools.taskList, {}, 'u2'), '任务板是空的。')
    assert.match(await call(tools.taskGet, { taskId: 1 }, 'u2'), /找不到任务/)
    // 详情含依赖与最近执行
    runs.create({ userId: 'u1', goal: 'g', boardTaskId: '1' })
    const detail = await call(tools.taskGet, { taskId: 1 })
    assert.match(detail, /标题：a/)
    assert.match(detail, /解锁：#2/)
    assert.match(detail, /最近执行：task-1/)
  } finally { runs.close(); board.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('task_update: completion guarded by open blockers; terminal immutable; retry resets and pokes', async () => {
  const { file, board, runs, tools, pokes } = setup()
  try {
    await call(tools.taskCreate, { subject: 'a', description: 'd' })
    await call(tools.taskCreate, { subject: 'b', description: 'd', blockedBy: [1] })
    // b 有未完成前置 → 不许标完成（服务端硬校验，不靠模型自觉）
    assert.match(await call(tools.taskUpdate, { taskId: 2, status: 'completed' }), /前置任务/)
    assert.match(await call(tools.taskUpdate, { taskId: 1, status: 'completed' }), /已完成/)
    assert.match(await call(tools.taskUpdate, { taskId: 2, status: 'completed' }), /已完成/)
    // 终态不可迁出
    assert.match(await call(tools.taskUpdate, { taskId: 1, status: 'pending' }), /终态/)
    // 人工重试：失败任务回 pending → 清退避 + poke
    await call(tools.taskCreate, { subject: 'c', description: 'd' })
    board.claim(3, 'w'); board.release(3, { error: 'x', setAutoAttempts: 3 })
    pokes.length = 0
    assert.match(await call(tools.taskUpdate, { taskId: 3, status: 'pending' }), /排队中/)
    assert.equal(board.get(3).autoAttempts, 0)
    assert.deepEqual(pokes, ['u1'])
    // 依赖环被拒
    await call(tools.taskCreate, { subject: 'e', description: 'd' })
    await call(tools.taskCreate, { subject: 'f', description: 'd', blockedBy: [4] })
    assert.match(await call(tools.taskUpdate, { taskId: 4, addBlockedBy: [5] }), /成环/)
  } finally { runs.close(); board.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('task_output: resolves board id to latest run, accepts run ids, cross-user denied', async () => {
  const { file, board, runs, tools } = setup()
  try {
    await call(tools.taskCreate, { subject: 'a', description: 'd' })
    runs.create({ userId: 'u1', goal: 'g', boardTaskId: '1' })
    runs.settle('task-1', { status: 'done', result: '完成了' })
    const byBoard = await call(tools.taskOutput, { taskId: '1' })
    assert.match(byBoard, /task-1｜done/)
    assert.match(byBoard, /完成了/)
    const byRun = await call(tools.taskOutput, { taskId: 'task-1' })
    assert.match(byRun, /完成了/)
    assert.match(await call(tools.taskOutput, { taskId: '1' }, 'u2'), /找不到/)
  } finally { runs.close(); board.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('discipline lives in the tool descriptions (A9, mechanical half)', () => {
  const { file, board, runs, tools } = setup()
  try {
    const desc = (t) => t.description || ''
    // task_create：核心判据 + 反判据 + 查重 + 自包含
    assert.match(desc(tools.taskCreate), /结果.*还是.*承诺|承诺.*还是.*结果/)
    assert.match(desc(tools.taskCreate), /不许按预计耗时/)
    assert.match(desc(tools.taskCreate), /task_list 查重/)
    assert.match(desc(tools.taskCreate), /看不到你和用户的对话/)
    assert.match(desc(tools.taskCreate), /不许给已做完的事补建/)
    // task_update：完成纪律 + 卡点建新任务 + staleness
    assert.match(desc(tools.taskUpdate), /完全做成.*才许标 completed|只有.*完全做成/)
    assert.match(desc(tools.taskUpdate), /新建一个任务写清卡点/)
    assert.match(desc(tools.taskUpdate), /先 task_get 读最新/)
    // task_list：人话转述，不贴板结构
    assert.match(desc(tools.taskList), /人话转述/)
    // task_output：不轮询
    assert.match(desc(tools.taskOutput), /不要反复轮询/)
  } finally { runs.close(); board.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }) }
})
