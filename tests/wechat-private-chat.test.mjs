import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { WechatLogStore } from '../src/services/wechat-log-store.mjs'

/** 私聊 = 该用户与助手的对话（2026-09-19 用户澄清，生产实证）。
 *
 * 回归背景：`accessibleChats` 曾把私聊的名字写死成 `'与助手的对话（私聊）'`，
 * 于是 `wechat_search_chat("Z.俊")` 解析失败（`chat_not_found_or_not_accessible`）
 * ——可同步库 messages 表里那条私聊的 `chat_display` 正是用户的昵称。
 * 谁都没想到"客户端里自己昵称 = 私聊显示名"，所以这里用夹具钉死三种入口：
 * 昵称、助手指代、wxid，全部必须指向同一条私聊。 */

function makeDb() {
  const file = path.join(os.tmpdir(), `wechat-priv-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE messages (
      msg_id TEXT, account TEXT, chat_wxid TEXT, chat_display TEXT, is_group INTEGER,
      ts INTEGER, datetime TEXT, sender TEXT, sender_wxid TEXT, sender_display TEXT,
      msg_type INTEGER, content TEXT, attachment TEXT, device TEXT, received_at INTEGER
    );
    CREATE TABLE chat_roster (chat_wxid TEXT, chat_name TEXT, member_wxid TEXT, member_display TEXT);
  `)
  const ins = db.prepare(`INSERT INTO messages
    (msg_id, account, chat_wxid, chat_display, is_group, ts, sender, sender_wxid, sender_display, msg_type, content)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
  // 该用户与助手的私聊（chat_display = 用户昵称）
  ins.run('m1', 'acc', 'zj391504704', 'Z.俊', 0, 1789000000, 'them', 'zj391504704', 'Z.俊', 1, '你好')
  ins.run('m2', 'acc', 'zj391504704', 'Z.俊', 0, 1789000100, 'me', 'acc_x', '助手', 1, '你好，有什么可以帮你')
  // 一个他所在的群
  ins.run('m3', 'acc', '53307754079@chatroom', '内部群-平安银行POC', 1, 1789000200, 'them', 'zj391504704', 'Z.俊', 1, '群里说话')
  const roster = db.prepare('INSERT INTO chat_roster (chat_wxid, chat_name, member_wxid, member_display) VALUES (?,?,?,?)')
  roster.run('53307754079@chatroom', '内部群-平安银行POC', 'zj391504704', 'Z.俊')
  db.close()
  return file
}

test('私聊 = 与助手的对话：昵称/助手指代/wxid 三种入口都能查到同一份记录', () => {
  const file = makeDb()
  const store = new WechatLogStore({ file, onAmbiguousNickname: () => {} })
  try {
    const ident = { wxid: 'zj391504704', nickname: 'Z.俊' }

    // 会话列表：私聊必须带真实显示名（昵称），同时保留"助手"别名
    const priv = store.listMyChats(ident).filter((c) => !c.isGroup)
    assert.equal(priv.length, 1)
    assert.equal(priv[0].chatWxid, 'zj391504704')
    assert.equal(priv[0].name, 'Z.俊', '私聊显示名应是用户昵称，不能写死成标签')
    assert.match(String(priv[0].alias || ''), /助手/)

    // 三种问法都必须命中同一份对话
    for (const q of ['Z.俊', '助手', '私聊', 'zj391504704']) {
      const r = store.searchChat({ chat: q, limit: 10 }, ident)
      assert.equal(r.error, undefined, `searchChat(${q}) 不应报错`)
      assert.equal(r.messages.length, 2, `searchChat(${q}) 应命中 2 条`)
      assert.ok(r.messages.some((m) => m.content.includes('你好，有什么可以帮你')), `searchChat(${q}) 应含助手回复`)
    }

    // 群聊不受影响
    const g = store.searchChat({ chat: '内部群-平安银行POC' }, ident)
    assert.equal(g.messages.length, 1)
  } finally {
    store.close?.()
    fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('无 wxid 时按昵称降级：仍能解析到与助手的私聊', () => {
  const file = makeDb()
  const store = new WechatLogStore({ file, onAmbiguousNickname: () => {} })
  try {
    const ident = { wxid: '', nickname: 'Z.俊' }
    const r = store.searchChat({ chat: 'Z.俊', limit: 10 }, ident)
    assert.equal(r.error, undefined)
    assert.equal(r.messages.length, 2)
    const priv = store.listMyChats(ident).filter((c) => !c.isGroup)
    assert.equal(priv.length, 1)
    assert.equal(priv[0].name, 'Z.俊')
  } finally {
    store.close?.()
    fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 })
  }
})
