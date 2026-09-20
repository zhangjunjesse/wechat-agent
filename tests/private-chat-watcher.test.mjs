import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { PrivateChatWatcher } from '../src/services/private-chat-watcher.mjs'

/** ADR-0043：私聊消息巡检器——定时扫同步库里的私聊（is_group=0、sender='them'）
 * 当作用户给 agent 发消息处理，回复走 iLink 私聊。照 GroupCommandWatcher 骨架，
 * 差异：跳过 sender='me'（agent 自己的回复，防死循环）、排除 account='agent'
 * （ConversationLog 落库的已处理行）、双通道去重（iLink 已回的不重复回）。 */

const SCHEMA = `
  CREATE TABLE messages (
    msg_id TEXT PRIMARY KEY, account TEXT, chat_wxid TEXT, chat_display TEXT, is_group INTEGER,
    ts INTEGER, datetime TEXT, sender TEXT, sender_wxid TEXT, sender_display TEXT,
    msg_type INTEGER, content TEXT, attachment TEXT, device TEXT, received_at INTEGER
  );
`

function tmp(ext) {
  return path.join(os.tmpdir(), `pw-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`)
}

function makeDb(rows) {
  const file = tmp('.db')
  const db = new DatabaseSync(file)
  db.exec(SCHEMA)
  const ins = db.prepare(`INSERT INTO messages
    (msg_id, account, chat_wxid, chat_display, is_group, ts, sender, sender_wxid, sender_display, msg_type, content)
    VALUES (?,?,?,?,?,?,?,?,?,1,?)`)
  for (const r of rows) ins.run(
    r.msg_id, r.account ?? 'acc', r.chat_wxid, r.chat_display ?? '', r.is_group ? 1 : 0, r.ts,
    r.sender ?? 'them', r.sender_wxid ?? null, r.sender_display ?? null, r.content ?? ''
  )
  db.close()
  return file
}

function makeCtx({ withToken = true, profiles = null } = {}) {
  const profile = { userId: 'u_zj', wxid: 'zj391504704', nickname: 'Z.俊', ilinkUserId: 'o9cq@im.wechat' }
  const sent = []
  const responded = []
  const agent = {
    respond: async ({ text, userId, channel }) => {
      responded.push({ text, userId, channel })
      return { text: `已收到：${String(text).slice(0, 20)}` }
    },
  }
  const provider = { sendText: async ({ text, toProviderUserId }) => { sent.push({ text, to: toProviderUserId }); return {} } }
  const profileStore = {
    list: async () => profiles ?? [profile],
    get: async () => profile,
  }
  const contextTokens = {
    get: (id) => (withToken ? { contextToken: 'tok-1', providerBotId: 'bot-1' } : null),
  }
  return { profile, sent, responded, agent, provider, profileStore, contextTokens }
}

