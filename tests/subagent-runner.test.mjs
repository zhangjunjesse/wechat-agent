import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { TaskRunStore } from '../src/services/task-run-store.mjs'
import { AgentTaskStore } from '../src/services/agent-task-store.mjs'
import { SubagentRunner, buildSubagentPrompt, renderSettlementText } from '../src/services/subagent-runner.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function setup({ respond, timeoutMs = 60_000, maxConcurrentPerUser = 2, maxAutoAttempts = 3, retryBackoffMs = 60_000, file = null } = {}) {
  const dbFile = file || path.join(os.tmpdir(), `runner-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const runs = new TaskRunStore({ file: dbFile })
  const board = new AgentTaskStore({ file: dbFile })
  const sent = []
  const provider = { sendText: async (a) => { sent.push(a); return {} } }
  const calls = []
  const runner = new SubagentRunner({
    agentFactory: async () => ({ respond: async (args) => { calls.push(args); return respond(args) } }),
    board,
    runs,
    provider,
    contextTokens: { get: (uid) => ({ contextToken: `tok-${uid}`, providerBotId: `bot-${uid}` }) },
    maxConcurrentPerUser,
    maxAutoAttempts,
    retryBackoffMs,
    timeoutMs,
  })
  return { file: dbFile, board, runs, runner, sent, calls }
}

const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await sleep(10)
  }
  return false
}

test('board task is claimed, executed ephemerally, completed and the user notified exactly once', async () => {
  const { file, board, runs, runner, sent, calls } = setup({ respond: async () => ({ text: '已导出并发送 报告.pdf' }) })
  try {
    const t = board.create({ userId: 'u1', subject: '导出季度总结为 PDF', description: '链接：https://x/docx/W1' })
    runner.poke('u1')
    assert.ok(await waitFor(() => sent.length >= 1), '通知应发出')
    assert.equal(calls.length, 1)
    assert.match(calls[0].text, /导出季度总结为 PDF/)
    assert.match(calls[0].text, /https:\/\/x\/docx\/W1/)
    assert.match(calls[0].text, /看不到与用户的对话历史/)
    assert.equal(calls[0].ephemeral, true)
    // 沙箱按用户分（不是按 run 分）：工具用 ctx.context.userId 解析路径，
    // 同批次的兄弟任务必须落在同一个目录才能交接文件（2026-09-19 修复）
    assert.equal(calls[0].userId, 'u1')
    // 板：completed + 结果回填；执行行：done + 关联板 id
    const done = board.get(t.id)
    assert.equal(done.status, 'completed')
    assert.match(done.result, /报告\.pdf/)
    const run = runs.latestForBoard(String(t.id))
    assert.equal(run.status, 'done')
    assert.equal(run.boardTaskId, String(t.id))
    // 通知：一次，含板 id 与 subject
    assert.match(sent[0].text, new RegExp(`任务 #${t.id}`))
    assert.match(sent[0].text, /报告\.pdf/)
    await sleep(50)
    assert.equal(sent.length, 1)
  } finally { runner.stop(); runs.close(); board.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('channel is threaded into agent.respond so send_file/notify_user work in board tasks (2026-09-19 fix: prompt promised "当前对话是微信渠道" but channel was never actually passed)', async () => {
  const { file, board, runs, runner, calls, sent } = setup({ respond: async () => ({ text: 'ok' }) })
  try {
    const t = board.create({ userId: 'u1', subject: 's', description: '' })
    runner.poke('u1')
    assert.ok(await waitFor(() => sent.length >= 1))
    // setup() 里的 contextTokens mock 对任何 uid 都命中缓存 → 应还原出完整 channel
    assert.deepEqual(calls[0].channel, { type: 'ilink', providerBotId: 'bot-u1', toProviderUserId: 'u1', contextToken: 'tok-u1' })
  } finally { runner.stop(); runs.close(); board.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('channel gracefully degrades to null when the contextToken cache is cold (same contract as web chat)', async () => {
  const dbFile = path.join(os.tmpdir(), `runner-nochannel-${Date.now()}.db`)
  const runs = new TaskRunStore({ file: dbFile })
  const board = new AgentTaskStore({ file: dbFile })
  const calls = []
  const sent = []
  const runner = new SubagentRunner({
    agentFactory: async () => ({ respond: async (args) => { calls.push(args); return { text: 'ok' } } }),
    board, runs,
    provider: { sendText: async (a) => { sent.push(a); return {} } },
    contextTokens: { get: () => null }, // 冷缓存：用户很久没发过消息
    timeoutMs: 60_000,
  })
  try {
    board.create({ userId: 'u1', subject: 's', description: '' })
    runner.poke('u1')
    assert.ok(await waitFor(() => calls.length >= 1))
    assert.equal(calls[0].channel, null)
  } finally { runner.stop(); runs.close(); board.close(); fs.rmSync(dbFile, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('retryable failure is SILENT and released for retry; give-up notifies once (ADR-0035)', async () => {
  const { file, board, runs, runner, sent } = setup({
    respond: async () => { throw new Error('ETIMEDOUT network flake') }, // 可重试类
    maxAutoAttempts: 2,
  })
  try {
    const t = board.create({ userId: 'u1', subject: '抓取汇总', description: '' })
    runner.poke('u1')
    // 第一次失败：静默 + 释放回 pending + auto_attempts=1；
    // 时间退避生效——释放并发位后的立即 re-poke 不会连珠炮式重试同一任务
    assert.ok(await waitFor(() => board.get(t.id).autoAttempts === 1))
    await sleep(60)
    assert.equal(board.get(t.id).status, 'pending')
    assert.equal(sent.length, 0, '中间失败必须静默')
    // 越过退避窗口再 drain → 第二次 → 到达上限 → 通知一次"没做成"
    runner.drainAll(Date.now() + 61_000)
    assert.ok(await waitFor(() => sent.length >= 1))
    assert.equal(board.get(t.id).autoAttempts, 2)
    assert.match(sent[0].text, /没做成|停下/)
    assert.doesNotMatch(sent[0].text, /ETIMEDOUT|network/, '不泄漏原始报错')
    assert.doesNotMatch(sent[0].text, /自动重试/, '不承诺不会兑现的重试')
    // 次数上限：即使再越过退避窗口也不再自动重挑
    runner.drainAll(Date.now() + 200_000)
    await sleep(80)
    assert.equal(sent.length, 1)
  } finally { runner.stop(); runs.close(); board.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('non-retryable failure notifies immediately and stops auto-retry (402 class)', async () => {
  const { file, board, runs, runner, sent, calls } = setup({
    respond: async () => { throw new Error('402 litellm.APIError: 账户余额不足') },
    maxAutoAttempts: 3,
  })
  try {
    const t = board.create({ userId: 'u1', subject: '生成报告', description: '' })
    runner.poke('u1')
    assert.ok(await waitFor(() => sent.length >= 1))
    assert.equal(calls.length, 1, '不可重试：只执行一次')
    const cur = board.get(t.id)
    assert.equal(cur.status, 'pending')
    assert.equal(cur.autoAttempts, 3, '直接顶到上限，不再自动重挑')
    assert.match(sent[0].text, /服务问题/)
    assert.doesNotMatch(sent[0].text, /402|litellm|余额/)
    runner.drainAll()
    await sleep(80)
    assert.equal(calls.length, 1)
  } finally { runner.stop(); runs.close(); board.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('per-user concurrency cap: second task waits until the first finishes', async () => {
  const { file, board, runs, runner, calls, sent } = setup({
    respond: async () => { await sleep(80); return { text: 'ok' } },
    maxConcurrentPerUser: 1,
  })
  try {
    board.create({ userId: 'u1', subject: 'a', description: '' })
    board.create({ userId: 'u1', subject: 'b', description: '' })
    runner.poke('u1')
    await sleep(30)
    assert.equal(calls.length, 1, '并发上限 1：第二个应等待')
    assert.ok(await waitFor(() => sent.length === 2), '第一个完成后第二个自动接上')
  } finally { runner.stop(); runs.close(); board.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('deleting an in-progress task discards the result and suppresses notification (A7 cancel)', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const { file, board, runs, runner, sent } = setup({
    respond: async () => { await gate; return { text: '迟到的结果' } },
  })
  try {
    const t = board.create({ userId: 'u1', subject: 's', description: '' })
    runner.poke('u1')
    assert.ok(await waitFor(() => board.get(t.id).status === 'in_progress'))
    board.update(t.id, 'u1', { status: 'deleted' }) // 用户取消
    release()
    await sleep(120)
    assert.equal(board.get(t.id).status, 'deleted', '结果不回填')
    assert.equal(sent.length, 0, '取消的任务零通知')
    const run = runs.latestForBoard(String(t.id))
    assert.equal(run.status, 'done', '执行行仍如实记录结局（审计）')
  } finally { runner.stop(); runs.close(); board.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('restart recovery (A3): dead claim is released, re-run, and the user notified exactly once', async () => {
  const dbFile = path.join(os.tmpdir(), `runner-recover-${Date.now()}.db`)
  // 第一个"进程"：认领后永不完成（模拟执行中崩溃）。timeoutMs 拉大到远超测试
  // 时长：否则超时路径会在 store 已 close 后触发 settle 抛"database is closed"。
  const p1 = setup({ file: dbFile, respond: () => new Promise(() => {}), timeoutMs: 600_000 })
  const t = p1.board.create({ userId: 'u1', subject: '导出报告', description: '' })
  p1.runner.poke('u1')
  assert.ok(await waitFor(() => p1.board.get(t.id).status === 'in_progress'))
  const deadOwner = p1.board.get(t.id).owner
  // 模拟进程死亡：不结算、直接关（board/runs 句柄保留给断言？直接关掉重开）
  p1.runner.stop(); p1.runs.close(); p1.board.close()

  // 第二个"进程"：同一 DB 文件，正常执行
  const p2 = setup({ file: dbFile, respond: async () => ({ text: '完成' }) })
  try {
    assert.equal(p2.board.get(t.id).status, 'in_progress', '重启前遗留 in_progress')
    const released = p2.runner.recover()
    assert.equal(released.length, 1)
    assert.notEqual(p2.board.get(t.id).owner, deadOwner)
    assert.equal(p2.board.get(t.id).status, 'pending')
    assert.equal(p2.board.get(t.id).autoAttempts, 0, '重启恢复不占退避预算')
    p2.runner.drainAll()
    assert.ok(await waitFor(() => p2.sent.length >= 1))
    assert.equal(p2.board.get(t.id).status, 'completed')
    await sleep(80)
    assert.equal(p2.sent.length, 1, '恢复重跑后用户也只收到一次通知')
    // 两次执行行都在（历史保留）
    assert.equal(p2.runs.listByUser('u1', { limit: 10 }).filter((r) => r.boardTaskId === String(t.id)).length, 2)
  } finally { p2.runner.stop(); p2.runs.close(); p2.board.close(); fs.rmSync(dbFile, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('recover() releases stale main-agent claims only after mainStaleMs', async () => {
  const dbFile = path.join(os.tmpdir(), `runner-main-${Date.now()}.db`)
  const { board, runs, runner } = setup({ file: dbFile, respond: async () => ({ text: 'x' }) })
  try {
    const t = board.create({ userId: 'u1', subject: 's', description: '', owner: 'main' })
    board.update(t.id, 'u1', { status: 'in_progress' })
    assert.equal(runner.recover().length, 0, '10 分钟内的 main 认领不动')
    const released = runner.recover(Date.now() + 11 * 60_000)
    assert.equal(released.length, 1, '超时的 main 认领被释放')
  } finally { runner.stop(); runs.close(); board.close(); fs.rmSync(dbFile, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('prompt is self-contained; settlement texts follow ADR-0035 wording rules', () => {
  const prompt = buildSubagentPrompt({ runId: 'task-7', boardId: 3, subject: '生成周报', description: '用户偏好中文' })
  assert.match(prompt, /后台任务 #3/)
  assert.match(prompt, /生成周报/)
  assert.match(prompt, /用户偏好中文/)
  assert.match(prompt, /send_file/)
  assert.match(prompt, /你就是后台执行者/)
  assert.match(prompt, /没有 task_create/)
  assert.match(renderSettlementText({ boardId: 3, subject: '周报', kind: 'done', result: 'ok' }), /任务 #3（周报）完成/)
  assert.match(renderSettlementText({ boardId: 3, subject: '周报', kind: 'gaveUp' }), /重试任务 3/)
  const nr = renderSettlementText({ boardId: 3, subject: '周报', kind: 'nonRetryable' })
  assert.match(nr, /服务问题/)
  assert.doesNotMatch(nr, /自动重试/)
  const long = renderSettlementText({ boardId: 1, subject: 's', kind: 'done', result: 'x'.repeat(400) })
  assert.ok(long.length < 260, `应截断，实际 ${long.length}`)
})

test('batch of 2: progress markers on each completion, closing line merged into the LAST one, notifications land in session', async () => {
  const sfile = path.join(os.tmpdir(), `runner-sess-${Date.now()}.db`)
  const { SessionStore } = await import('../src/services/session-store.mjs')
  const sessions = new SessionStore({ file: sfile })
  const dbFile = path.join(os.tmpdir(), `runner-batch-${Date.now()}.db`)
  const runs = new TaskRunStore({ file: dbFile })
  const board = new AgentTaskStore({ file: dbFile })
  const sent = []
  const runner = new SubagentRunner({
    agentFactory: async () => ({ respond: async (a) => ({ text: `做完了：${a.text.includes('查资料') ? '资料' : '文档'}` }) }),
    board, runs, sessions,
    provider: { sendText: async (a) => { sent.push(a.text); return {} } },
    contextTokens: { get: (uid) => ({ contextToken: `tok`, providerBotId: `bot` }) },
    maxConcurrentPerUser: 1, // 串行执行保证顺序可断言
    timeoutMs: 60_000,
  })
  try {
    const batchId = 'batch-x'
    const a = board.create({ userId: 'u1', subject: '查资料', description: '', metadata: { batchId, batchSize: 2, batchIndex: 0 } })
    const b = board.create({ userId: 'u1', subject: '写文档', description: '', metadata: { batchId, batchSize: 2, batchIndex: 1 }, blockedBy: [a.id] })
    runner.poke('u1')
    assert.ok(await waitFor(() => sent.length === 2, 4000), `应两条通知，实际 ${sent.length}`)
    assert.match(sent[0], /\(1\/2\) 任务 #/)
    assert.doesNotMatch(sent[0], /都办完了/, '第一条不带收尾')
    assert.match(sent[1], /\(2\/2\) 任务 #/)
    assert.match(sent[1], /这批事都办完了/, '收尾合并进最后一条')
    // S2：两条通知都进 transcript
    const { transcript } = sessions.get('u1')
    assert.equal(transcript.filter((m) => m.role === 'assistant' && /任务 #/.test(m.content)).length, 2)
  } finally { runner.stop(); runs.close(); board.close(); sessions.close(); fs.rmSync(dbFile, { force: true, maxRetries: 5, retryDelay: 50 }); fs.rmSync(sfile, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('single-task batch keeps the plain notification (no progress marker, no closing line)', async () => {
  const { file, board, runs, runner, sent } = setup({ respond: async () => ({ text: 'ok' }) })
  try {
    board.create({ userId: 'u1', subject: 's', description: '', metadata: { batchId: 'b1', batchSize: 1, batchIndex: 0 } })
    runner.poke('u1')
    assert.ok(await waitFor(() => sent.length >= 1))
    assert.doesNotMatch(sent[0].text, /\(\d\/\d\)/)
    assert.doesNotMatch(sent[0].text, /办完了/)
  } finally { runner.stop(); runs.close(); board.close(); fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('batch closes even when the last member is given up (mixed stats in closing line)', async () => {
  const dbFile = path.join(os.tmpdir(), `runner-batchfail-${Date.now()}.db`)
  const runs = new TaskRunStore({ file: dbFile })
  const board = new AgentTaskStore({ file: dbFile })
  const sent = []
  const runner = new SubagentRunner({
    agentFactory: async () => ({ respond: async (a) => {
      if (a.text.includes('会失败')) throw new Error('402 litellm: 余额不足') // 不可重试 → 立即结清
      return { text: 'ok' }
    } }),
    board, runs,
    provider: { sendText: async (a) => { sent.push(a.text); return {} } },
    contextTokens: { get: () => ({ contextToken: 't', providerBotId: 'b' }) },
    maxConcurrentPerUser: 1, maxAutoAttempts: 3, timeoutMs: 60_000,
  })
  try {
    board.create({ userId: 'u1', subject: '正常任务', description: '', metadata: { batchId: 'bx', batchSize: 2, batchIndex: 0 } })
    board.create({ userId: 'u1', subject: '会失败的任务', description: '', metadata: { batchId: 'bx', batchSize: 2, batchIndex: 1 } })
    runner.poke('u1')
    assert.ok(await waitFor(() => sent.length === 2, 4000))
    assert.match(sent[1], /1 件完成，1 件没做成/)
  } finally { runner.stop(); runs.close(); board.close(); fs.rmSync(dbFile, { force: true, maxRetries: 5, retryDelay: 50 }) }
})
