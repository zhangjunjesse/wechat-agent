import test from 'node:test'
import assert from 'node:assert/strict'
import { createVerificationCode, findAssistantCode } from '../src/services/profile-verifier.mjs'

test('assistant code verification returns sender wxid and nickname', () => {
  const code = createVerificationCode()
  assert.match(code, /^WA-[0-9A-F]{8}$/)
  const result = findAssistantCode([{ sender_wxid: 'wxid-a', sender_display: '张三', content: `收到 ${code}`, ts: 1_800_000_000 }], code, { now: () => 1_800_000_100_000 })
  assert.deepEqual(result, { wxid: 'wxid-a', nickname: '张三', remark: '', messageTs: 1_800_000_000, code })
})
