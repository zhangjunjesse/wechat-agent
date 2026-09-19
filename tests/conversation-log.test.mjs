import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { ConversationLog } from '../src/services/conversation-log.mjs'
import { WechatLogStore } from '../src/services/wechat-log-store.mjs'

/** ADR-0042：助手把自己的对话落进同步库，让"用户跟助手的对话"可被 wechat_* 工具
 * 读到全量。生产实测缺口：助手侧 191 条用户消息 vs 微信侧只同步到 71 条。
 *
 * 这组测试盯两件事：① 写进去的能被读侧按昵称/助手指代读到；② 任何写入失败都不许
 * 冒泡（库只读、目录不存在、内容为空……），因为这行代码跑在回复主链路上。 */

const SCHEMA = `
  CREATE TABLE messages (
    msg_id TEXT PRIMARY KEY, account TEXT, chat_wxid TEXT, chat_display TEXT, is_group INTEGER,
    ts INTEGER, datetime TEXT, sender TEXT, sender_wxid TEXT, sender_display TEXT,
    msg_type INTEGER, content TEXT, attachment TEXT, device TEXT, received_at INTEGER
  );
  CREATE TABLE chat_roster (chat_wxid TEXT, chat_name TEXT, member_wxid TEXT, member_display TEXT);
`

function tmpFile(suffix = '.db') {
  return path.join(os.tmpdir(), `convlog-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`)
}

function makeDb() {
  const file = tmpFile()
  const db = new DatabaseSync(file)
  db.exec(SCHEMA)
  db.close()
  return file
}

test('写入的对话能被读侧读到：按昵称和"助手"都命中同一条线程', () => {
  const file = makeDb()
  const log = new ConversationLog({ dbFile: file, chatWxid: 'wxid_zhang', chatDisplay: '张三', onWarn: () => {} })
  try {
    assert.equal(log.enabled, true)
    // 显式时间戳：秒级精度下两条挨着写会落进同一秒，顺序就不确定了
    const t0 = 1789000000000
    assert.equal(log.recordInbound({ text: '帮我查天气', wxid: 'wxid_zhang', nickname: '张三', tsMs: t0 }), true)
    assert.equal(log.recordOutbound({ text: '今天晴，26 度', tsMs: t0 + 5000 }), true)

    const store = new WechatLogStore({ file })
    try {
      const byName = store.searchChat({ chat: '张三' }, { wxid: 'wxid_zhang', nickname: '张三' })
      assert.equal(byName.error, undefined)
      assert.equal(byName.messages.length, 2)
      assert.deepEqual(byName.messages.map((m) => m.content), ['帮我查天气', '今天晴，26 度'])
      // 助手指代入口
      const byAlias = store.searchChat({ chat: '助手' }, { wxid: 'wxid_zhang', nickname: '张三' })
      assert.equal(byAlias.messages.length, 2)
      // 展示名落的是用户昵称，不是助手
      const priv = store.listMyChats({ wxid: 'wxid_zhang', nickname: '张三' }).filter((c) => !c.isGroup)
      assert.equal(priv[0].name, '张三')
    } finally {
      store.close?.() // Windows 上不关句柄就删不掉文件
    }
  } finally {
    log.close()
    fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('同一条消息写两遍只留一条（msg_id 派生去重）', () => {
  const file = makeDb()
  const log = new ConversationLog({ dbFile: file, chatWxid: 'wxid_zhang', chatDisplay: '张三', onWarn: () => {} })
  try {
    const ts = 1789000000000
    log.recordInbound({ text: '重复投递', wxid: 'wxid_zhang', nickname: '张三', tsMs: ts })
    log.recordInbound({ text: '重复投递', wxid: 'wxid_zhang', nickname: '张三', tsMs: ts })
    const db = new DatabaseSync(file, { readOnly: true })
    assert.equal(db.prepare('SELECT COUNT(*) c FROM messages').get().c, 1)
    db.close()
  } finally {
    log.close()
    fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('写不进去也不抛：库不存在 / 只读 / 内容为空', () => {
  // ① 目录不存在
  const missing = new ConversationLog({ dbFile: path.join(os.tmpdir(), 'no-such-dir-xyz', 'a.db'), chatWxid: 'w', onWarn: () => {} })
  assert.equal(missing.enabled, false)
  assert.equal(missing.recordInbound({ text: '你好' }), false)
  assert.equal(missing.recordOutbound({ text: '你好' }), false)

  // ② 只读文件（模拟生产挂载 :ro）
  const file = makeDb()
  const ro = new ConversationLog({ dbFile: file, chatWxid: 'w', onWarn: () => {} })
  ro.close()
  const roLog = new ConversationLog({ dbFile: file, chatWxid: 'w', onWarn: () => {} })
  // 只读挂载下 open 仍会成功（SQLite 只在写时才失败），关键是不抛
  assert.doesNotThrow(() => roLog.recordInbound({ text: '写不进去' }))
  roLog.close()
  fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 })

  // ③ 空内容不写
  const f2 = makeDb()
  const l2 = new ConversationLog({ dbFile: f2, chatWxid: 'w', onWarn: () => {} })
  assert.equal(l2.recordInbound({ text: '   ' }), false)
  assert.equal(l2.recordInbound({ text: '' }), false)
  const db2 = new DatabaseSync(f2, { readOnly: true })
  assert.equal(db2.prepare('SELECT COUNT(*) c FROM messages').get().c, 0)
  db2.close()
  l2.close()
  fs.rmSync(f2, { force: true, maxRetries: 5, retryDelay: 50 })
})

test('缺 chatWxid 时整体停用（没有可信线程标识就不写，与 ADR-0007 判定一致）', () => {
  const file = makeDb()
  const log = new ConversationLog({ dbFile: file, chatWxid: '', onWarn: () => {} })
  assert.equal(log.enabled, false)
  assert.equal(log.recordInbound({ text: '你好', nickname: '张三' }), false)
  log.close()
  fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 })
})
