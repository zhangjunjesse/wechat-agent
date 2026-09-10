import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { TaskStore } from '../src/services/task-store.mjs'
import { TaskScheduler } from '../src/services/task-scheduler.mjs'
import { ContextTokenCache } from '../src/services/context-token-cache.mjs'

// Beijing 2026-09-10 08:00:30. Tasks are created 60s before NOW so their
// first trigger (daily@08:00) has already arrived.
const NOW = Date.UTC(2026, 8, 10, 0, 0, 30)
const CREATED = NOW - 60_000

function setup({ tasks = [], subscribers = {} } = {}) {
  const file = path.join(os.tmpdir(), `sch-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const store = new TaskStore({ file })
  const agent = { respond: async (args) => ({ text: `输出(${args.text.slice(0, 20)}…)` }) }
  const sent = []
  const provider = { sendText: async (args) => { sent.push(args); return { providerMessageId: 'm1' } } }
  const profiles = new Map()
  const profileStore = { get: async (id) => profiles.get(id) || null }
  const tokens = new ContextTokenCache({ file: file + '.ctx.json', flushDelayMs: 60000 })
  for (const [uid, tok] of Object.entries(subscribers)) tokens.update(uid, { contextToken: tok, providerBotId: 'bot-1' })
  const scheduler = new TaskScheduler({ taskStore: store, agent, provider, profileStore, contextTokens: tokens, now: () => NOW })
  for (const t of tasks) store.createUserTask({ createdAt: CREATED, ...t })
  return { file, store, scheduler, sent, profiles }
}

test('scheduler runs a due user task once and pushes to WeChat', async () => {
  const { file, store, scheduler, sent, profiles } = setup({
    tasks: [{ name: '早报', schedule: 'daily@08:00', instruction: '推送早报', ownerUserId: 'u1' }],
    subscribers: { u1: 'tok-u1' },
  })
  try {
    profiles.set('u1', { userId: 'u1', nickname: '用户一', wxid: 'wx-u1', ilinkUserId: 'u1' })
    await scheduler.sweep()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].toProviderUserId, 'u1')
    assert.equal(sent[0].contextToken, 'tok-u1')
    assert.match(sent[0].text, /早报/)
    const t = store.getTask(`user-u1-早报`)
    assert.ok(t.lastRunAt > 0)
    // second sweep does not re-run (lastRunAt guard)
    await scheduler.sweep()
    assert.equal(sent.length, 1)
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

test('scheduler skips tasks not yet due and users without contextToken', async () => {
  const { file, store, scheduler, sent, profiles } = setup({
    tasks: [
      { name: '未来任务', schedule: 'daily@09:00', instruction: 'x', ownerUserId: 'u1' }, // 09:00 not reached at 08:00:30
      { name: '无token', schedule: 'daily@08:00', instruction: 'y', ownerUserId: 'u2' },
    ],
    subscribers: { u1: 'tok-u1' }, // u2 has NO cached contextToken
  })
  try {
    profiles.set('u1', { userId: 'u1', nickname: 'u', wxid: 'w', ilinkUserId: 'u1' })
    profiles.set('u2', { userId: 'u2', nickname: 'u2', wxid: 'w2', ilinkUserId: 'u2' })
    await scheduler.sweep()
    assert.equal(sent.length, 0) // future task not due; tokenless user skipped
    // the due-but-tokenless task still got marked as run (skip is per-user, not per-task)
    assert.ok(store.getTask('user-u2-无token').lastRunAt > 0)
    assert.equal(store.getTask('user-u1-未来任务').lastRunAt, 0) // not due yet
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

test('scheduler runs a global task for every subscriber with tokens', async () => {
  const { file, store, scheduler, sent, profiles } = setup({
    subscribers: { u1: 'tok-1', u2: 'tok-2', u3: 'tok-3' },
  })
  try {
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', instruction: '早报', createdAt: CREATED }])
    store.subscribe('每日早报', 'u1')
    store.subscribe('每日早报', 'u2')
    store.subscribe('每日早报', 'u3')
    for (const id of ['u1', 'u2', 'u3']) profiles.set(id, { userId: id, nickname: id, wxid: 'wx-' + id, ilinkUserId: id })
    await scheduler.sweep()
    assert.deepEqual(sent.map((s) => s.toProviderUserId).sort(), ['u1', 'u2', 'u3'])
    const t = store.getTask('global-每日早报')
    assert.ok(t.lastRunAt > 0)
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})

test('a subscriber without a verified profile is skipped without breaking others', async () => {
  const { file, store, scheduler, sent, profiles } = setup({ subscribers: { u1: 'tok-1', u2: 'tok-2' } })
  try {
    store.loadGlobalTasks([{ name: '每日早报', schedule: 'daily@08:00', instruction: '早报', createdAt: CREATED }])
    store.subscribe('每日早报', 'u1')
    store.subscribe('每日早报', 'u2')
    profiles.set('u1', { userId: 'u1', nickname: 'u1', wxid: 'wx1', ilinkUserId: 'u1' }) // u2 unverified
    await scheduler.sweep()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].toProviderUserId, 'u1')
  } finally {
    store?.close?.(); fs.rmSync(file, { force: true })
  }
})
