import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { WechatLogStore } from '../src/services/wechat-log-store.mjs'

// Mirrors server/receiver.py's SCHEMA (wechat-chatlog-dsh repo) so tests stay
// honest about the real on-disk shape this store reads.
function makeDb(file) {
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE messages (
      msg_id TEXT PRIMARY KEY, account TEXT, chat_wxid TEXT, chat_display TEXT,
      is_group INTEGER, ts INTEGER, datetime TEXT, sender TEXT, sender_wxid TEXT,
      sender_display TEXT, msg_type INTEGER, content TEXT, attachment TEXT,
      device TEXT, received_at INTEGER
    );
    CREATE INDEX idx_chat_ts ON messages(chat_wxid, ts);
    CREATE TABLE chat_roster (
      chat_wxid TEXT NOT NULL, chat_name TEXT, member_wxid TEXT NOT NULL,
      member_display TEXT, synced_at INTEGER NOT NULL,
      PRIMARY KEY (chat_wxid, member_wxid)
    );
  `)
  return db
}

function insertMsg(db, { id, chat, display, isGroup, ts, senderWxid, senderDisplay, content, msgType = 1 }) {
  db.prepare(`INSERT INTO messages (msg_id, account, chat_wxid, chat_display, is_group, ts, datetime, sender, sender_wxid, sender_display, msg_type, content, attachment, device, received_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, 'acc', chat, display, isGroup ? 1 : 0, ts, '', senderWxid, senderWxid, senderDisplay, msgType, content, null, 'dev', ts)
}

function insertRoster(db, { chat, name, memberWxid, memberDisplay }) {
  db.prepare(`INSERT INTO chat_roster (chat_wxid, chat_name, member_wxid, member_display, synced_at) VALUES (?,?,?,?,?)`)
    .run(chat, name, memberWxid, memberDisplay, 1000)
}

