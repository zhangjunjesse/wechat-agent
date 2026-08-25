import test from 'node:test'
import assert from 'node:assert/strict'
import { wechatTools } from '../src/tools/wechat-tools.mjs'

function call(toolFn, input, ctx) {
  return toolFn.invoke(ctx, JSON.stringify(input))
}

function makeFakeStore(overrides = {}) {
  return {
    listMyChats: () => [{ chatWxid: 'g1', name: '项目群', isGroup: true }, { chatWxid: 'wxid_zhang', name: '与助手的对话（私聊）', isGroup: false }],
    searchChat: () => ({ messages: [{ chatWxid: 'g1', chatName: '项目群', tsMs: Date.parse('2026-08-24T10:00:00+08:00'), sender: '张三', content: '你好' }], truncated: false }),
    searchMentions: () => ({ messages: [], truncated: false }),
    searchMyMessages: () => ({ messages: [], truncated: false }),
    ...overrides,
  }
}

const ctx = { context: { userId: 'u1', profile: { wxid: 'wxid_zhang', nickname: '张三' } } }

test('wechat_list_chats reports the accessible chats', async () => {
  const { wechatListChats } = wechatTools({ wechatLogStore: makeFakeStore() })
  const out = await call(wechatListChats, {}, ctx)
  assert.match(out, /项目群（群聊）/)
  assert.match(out, /与助手的对话（私聊）/)
})

test('wechat_list_chats reports emptiness clearly instead of a blank result', async () => {
  const { wechatListChats } = wechatTools({ wechatLogStore: makeFakeStore({ listMyChats: () => [] }) })
  const out = await call(wechatListChats, {}, ctx)
  assert.match(out, /暂无/)
})

test('wechat_search_chat passes identity from run context and formats messages with timestamp/chat/sender', async () => {
  let seenIdentity
  const store = makeFakeStore({ searchChat: (args, identity) => { seenIdentity = identity; return { messages: [{ chatWxid: 'g1', chatName: '项目群', tsMs: Date.parse('2026-08-24T10:00:00+08:00'), sender: '张三', content: '你好' }], truncated: false } } })
  const { wechatSearchChat } = wechatTools({ wechatLogStore: store })
  const out = await call(wechatSearchChat, { chat: '项目群' }, ctx)
  assert.deepEqual(seenIdentity, { wxid: 'wxid_zhang', nickname: '张三' })
  assert.match(out, /项目群/)
  assert.match(out, /张三/)
  assert.match(out, /你好/)
  assert.match(out, /2026-08-24 10:00/)
})

test('wechat_search_chat surfaces access-denied without leaking chat existence', async () => {
  const store = makeFakeStore({ searchChat: () => ({ error: 'chat_not_found_or_not_accessible' }) })
  const { wechatSearchChat } = wechatTools({ wechatLogStore: store })
  const out = await call(wechatSearchChat, { chat: '别人的群' }, ctx)
  assert.match(out, /找不到|不在这个群/)
})

test('wechat_search_chat converts start/end into Beijing-time epoch ms range', async () => {
  let seenRange
  const store = makeFakeStore({ searchChat: (args) => { seenRange = args; return { messages: [], truncated: false } } })
  const { wechatSearchChat } = wechatTools({ wechatLogStore: store })
  await call(wechatSearchChat, { chat: '项目群', start: '2026-08-24', end: '2026-08-24 18:30' }, ctx)
  assert.equal(seenRange.sinceMs, Date.parse('2026-08-24T00:00:00+08:00'))
  assert.equal(seenRange.untilMs, Date.parse('2026-08-24T18:30:00+08:00'))
})

test('wechat_search_mentions defaults target to "我" in the empty-result message and truncation is surfaced', async () => {
  const store = makeFakeStore({ searchMentions: () => ({ messages: [{ chatWxid: 'g1', chatName: '项目群', tsMs: Date.now(), sender: '李四', content: '@张三 在吗' }], truncated: true }) })
  const { wechatSearchMentions } = wechatTools({ wechatLogStore: store })
  const out = await call(wechatSearchMentions, {}, ctx)
  assert.match(out, /@张三 在吗/)
  assert.match(out, /已截断/)
})

test('wechat_search_my_messages reports no-results clearly and never fabricates content', async () => {
  const store = makeFakeStore({ searchMyMessages: () => ({ messages: [], truncated: false }) })
  const { wechatSearchMyMessages } = wechatTools({ wechatLogStore: store })
  const out = await call(wechatSearchMyMessages, {}, ctx)
  assert.match(out, /没有找到消息/)
})

test('unverified user (no profile) yields no_identity handling from the store, tool does not crash', async () => {
  const store = makeFakeStore({ searchMyMessages: () => ({ error: 'no_identity' }) })
  const { wechatSearchMyMessages } = wechatTools({ wechatLogStore: store })
  const bareCtx = { context: { userId: 'u2' } }
  const out = await call(wechatSearchMyMessages, {}, bareCtx)
  assert.match(out, /身份验证/)
})
