import test from 'node:test'
import assert from 'node:assert/strict'
import { RemoteWechatVerifier } from '../src/services/remote-wechat-verifier.mjs'

test('remote verifier locates assistant in synced chat API', async () => {
  const calls = []
  const now = 1_800_000_000_000
  const verifier = new RemoteWechatVerifier({ baseUrl: 'https://sync.example', accessKey: 'key', now: () => now, fetchImpl: async (url) => { calls.push(url); return { ok: true, json: async () => url.includes('/chats') ? { chats: [{ chat_wxid: 'wxid-assistant', chat_display: '助手' }] } : { messages: [{ sender_wxid: 'wxid-user', sender_display: '张三', content: 'WA-ABCDEF12', ts: 1_800_000_000 }] } } } })
  const task = verifier.createTask({ ilinkUserId: 'peer@im.wechat' }); task.code = 'WA-ABCDEF12'
  const result = await verifier.checkTask(task)
  assert.equal(result.status, 'verified'); assert.equal(result.profile.nickname, '张三'); assert.equal(calls.length, 2)
})
