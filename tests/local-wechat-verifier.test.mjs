import test from 'node:test'
import assert from 'node:assert/strict'
import { LocalWechatVerifier } from '../src/services/local-wechat-verifier.mjs'

test('local verifier reads assistant chat and verifies sender profile', async () => {
  const now = 1_800_000_000_000
  let requested
  const verifier = new LocalWechatVerifier({ now: () => now, readChat: async (args) => { requested = args; return { messages: [{ sender_wxid: 'wxid-a', sender_display: '张三', content: '绑定 WA-ABCDEF12', ts: 1_800_000_000 }] } } })
  const task = verifier.createTask({ ilinkUserId: 'peer@im.wechat' })
  task.code = 'WA-ABCDEF12'
  const result = await verifier.checkTask(task)
  assert.equal(requested.contact, '助手')
  assert.equal(result.status, 'verified')
  assert.equal(result.profile.nickname, '张三')
})