function withStore(fn) {
  const file = path.join(os.tmpdir(), `wls-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const db = makeDb(file)
  try {
    // Group A: zhangsan + lisi
    insertRoster(db, { chat: 'g1@chatroom', name: '项目群', memberWxid: 'wxid_zhang', memberDisplay: '张三' })
    insertRoster(db, { chat: 'g1@chatroom', name: '项目群', memberWxid: 'wxid_li', memberDisplay: '李四' })
    // Group B: only lisi (zhangsan NOT a member)
    insertRoster(db, { chat: 'g2@chatroom', name: '闲聊群', memberWxid: 'wxid_li', memberDisplay: '李四' })

    insertMsg(db, { id: 'm1', chat: 'g1@chatroom', display: '项目群', isGroup: true, ts: 1000, senderWxid: 'wxid_zhang', senderDisplay: '张三', content: '今天进度如何' })
    insertMsg(db, { id: 'm2', chat: 'g1@chatroom', display: '项目群', isGroup: true, ts: 1100, senderWxid: 'wxid_li', senderDisplay: '李四', content: '@张三 请确认接口' })
    insertMsg(db, { id: 'm3', chat: 'g1@chatroom', display: '项目群', isGroup: true, ts: 2000, senderWxid: 'wxid_li', senderDisplay: '李四', content: '晚点再说' })
    insertMsg(db, { id: 'm4', chat: 'g2@chatroom', display: '闲聊群', isGroup: true, ts: 1500, senderWxid: 'wxid_li', senderDisplay: '李四', content: '午饭吃什么' })
    // zhangsan's own direct thread with 助手 (chat_wxid === zhangsan's own wxid)
    insertMsg(db, { id: 'm5', chat: 'wxid_zhang', display: '张三', isGroup: false, ts: 1200, senderWxid: 'wxid_zhang', senderDisplay: '张三', content: '@助手 帮我查天气' })
    insertMsg(db, { id: 'm6', chat: 'wxid_zhang', display: '张三', isGroup: false, ts: 1300, senderWxid: '', senderDisplay: '助手', content: '好的' })
    // a non-text message
    insertMsg(db, { id: 'm7', chat: 'g1@chatroom', display: '项目群', isGroup: true, ts: 1400, senderWxid: 'wxid_zhang', senderDisplay: '张三', content: '', msgType: 3 })
    db.close()
    const store = new WechatLogStore({ file })
    return fn(store)
  } finally {
    try { fs.rmSync(file, { force: true }) } catch (e) {}
  }
}

const zhangsan = { wxid: 'wxid_zhang', nickname: '张三' }
const lisi = { wxid: 'wxid_li', nickname: '李四' }

test('accessibleChats: group membership plus own direct thread, isolated per user', () => {
  withStore((store) => {
    const zChats = store.accessibleChats(zhangsan).map((c) => c.name).sort()
    assert.deepEqual(zChats, ['与助手的对话（私聊）', '项目群'])
    const lChats = store.accessibleChats(lisi).map((c) => c.name).sort()
    assert.deepEqual(lChats, ['与助手的对话（私聊）', '项目群', '闲聊群'].sort())
  })
})

test('searchChat: full conversation in an accessible group', () => {
  withStore((store) => {
    const r = store.searchChat({ chat: '项目群' }, zhangsan)
    assert.equal(r.truncated, false)
    assert.equal(r.messages.length, 4) // m1, m2, m3, m7
    assert.equal(r.messages[0].content, '今天进度如何')
  })
})

test('searchChat: denied for a group the user is not a member of, without leaking existence', () => {
  withStore((store) => {
    const r = store.searchChat({ chat: '闲聊群' }, zhangsan)
    assert.equal(r.error, 'chat_not_found_or_not_accessible')
    // lisi (who IS a member) can see it
    const ok = store.searchChat({ chat: '闲聊群' }, lisi)
    assert.equal(ok.messages.length, 1)
  })
})

test('searchChat: "助手"/"assistant" resolves to the caller\'s own direct thread', () => {
  withStore((store) => {
    const r = store.searchChat({ chat: '助手' }, zhangsan)
    assert.equal(r.messages.length, 2)
    assert.equal(r.messages[0].content, '@助手 帮我查天气')
    // lisi has no direct-thread messages recorded, but the thread itself is
    // still "accessible" (their own wxid) — just empty
    const l = store.searchChat({ chat: 'assistant' }, lisi)
    assert.equal(l.messages.length, 0)
  })
})

test('searchMentions: default target is the caller\'s own nickname, scoped to their accessible chats', () => {
  withStore((store) => {
    const r = store.searchMentions({}, zhangsan)
    assert.equal(r.messages.length, 1)
    assert.equal(r.messages[0].content, '@张三 请确认接口')
    assert.equal(r.messages[0].chatName, '项目群')
  })
})

test('searchMentions: explicit target "助手"', () => {
  withStore((store) => {
    const r = store.searchMentions({ target: '助手' }, zhangsan)
    assert.equal(r.messages.length, 1)
    assert.equal(r.messages[0].content, '@助手 帮我查天气')
  })
})

test('searchMyMessages: across all accessible chats, or scoped to one', () => {
  withStore((store) => {
    const all = store.searchMyMessages({}, zhangsan)
    assert.equal(all.messages.length, 3) // m1, m5, m7 (image)
    const scoped = store.searchMyMessages({ chat: '助手' }, zhangsan)
    assert.equal(scoped.messages.length, 1)
    assert.equal(scoped.messages[0].content, '@助手 帮我查天气')
  })
})

test('time range filters by ts (unix seconds) derived from epoch ms', () => {
  withStore((store) => {
    const r = store.searchChat({ chat: '项目群', sinceMs: 1500 * 1000, untilMs: 3000 * 1000 }, lisi)
    assert.equal(r.messages.length, 1) // only m3 (ts=2000)
    assert.equal(r.messages[0].content, '晚点再说')
  })
})

test('non-text messages are labeled by type, never fabricated as text', () => {
  withStore((store) => {
    const r = store.searchChat({ chat: '项目群' }, zhangsan)
    const img = r.messages.find((m) => m.content.includes('图片'))
    assert.ok(img)
  })
})

test('limit is capped and truncation is reported, never silently unbounded', () => {
  withStore((store) => {
    const r = store.searchChat({ chat: '项目群', limit: 2 }, zhangsan)
    assert.equal(r.messages.length, 2)
    assert.equal(r.truncated, true)
    // most recent 2 kept, in chronological order
    assert.equal(r.messages[1].content.includes('图片') || r.messages[1].content === '晚点再说', true)
  })
})

test('no identity (unverified) yields no accessible chats, not an error leak', () => {
  withStore((store) => {
    assert.deepEqual(store.accessibleChats({}), [])
    const r = store.searchMyMessages({}, {})
    assert.equal(r.error, 'no_identity')
  })
})
