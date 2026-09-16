import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { resolveBackfill } from '../scripts/backfill-wechat-wxid.mjs'

// ADR-0032: the backfill script reverse-looks-up wxid from the verification
// code message itself (code + messageTs, already recorded on every verified
// profile), NOT from chat_roster nicknames — that would reintroduce the exact
// same-name ambiguity accessibleChats was just fixed to refuse.

function makeDb(rows) {
  const file = path.join(os.tmpdir(), `bfw-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE messages (
      msg_id TEXT PRIMARY KEY, chat_wxid TEXT, chat_display TEXT, is_group INTEGER,
      ts INTEGER, sender_wxid TEXT, sender_display TEXT, content TEXT
    );
  `)
  const ins = db.prepare('INSERT INTO messages (msg_id, chat_wxid, chat_display, is_group, ts, sender_wxid, sender_display, content) VALUES (?,?,?,?,?,?,?,?)')
  rows.forEach((r, i) => ins.run(`m${i}`, r.chatWxid, r.chatDisplay || r.chatWxid, r.isGroup ? 1 : 0, r.ts, r.senderWxid || '', r.senderDisplay || '', r.content))
  return { db, file, cleanup: () => { db.close(); fs.rmSync(file, { force: true }) } }
}

test('backfills from chat_wxid when the message row has no sender_wxid (the common production case)', () => {
  const { db, cleanup } = makeDb([
    { chatWxid: 'zj391504704', chatDisplay: 'Z.俊', isGroup: false, ts: 1_700_000_000, senderWxid: '', senderDisplay: 'Z.俊', content: '收到验证码 483920' },
  ])
  try {
    const result = resolveBackfill(db, { userId: 'u1', nickname: 'Z.俊', wxid: '', code: '483920', messageTs: 1_700_000_000 })
    assert.equal(result.skip, undefined)
    assert.equal(result.plan.wxid, 'zj391504704')
    assert.equal(result.plan.evidence.sourceField.startsWith('chat_wxid'), true)
  } finally { cleanup() }
})

test('prefers sender_wxid over chat_wxid when the message row does carry it', () => {
  const { db, cleanup } = makeDb([
    { chatWxid: 'wxid-thread', isGroup: false, ts: 1_700_000_000, senderWxid: 'wxid-real-sender', senderDisplay: '张三', content: '483920' },
  ])
  try {
    const result = resolveBackfill(db, { userId: 'u1', nickname: '张三', wxid: '', code: '483920', messageTs: 1_700_000_000 })
    assert.equal(result.plan.wxid, 'wxid-real-sender')
    assert.equal(result.plan.evidence.sourceField, 'sender_wxid')
  } finally { cleanup() }
})

test('already has wxid: skipped without touching anything', () => {
  const { db, cleanup } = makeDb([])
  try {
    const result = resolveBackfill(db, { userId: 'u1', nickname: 'x', wxid: 'already-known', code: '111111', messageTs: 1000 })
    assert.match(result.skip, /已有 wxid/)
  } finally { cleanup() }
})

test('no code/messageTs recorded on the profile: honest skip, not a guess', () => {
  const { db, cleanup } = makeDb([])
  try {
    assert.match(resolveBackfill(db, { userId: 'u1', nickname: 'x', wxid: '' }).skip, /验证码/)
    assert.match(resolveBackfill(db, { userId: 'u1', nickname: 'x', wxid: '', code: '111111' }).skip, /时间戳/)
  } finally { cleanup() }
})

test('code message no longer in the chat log (outside retention / purged): honest skip, not a guess', () => {
  const { db, cleanup } = makeDb([])
  try {
    const result = resolveBackfill(db, { userId: 'u1', nickname: 'x', wxid: '', code: '999999', messageTs: 1_700_000_000 })
    assert.match(result.skip, /找不到/)
  } finally { cleanup() }
})

test('multiple candidate messages in the time window: refuses to guess which one', () => {
  const { db, cleanup } = makeDb([
    { chatWxid: 'wxid-a', isGroup: false, ts: 1_700_000_000, senderWxid: '', senderDisplay: 'A', content: '483920' },
    { chatWxid: 'wxid-b', isGroup: false, ts: 1_700_000_002, senderWxid: '', senderDisplay: 'B', content: '收到 483920 了' },
  ])
  try {
    const result = resolveBackfill(db, { userId: 'u1', nickname: 'x', wxid: '', code: '483920', messageTs: 1_700_000_000 })
    assert.match(result.skip, /2 条候选/)
  } finally { cleanup() }
})

test('a group-chat message containing the code is never used to attribute a personal wxid', () => {
  const { db, cleanup } = makeDb([
    { chatWxid: 'g1@chatroom', isGroup: true, ts: 1_700_000_000, senderWxid: '', senderDisplay: '路人', content: '我们群号是 483920' },
  ])
  try {
    const result = resolveBackfill(db, { userId: 'u1', nickname: 'x', wxid: '', code: '483920', messageTs: 1_700_000_000 })
    assert.match(result.skip, /找不到/) // is_group=0 filter excludes it entirely, same as "not found"
  } finally { cleanup() }
})

test('the filehelper self-chat is excluded from the chat_wxid fallback (dev self-test channel, not a real user)', () => {
  const { db, cleanup } = makeDb([
    { chatWxid: 'filehelper', isGroup: false, ts: 1_700_000_000, senderWxid: '', senderDisplay: '文件传输助手', content: '483920' },
  ])
  try {
    const result = resolveBackfill(db, { userId: 'u1', nickname: 'x', wxid: '', code: '483920', messageTs: 1_700_000_000 })
    assert.match(result.skip, /没有可用的个人 wxid/)
  } finally { cleanup() }
})

test('matches within the tolerance window even if ts is off by a couple seconds', () => {
  const { db, cleanup } = makeDb([
    { chatWxid: 'wxid-a', isGroup: false, ts: 1_700_000_003, senderWxid: '', senderDisplay: 'A', content: '483920' },
  ])
  try {
    const result = resolveBackfill(db, { userId: 'u1', nickname: 'x', wxid: '', code: '483920', messageTs: 1_700_000_000 }, { windowSec: 5 })
    assert.equal(result.plan.wxid, 'wxid-a')
  } finally { cleanup() }
})
