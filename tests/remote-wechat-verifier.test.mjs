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

// ---- ADR-0032: reverse-lookup wxid from the chat the code was actually
// found in, for the (real production) case where the message row's own
// sender_wxid comes back empty from the sync API ----

test('ADR-0032: falls back to the matched candidate chat\'s own chat_wxid when sender_wxid is empty', async () => {
  const now = 1_800_000_000_000
  // No chat literally named/remarked "助手" has the code (its own messages
  // list is empty); the real code lives in the user's own 1:1 thread, found
  // via the "search every other chat" fallback — and that message row's
  // sender_wxid is empty, mirroring the real production data this ADR fixes.
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => {
      if (url.includes('/chats')) {
        return { chats: [{ chat_wxid: 'wxid-assistant', chat_display: '助手' }, { chat_wxid: 'zj391504704', chat_display: 'Z.俊' }] }
      }
      if (url.includes('chat=wxid-assistant')) return { messages: [] }
      if (url.includes('chat=zj391504704')) return { messages: [{ sender_wxid: '', sender_display: 'Z.俊', content: 'WA-ABCDEF12', ts: 1_800_000_000 }] }
      throw new Error(`unexpected url: ${url}`)
    },
  })
  const verifier = new RemoteWechatVerifier({ baseUrl: 'https://sync.example', accessKey: 'key', now: () => now, fetchImpl })
  const task = verifier.createTask({ ilinkUserId: 'peer@im.wechat' }); task.code = 'WA-ABCDEF12'
  const result = await verifier.checkTask(task)
  assert.equal(result.status, 'verified')
  assert.equal(result.profile.nickname, 'Z.俊')
  assert.equal(result.profile.wxid, 'zj391504704')
})

test('ADR-0032: the shared "助手" chat\'s own chat_wxid is never used as a wxid fallback', async () => {
  const now = 1_800_000_000_000
  // The code is found directly in the "助手"-named chat itself (first lookup,
  // no fallback loop). That chat is shared across every verification, not
  // per-user — using its chat_wxid as "the user's wxid" would collapse every
  // verification onto the same fake identity. Correct behavior: sender_wxid
  // stays empty (honest "we don't know"), not silently wrong.
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => url.includes('/chats')
      ? { chats: [{ chat_wxid: 'wxid-assistant', chat_display: '助手' }] }
      : { messages: [{ sender_wxid: '', sender_display: '张三', content: 'WA-ABCDEF12', ts: 1_800_000_000 }] },
  })
  const verifier = new RemoteWechatVerifier({ baseUrl: 'https://sync.example', accessKey: 'key', now: () => now, fetchImpl })
  const task = verifier.createTask({ ilinkUserId: 'peer@im.wechat' }); task.code = 'WA-ABCDEF12'
  const result = await verifier.checkTask(task)
  assert.equal(result.status, 'verified')
  assert.equal(result.profile.wxid, '')
})
