import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { TaskRunStore } from '../src/services/task-run-store.mjs'
import { SubagentRunner, buildSubagentPrompt, renderSettlementText } from '../src/services/subagent-runner.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function setup({ respond, timeoutMs = 60_000, maxConcurrentPerUser = 2 } = {}) {
  const file = path.join(os.tmpdir(), `runner-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const store = new TaskRunStore({ file })
  const sent = []
  const provider = { sendText: async (a) => { sent.push(a); return {} } }
  const calls = []
  const runner = new SubagentRunner({
    agentFactory: async () => ({ respond: async (args) => { calls.push(args); return respond(args) } }),
    store,
    provider,
    contextTokens: { get: (uid) => ({ contextToken: `tok-${uid}`, providerBotId: `bot-${uid}` }) },
    maxConcurrentPerUser,
    timeoutMs,
  })
  return { file, store, runner, sent, calls }
}

const waitFor = async (fn, ms = 2000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await sleep(10)
  }
  return false
}

test('a delegated task runs in the background and notifies the user on completion', async () => {
  const { file, store, runner, sent, calls } = setup({ respond: async () => ({ text: '已导出并发送 报告.pdf' }) })
  try {
    const task = store.create({ userId: 'u1', goal: '把飞书文档导出成 PDF 发给用户', context: '链接：https://x/docx/W1' })
    runner.enqueue({ taskId: task.id, userId: 'u1', profile: { nickname: 'Z.俊', wxid: '' } })
    assert.ok(await waitFor(() => sent.length >= 1), '通知应发出')
    // 子 agent 收到自包含 prompt（含目标与上下文），且是 ephemeral
    assert.equal(calls.length, 1)
    assert.match(calls[0].text, /把飞书文档导出成 PDF 发给用户/)
    assert.match(calls[0].text, /https:\/\/x\/docx\/W1/)
    assert.match(calls[0].text, /看不到与用户的对话历史/)
    assert.equal(calls[0].ephemeral, true)
    assert.match(calls[0].userId, /^subagent:task-/)
    // 任务落终态 + 结果
    const done = store.get(task.id)
    assert.equal(done.status, 'done')
    assert.match(done.result, /报告\.pdf/)
    // 通知内容
    assert.match(sent[0].text, /任务 task-1 完成/)
    assert.match(sent[0].text, /报告\.pdf/)
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})

test('failures and timeouts also notify (never silent), exactly once', async () => {
  // 失败
  const f = setup({ respond: async () => { throw new Error('导出权限不足') } })
  try {
    const task = f.store.create({ userId: 'u1', goal: 'x' })
    f.runner.enqueue({ taskId: task.id, userId: 'u1' })
    assert.ok(await waitFor(() => f.sent.length >= 1))
    assert.equal(f.store.get(task.id).status, 'failed')
    assert.match(f.sent[0].text, /任务 task-1 失败/)
    assert.match(f.sent[0].text, /导出权限不足/)
    assert.match(f.sent[0].text, /重试 task-1/)
    await sleep(50)
    assert.equal(f.sent.length, 1) // 只通知一次
  } finally {
    f.store.close(); fs.rmSync(f.file, { force: true })
  }
  // 超时
  const t = setup({ respond: async () => { await sleep(500); return { text: 'late' } }, timeoutMs: 20 })
  try {
    const task = t.store.create({ userId: 'u1', goal: 'x' })
    t.runner.enqueue({ taskId: task.id, userId: 'u1' })
    assert.ok(await waitFor(() => t.sent.length >= 1, 3000))
    assert.equal(t.store.get(task.id).status, 'timeout')
    assert.match(t.sent[0].text, /超过时限未完成/)
  } finally {
    t.store.close(); fs.rmSync(t.file, { force: true })
  }
})

test('per-user concurrency cap queues extra tasks instead of running them all', async () => {
  const { file, store, runner, sent, calls } = setup({
    respond: async () => { await sleep(80); return { text: 'ok' } },
    maxConcurrentPerUser: 1,
  })
  try {
    const a = store.create({ userId: 'u1', goal: 'a' })
    const b = store.create({ userId: 'u1', goal: 'b' })
    runner.enqueue({ taskId: a.id, userId: 'u1' })
    runner.enqueue({ taskId: b.id, userId: 'u1' })
    await sleep(30)
    assert.equal(calls.length, 1, '并发上限 1：第二个任务应排队')
    assert.equal(store.get(b.id).status, 'pending')
    assert.ok(await waitFor(() => calls.length === 2, 3000), '第一个完成后第二个开始')
    assert.ok(await waitFor(() => sent.length === 2, 3000))
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})

test('subagent prompt is self-contained and settlement texts cover all statuses', () => {
  const prompt = buildSubagentPrompt({ id: 'task-7', goal: '生成周报', context: '用户偏好中文' })
  assert.match(prompt, /后台任务 task-7/)
  assert.match(prompt, /生成周报/)
  assert.match(prompt, /用户偏好中文/)
  assert.match(prompt, /send_file/)
  assert.match(prompt, /结果说明/)
  // 子 agent 拿到的静态 instructions 里有"默认委派"的节奏规则，但它没有委派工具 →
  // 提示词必须显式说明"你就是后台执行者"（ADR-0025 的可见性一致性）
  assert.match(prompt, /你就是后台执行者/)
  assert.match(prompt, /没有 delegate_task/)
  assert.match(renderSettlementText({ id: 'task-1', status: 'done', result: 'ok' }), /任务 task-1 完成/)
  assert.match(renderSettlementText({ id: 'task-1', status: 'cancelled' }), /已取消/)
  const long = renderSettlementText({ id: 'task-1', status: 'done', result: 'x'.repeat(400) })
  assert.ok(long.length < 260, `应截断，实际 ${long.length}`)
})
