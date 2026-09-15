import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { GroupCommandWatcher } from '../src/services/group-command-watcher.mjs'

function makeDb(rows) {
  const file = path.join(os.tmpdir(), `gcmd-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE messages (
      msg_id TEXT PRIMARY KEY, account TEXT, chat_wxid TEXT, chat_display TEXT, is_group INTEGER,
      ts INTEGER, datetime TEXT, sender TEXT, sender_wxid TEXT, sender_display TEXT,
      msg_type INTEGER, content TEXT, attachment TEXT, device TEXT, received_at INTEGER
    );
  `)
  const ins = db.prepare('INSERT INTO messages (msg_id, chat_wxid, chat_display, is_group, ts, sender_wxid, sender_display, msg_type, content, attachment) VALUES (?,?,?,?,?,?,?,?,?,?)')
  for (const r of rows) ins.run(r.msg_id, r.chat_wxid, r.chat_display || r.chat_wxid, 1, r.ts, r.sender_wxid || '', r.sender_display || '', r.msg_type || 1, r.content || '', r.attachment || '')
  db.close()
  return file
}

function setup({ rows, profiles = [{ userId: 'u1', nickname: 'Z.俊', wxid: 'wx_zj', ilinkUserId: 'ilink_zj' }] } = {}) {
  const dbFile = makeDb(rows)
  const cursorFile = path.join(os.tmpdir(), `gcmd-cur-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  const calls = []
  const sent = []
  const agent = { respond: async (args) => { calls.push(args); return { text: `已处理：${(args.text.match(/指令：(.+)/) || [])[1] || ''}` } } }
  const provider = { sendText: async (a) => { sent.push(a); return {} } }
  const profileStore = {
    list: async () => profiles,
    get: async (id) => profiles.find((p) => p.userId === id) || null,
  }
  const contextTokens = {
    get: (ilinkId) => (ilinkId === 'ilink_zj' ? { contextToken: 'tok-zj', providerBotId: 'bot-zj' } : null),
  }
  const watcher = new GroupCommandWatcher({ dbFile, agent, provider, profileStore, contextTokens, cursorFile, initialCursor: 0 })
  return { dbFile, cursorFile, watcher, calls, sent }
}

const QUOTE_ATTACHMENT = JSON.stringify({ kind: 'quote', reply: '@助手 看一下', quoted_name: 'Z.俊', quoted_text: 'https://xingetech.feishu.cn/docx/JclldYOGMooflZxaEiYcfBeLngc?from=from_copylink' })

test('watcher turns a group @助手 quote into an agent call and a private push', async () => {
  const { cursorFile, watcher, calls, sent } = setup({
    rows: [{ msg_id: 'm1', chat_wxid: '53512663852@chatroom', chat_display: 'Agent安全测试群', ts: 1789471204, sender_display: 'Z.俊', content: '@助手\u2005看一下', attachment: QUOTE_ATTACHMENT }],
  })
  try {
    await watcher.sweep()
    assert.equal(calls.length, 1)
    const text = calls[0].text
    assert.match(text, /Agent安全测试群/)
    assert.match(text, /📌 引用的消息内容/)
    assert.match(text, /feishu\.cn\/docx\/JclldYOGMooflZxaEiYcfBeLngc/)
    assert.match(text, /指令：看一下/)
    assert.match(text, /wechat_search_chat/)
    // 身份与私聊通道：会话键 = ilinkUserId（与私聊一致），不是浏览器档案 id
    assert.equal(calls[0].userId, 'ilink_zj')
    assert.equal(calls[0].channel.toProviderUserId, 'ilink_zj')
    // 秒回 ack（先确认，再结果）
    assert.equal(sent.length, 2)
    assert.match(sent[0].text, /收到你的指令，正在处理/)
    assert.equal(sent[0].toProviderUserId, 'ilink_zj')
    assert.match(sent[1].text, /已处理：看一下/)
    // 第二轮 sweep 不重复（msg_id 去重 + 游标推进）
    await watcher.sweep()
    assert.equal(calls.length, 1)
  } finally {
    fs.rmSync(cursorFile, { force: true })
  }
})

test('watcher ignores non-verified senders and non-@助手 messages', async () => {
  const { cursorFile, watcher, calls, sent } = setup({
    rows: [
      { msg_id: 'm1', chat_wxid: 'g1@chatroom', ts: 100, sender_display: '陌生人', content: '@助手 在吗' },
      { msg_id: 'm2', chat_wxid: 'g1@chatroom', ts: 200, sender_display: 'Z.俊', content: '普通消息不带@' },
    ],
  })
  try {
    await watcher.sweep()
    assert.equal(calls.length, 0)
    assert.equal(sent.length, 0)
  } finally {
    fs.rmSync(cursorFile, { force: true })
  }
})

test('watcher skips users without a private-channel token (no push possible)', async () => {
  const { cursorFile, watcher, calls } = setup({
    rows: [{ msg_id: 'm1', chat_wxid: 'g1@chatroom', ts: 100, sender_display: 'Z.俊', content: '@助手 处理下', attachment: QUOTE_ATTACHMENT }],
    profiles: [{ userId: 'u2', nickname: 'Z.俊', wxid: 'wx_zj', ilinkUserId: 'ilink_other' }], // ilink_other 无 token
  })
  try {
    await watcher.sweep()
    assert.equal(calls.length, 0) // 无 token 跳过，不调 agent
  } finally {
    fs.rmSync(cursorFile, { force: true })
  }
})

test('watcher picks the matching profile that has a push channel, skipping tokenless duplicates', async () => {
  const { cursorFile, watcher, calls, sent } = setup({
    rows: [{ msg_id: 'm1', chat_wxid: 'g1@chatroom', chat_display: '测试群', ts: 100, sender_display: 'Z.俊', content: '@助手 读一下', attachment: QUOTE_ATTACHMENT }],
    // 第一个同名档案无 token（test-user 式残留），第二个有 token —— 应选第二个
    profiles: [
      { userId: 'test-user', nickname: 'Z.俊', wxid: 'wx_zj', ilinkUserId: 'ilink_none' },
      { userId: 'u-real', nickname: 'Z.俊', wxid: 'wx_zj', ilinkUserId: 'ilink_zj' },
    ],
  })
  try {
    await watcher.sweep()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].userId, 'ilink_zj') // 会话键 = 稳定 ilinkUserId（与私聊一致）
    assert.equal(calls[0].channel.toProviderUserId, 'ilink_zj')
    assert.equal(sent.length, 2) // ack + 结果
    assert.match(sent[0].text, /收到你的指令/)
  } finally {
    fs.rmSync(cursorFile, { force: true })
  }
})

test('cursor persists so restarts do not reprocess', async () => {
  const { dbFile, cursorFile, watcher, calls } = setup({
    rows: [{ msg_id: 'm1', chat_wxid: 'g1@chatroom', ts: 500, sender_display: 'Z.俊', content: '@助手 你好', attachment: QUOTE_ATTACHMENT }],
  })
  try {
    await watcher.sweep()
    assert.equal(calls.length, 1)
    watcher.stop() // 落盘游标
    const saved = JSON.parse(fs.readFileSync(cursorFile, 'utf8'))
    assert.equal(saved.ts, 500)
    // 重建 watcher（同游标文件）→ 不再处理旧消息
    const agent2 = { respond: async () => { calls.push('again'); return { text: 'x' } } }
    const watcher2 = new GroupCommandWatcher({ dbFile, agent: agent2, provider: { sendText: async () => ({}) }, profileStore: { list: async () => [{ userId: 'u1', nickname: 'Z.俊' }], get: async () => ({}) }, contextTokens: { get: () => ({ contextToken: 't', providerBotId: 'b' }) }, cursorFile })
    await watcher2.sweep()
    assert.equal(calls.length, 1) // 未新增处理
  } finally {
    fs.rmSync(cursorFile, { force: true })
  }
})
