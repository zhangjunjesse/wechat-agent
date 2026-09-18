import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { AgentTaskStore } from '../src/services/agent-task-store.mjs'
import { SessionStore } from '../src/services/session-store.mjs'
import { TurnPipeline } from '../src/services/turn-pipeline.mjs'

function setup({ triageResult } = {}) {
  const file = path.join(os.tmpdir(), `pipe-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const sfile = path.join(os.tmpdir(), `pipe-s-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const board = new AgentTaskStore({ file })
  const sessions = new SessionStore({ file: sfile })
  const pokes = []
  const absorbed = []
  const pipeline = new TurnPipeline({
    triage: async (input) => (typeof triageResult === 'function' ? triageResult(input) : triageResult),
    board,
    runner: { poke: (u) => pokes.push(u) },
    sessions,
    memory: { absorb: async (u, t, a) => { absorbed.push([u, t, a]) } },
  })
  const cleanup = () => { board.close(); sessions.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }); fs.rmSync(sfile, { force: true, maxRetries: 5, retryDelay: 50 }) }
  return { board, sessions, pipeline, pokes, absorbed, cleanup }
}

const PLAN2 = {
  kind: 'task',
  ack: '收到，我分两步做',
  plan: [
    { subject: '查资料', description: 'd1', activeForm: '正在查', dependsOn: [] },
    { subject: '写文档', description: 'd2', activeForm: '正在写', dependsOn: [0] },
  ],
}

test('chat passes through; triage throwing degrades to chat (route never throws)', async () => {
  const a = setup({ triageResult: { kind: 'chat' } })
  try { assert.deepEqual(await a.pipeline.route({ userId: 'u1', text: '你好' }), { kind: 'chat' }) } finally { a.cleanup() }
  const b = setup({ triageResult: () => { throw new Error('boom') } })
  try { assert.equal((await b.pipeline.route({ userId: 'u1', text: 'x' })).kind, 'chat') } finally { b.cleanup() }
})

test('task: nothing is committed before commit(); commit boards the plan with deps, batch metadata, poke, session and memory', async () => {
  const { board, sessions, pipeline, pokes, absorbed, cleanup } = setup({ triageResult: PLAN2 })
  try {
    const routed = await pipeline.route({ userId: 'u1', text: '查X然后写文档' })
    assert.equal(routed.kind, 'task')
    assert.equal(routed.ack, '收到，我分两步做')
    // 时序规则：commit 之前板必须是空的（回执没发出去就不许落板）
    assert.equal(board.list('u1').length, 0)
    assert.equal(pokes.length, 0)

    const { batchId, taskIds } = await routed.commit()
    assert.equal(taskIds.length, 2)
    const t1 = board.getDetail(taskIds[0], 'u1')
    const t2 = board.getDetail(taskIds[1], 'u1')
    assert.equal(t2.blockedBy[0].id, taskIds[0], 'dependsOn 下标换算成真实板 id')
    assert.equal(t1.metadata.batchId, batchId)
    assert.equal(t1.metadata.batchSize, 2)
    assert.deepEqual(board.listByBatch('u1', batchId).map((t) => t.id), taskIds)
    assert.deepEqual(pokes, ['u1'])
    // S1：用户消息 + 回执成对进 transcript
    const { transcript } = sessions.get('u1')
    assert.deepEqual(transcript.at(-2), { role: 'user', content: '查X然后写文档' })
    assert.deepEqual(transcript.at(-1), { role: 'assistant', content: '收到，我分两步做' })
    // S5：absorb 用 (用户消息, 回执)
    assert.deepEqual(absorbed, [['u1', '查X然后写文档', '收到，我分两步做']])
  } finally { cleanup() }
})

test('forward dependency in plan (task 0 depends on task 1) still boards correctly', async () => {
  const { board, pipeline, cleanup } = setup({
    triageResult: { kind: 'task', ack: 'a', plan: [{ subject: '后做', description: '', activeForm: '', dependsOn: [1] }, { subject: '先做', description: '', activeForm: '', dependsOn: [] }] },
  })
  try {
    const routed = await pipeline.route({ userId: 'u1', text: 'x' })
    const { taskIds } = await routed.commit()
    const first = board.getDetail(taskIds[0], 'u1')
    assert.equal(first.blockedBy[0].id, taskIds[1], '前向依赖：两趟建板后边仍然正确')
    assert.equal(board.nextClaimable('u1').id, taskIds[1], '可认领的是"先做"')
  } finally { cleanup() }
})
