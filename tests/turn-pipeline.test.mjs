import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { AgentTaskStore } from '../src/services/agent-task-store.mjs'
import { SessionStore } from '../src/services/session-store.mjs'
import { TurnPipeline } from '../src/services/turn-pipeline.mjs'

function setup({ classify, plan } = {}) {
  const file = path.join(os.tmpdir(), `pipe-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const sfile = path.join(os.tmpdir(), `pipe-s-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const board = new AgentTaskStore({ file })
  const sessions = new SessionStore({ file: sfile })
  const pokes = []
  const absorbed = []
  const pipeline = new TurnPipeline({
    triage: {
      classify: async (input) => (typeof classify === 'function' ? classify(input) : classify),
      plan: async (input) => (typeof plan === 'function' ? plan(input) : plan ?? null),
    },
    board,
    runner: { poke: (u) => pokes.push(u) },
    sessions,
    memory: { absorb: async (u, t, a) => { absorbed.push([u, t, a]) } },
  })
  const cleanup = () => { board.close(); sessions.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }); fs.rmSync(sfile, { force: true, maxRetries: 5, retryDelay: 50 }) }
  return { board, sessions, pipeline, pokes, absorbed, cleanup }
}

const PLAN2 = [
  { subject: '查资料', description: 'd1', activeForm: '正在查', dependsOn: [] },
  { subject: '写文档', description: 'd2', activeForm: '正在写', dependsOn: [0] },
]

test('chat passes through; classify throwing degrades to chat (route never throws)', async () => {
  const a = setup({ classify: { kind: 'chat' } })
  try { assert.deepEqual(await a.pipeline.route({ userId: 'u1', text: '你好' }), { kind: 'chat' }) } finally { a.cleanup() }
  const b = setup({ classify: () => { throw new Error('boom') } })
  try { assert.equal((await b.pipeline.route({ userId: 'u1', text: 'x' })).kind, 'chat') } finally { b.cleanup() }
})

test('task: plan happens inside commit (after ack), boards with deps + batch, poke, session, memory', async () => {
  let planCalls = 0
  const { board, sessions, pipeline, pokes, absorbed, cleanup } = setup({
    classify: { kind: 'task', ack: '收到，我分两步做' },
    plan: (input) => { planCalls++; assert.equal(input.ack, '收到，我分两步做'); return PLAN2 },
  })
  try {
    const routed = await pipeline.route({ userId: 'u1', text: '查X然后写文档' })
    assert.equal(routed.kind, 'task')
    assert.equal(routed.ack, '收到，我分两步做')
    // 时序：commit 之前——plan 还没生成、板必须为空（回执没送达不许做任何事）
    assert.equal(planCalls, 0, 'plan 生成必须发生在 commit（回执之后），不拖慢回执')
    assert.equal(board.list('u1').length, 0)
    assert.equal(pokes.length, 0)

    const { batchId, taskIds } = await routed.commit()
    assert.equal(planCalls, 1)
    assert.equal(taskIds.length, 2)
    const t2 = board.getDetail(taskIds[1], 'u1')
    assert.equal(t2.blockedBy[0].id, taskIds[0], 'dependsOn 下标换算成真实板 id')
    assert.equal(board.getDetail(taskIds[0], 'u1').metadata.batchId, batchId)
    assert.deepEqual(board.listByBatch('u1', batchId).map((t) => t.id), taskIds)
    assert.deepEqual(pokes, ['u1'])
    const { transcript } = sessions.get('u1')
    assert.deepEqual(transcript.at(-2), { role: 'user', content: '查X然后写文档' })
    assert.deepEqual(transcript.at(-1), { role: 'assistant', content: '收到，我分两步做' })
    assert.deepEqual(absorbed, [['u1', '查X然后写文档', '收到，我分两步做']])
  } finally { cleanup() }
})

test('plan failure → single-task fallback (the promise was made, it must have a carrier)', async () => {
  const { board, pipeline, pokes, cleanup } = setup({
    classify: { kind: 'task', ack: '收到我来办' },
    plan: null, // plan 生成失败
  })
  try {
    const routed = await pipeline.route({ userId: 'u1', text: '帮我总结昆山农商今天的消息，做成图片报告发我' })
    const { taskIds } = await routed.commit()
    assert.equal(taskIds.length, 1, '兜底恰一个任务')
    const t = board.get(taskIds[0], 'u1')
    assert.match(t.subject, /昆山农商/)
    assert.equal(t.description, '帮我总结昆山农商今天的消息，做成图片报告发我', '原话全文进 description（执行者看不到对话）')
    assert.deepEqual(pokes, ['u1'])
  } finally { cleanup() }
})

test('forward dependency in plan still boards correctly (two-pass edge creation)', async () => {
  const { board, pipeline, cleanup } = setup({
    classify: { kind: 'task', ack: 'a' },
    plan: [{ subject: '后做', description: '', activeForm: '', dependsOn: [1] }, { subject: '先做', description: '', activeForm: '', dependsOn: [] }],
  })
  try {
    const routed = await pipeline.route({ userId: 'u1', text: 'x' })
    const { taskIds } = await routed.commit()
    assert.equal(board.getDetail(taskIds[0], 'u1').blockedBy[0].id, taskIds[1])
    assert.equal(board.nextClaimable('u1').id, taskIds[1], '可认领的是"先做"')
  } finally { cleanup() }
})