test('私聊用户消息被当作给 agent 的消息处理并回复', async () => {
  const now = Math.floor(Date.now() / 1000)
  const dbFile = makeDb([
    { msg_id: 'm1', account: 'wxid_cap', chat_wxid: 'zj391504704', chat_display: 'Z.俊', is_group: false, ts: now, sender: 'them', sender_wxid: 'zj391504704', sender_display: 'Z.俊', content: '你好，帮我查一下' },
  ])
  const cursor = tmp('.json')
  const ctx = makeCtx()
  const w = new PrivateChatWatcher({ dbFile, agent: ctx.agent, provider: ctx.provider, profileStore: ctx.profileStore, contextTokens: ctx.contextTokens, cursorFile: cursor, initialCursor: 0 })
  try {
    await w.sweep()
    assert.equal(ctx.responded.length, 1, 'agent 应被调用一次')
    assert.match(ctx.responded[0].text, /你好，帮我查一下/)
    assert.equal(ctx.responded[0].userId, 'o9cq@im.wechat')
    assert.equal(ctx.responded[0].channel.type, 'ilink')
    assert.equal(ctx.sent.length, 1, '结果应私聊推送')
    assert.equal(ctx.sent[0].to, 'o9cq@im.wechat')
    // 游标已推进：再 sweep 不重复处理
    await w.sweep()
    assert.equal(ctx.responded.length, 1)
  } finally {
    w.stop()
    w.close()
    fs.rmSync(dbFile, { force: true, maxRetries: 5, retryDelay: 50 })
    fs.rmSync(cursor, { force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('跳过 sender=me（agent 自己的回复）和 account=agent（已落库行），防死循环', async () => {
  const now = Math.floor(Date.now() / 1000)
  const dbFile = makeDb([
    { msg_id: 'a1', account: 'wxid_cap', chat_wxid: 'zj391504704', chat_display: 'Z.俊', is_group: false, ts: now, sender: 'me', content: '这是助手回复' },
    { msg_id: 'a2', account: 'agent', chat_wxid: 'zj391504704', chat_display: 'Z.俊', is_group: false, ts: now + 1, sender: 'them', content: '已由 iLink 处理' },
  ])
  const cursor = tmp('.json')
  const ctx = makeCtx()
  const w = new PrivateChatWatcher({ dbFile, agent: ctx.agent, provider: ctx.provider, profileStore: ctx.profileStore, contextTokens: ctx.contextTokens, cursorFile: cursor, initialCursor: 0 })
  try {
    await w.sweep()
    assert.equal(ctx.responded.length, 0, '两种行都不该触发处理')
    assert.equal(ctx.sent.length, 0)
  } finally {
    w.stop()
    w.close()
    fs.rmSync(dbFile, { force: true, maxRetries: 5, retryDelay: 50 })
    fs.rmSync(cursor, { force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('双通道去重：iLink 已处理过的同一条消息（agent 落库行）不重复回复', async () => {
  const now = Math.floor(Date.now() / 1000)
  const dbFile = makeDb([
    // 采集端行（watcher 会扫到）+ agent 落库行（iLink 已处理，同 chat+同内容+同秒）
    { msg_id: 'w1', account: 'wxid_cap', chat_wxid: 'zj391504704', chat_display: 'Z.俊', is_group: false, ts: now, sender: 'them', content: '重复会来两遍吗' },
    { msg_id: 'a1', account: 'agent', chat_wxid: 'zj391504704', chat_display: 'Z.俊', is_group: false, ts: now, sender: 'them', content: '重复会来两遍吗' },
  ])
  const cursor = tmp('.json')
  const ctx = makeCtx()
  const w = new PrivateChatWatcher({ dbFile, agent: ctx.agent, provider: ctx.provider, profileStore: ctx.profileStore, contextTokens: ctx.contextTokens, cursorFile: cursor, initialCursor: 0 })
  try {
    await w.sweep()
    assert.equal(ctx.responded.length, 0, 'agent 落库行命中去重 → 不再处理')
  } finally {
    w.stop()
    w.close()
    fs.rmSync(dbFile, { force: true, maxRetries: 5, retryDelay: 50 })
    fs.rmSync(cursor, { force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('无 contextToken 的用户跳过（发不出回复就不打扰）', async () => {
  const now = Math.floor(Date.now() / 1000)
  const dbFile = makeDb([
    { msg_id: 'm1', account: 'wxid_cap', chat_wxid: 'zj391504704', chat_display: 'Z.俊', is_group: false, ts: now, sender: 'them', content: '你好' },
  ])
  const cursor = tmp('.json')
  const ctx = makeCtx({ withToken: false })
  const w = new PrivateChatWatcher({ dbFile, agent: ctx.agent, provider: ctx.provider, profileStore: ctx.profileStore, contextTokens: ctx.contextTokens, cursorFile: cursor, initialCursor: 0 })
  try {
    await w.sweep()
    assert.equal(ctx.responded.length, 0)
    assert.equal(ctx.sent.length, 0)
  } finally {
    w.stop()
    w.close()
    fs.rmSync(dbFile, { force: true, maxRetries: 5, retryDelay: 50 })
    fs.rmSync(cursor, { force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('游标推进：只处理游标之后的新消息，旧消息不重放', async () => {
  const now = Math.floor(Date.now() / 1000)
  const dbFile = makeDb([
    { msg_id: 'old', account: 'wxid_cap', chat_wxid: 'zj391504704', chat_display: 'Z.俊', is_group: false, ts: now - 100, sender: 'them', content: '老消息' },
    { msg_id: 'new', account: 'wxid_cap', chat_wxid: 'zj391504704', chat_display: 'Z.俊', is_group: false, ts: now, sender: 'them', content: '新消息' },
  ])
  const cursor = tmp('.json')
  const ctx = makeCtx()
  const w = new PrivateChatWatcher({ dbFile, agent: ctx.agent, provider: ctx.provider, profileStore: ctx.profileStore, contextTokens: ctx.contextTokens, cursorFile: cursor, initialCursor: now - 50 })
  try {
    await w.sweep()
    assert.equal(ctx.responded.length, 1, '只处理游标之后的新消息')
    assert.match(ctx.responded[0].text, /新消息/)
  } finally {
    w.stop()
    w.close()
    fs.rmSync(dbFile, { force: true, maxRetries: 5, retryDelay: 50 })
    fs.rmSync(cursor, { force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('昵称降级匹配：无 wxid 档案按昵称唯一命中', async () => {
  const now = Math.floor(Date.now() / 1000)
  const dbFile = makeDb([
    { msg_id: 'm1', account: 'wxid_cap', chat_wxid: 'zj391504704', chat_display: 'Z.俊', is_group: false, ts: now, sender: 'them', sender_display: 'Z.俊', content: '按昵称认我' },
  ])
  const cursor = tmp('.json')
  const ctx = makeCtx({ profiles: [{ userId: 'u_zj', nickname: 'Z.俊', ilinkUserId: 'o9cq@im.wechat' }] })
  const w = new PrivateChatWatcher({ dbFile, agent: ctx.agent, provider: ctx.provider, profileStore: ctx.profileStore, contextTokens: ctx.contextTokens, cursorFile: cursor, initialCursor: 0 })
  try {
    await w.sweep()
    assert.equal(ctx.responded.length, 1)
    assert.match(ctx.responded[0].text, /按昵称认我/)
  } finally {
    w.stop()
    w.close()
    fs.rmSync(dbFile, { force: true, maxRetries: 5, retryDelay: 50 })
    fs.rmSync(cursor, { force: true, maxRetries: 5, retryDelay: 50 })
  }
})
