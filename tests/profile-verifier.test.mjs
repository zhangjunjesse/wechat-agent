import test from 'node:test'
import assert from 'node:assert/strict'
import { createVerificationCode, findAssistantCode } from '../src/services/profile-verifier.mjs'

test('assistant code verification returns sender wxid and nickname', () => {
  const code = createVerificationCode()
  assert.match(code, /^\d{6}$/)
  const result = findAssistantCode([{ sender_wxid: 'wxid-a', sender_display: '张三', content: `收到 ${code}`, ts: 1_800_000_000 }], code, { now: () => 1_800_000_100_000 })
  assert.deepEqual(result, { wxid: 'wxid-a', nickname: '张三', remark: '', messageTs: 1_800_000_000, code })
})

// ---- ADR-0032: chatWxid fallback for the (common in production) case where
// the message row's own sender_wxid is empty ----

test('ADR-0032: falls back to chatWxid when sender_wxid is missing and the chat is a 1:1 thread', () => {
  const code = createVerificationCode()
  const result = findAssistantCode(
    [{ sender_wxid: '', sender_display: '张三', content: `收到 ${code}`, ts: 1_800_000_000 }],
    code,
    { now: () => 1_800_000_100_000, chatWxid: 'zj391504704' },
  )
  assert.equal(result.wxid, 'zj391504704')
  assert.equal(result.nickname, '张三')
})

test('ADR-0032: sender_wxid on the message still wins over the chatWxid fallback', () => {
  const code = createVerificationCode()
  const result = findAssistantCode(
    [{ sender_wxid: 'wxid-real', sender_display: '张三', content: `收到 ${code}`, ts: 1_800_000_000 }],
    code,
    { now: () => 1_800_000_100_000, chatWxid: 'some-other-id' },
  )
  assert.equal(result.wxid, 'wxid-real')
})

test('ADR-0032: chatWxid fallback is never used for a group chat (@chatroom) — a group id is not a personal wxid', () => {
  const code = createVerificationCode()
  const result = findAssistantCode(
    [{ sender_wxid: '', sender_display: '张三', content: `收到 ${code}`, ts: 1_800_000_000 }],
    code,
    { now: () => 1_800_000_100_000, chatWxid: '53512663852@chatroom' },
  )
  assert.equal(result.wxid, '')
})

test('ADR-0032: no chatWxid given (e.g. LocalWechatVerifier) behaves exactly as before — empty wxid stays empty', () => {
  const code = createVerificationCode()
  const result = findAssistantCode(
    [{ sender_wxid: '', sender_display: '张三', content: `收到 ${code}`, ts: 1_800_000_000 }],
    code,
    { now: () => 1_800_000_100_000 },
  )
  assert.equal(result.wxid, '')
})
