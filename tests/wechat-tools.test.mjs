import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { wechatTools } from '../src/tools/wechat-tools.mjs'
import { WechatLogStore } from '../src/services/wechat-log-store.mjs'

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

// ---- ADR-0029: 附件渲染 + wechat_fetch_chat_file ----

const TS = Date.parse('2026-09-16T10:00:30+08:00') // 消息落在 10:00 这一分钟内的第 30 秒

function attMsg(attachment, over = {}) {
  return { chatWxid: 'g1', chatName: '项目群', tsMs: TS, sender: '张三', content: '[图片]', attachment, ...over }
}

test('formatResult renders meaningful attachment descriptions instead of dead placeholders (ADR-0029)', async () => {
  const store = makeFakeStore({
    searchChat: () => ({
      truncated: false,
      messages: [
        attMsg({ kind: 'image', available: true, mediaId: 'cca29ff8e2b515c7bfd7a52a', ext: 'png', size: 61335 }),
        attMsg({ kind: 'file', available: true, mediaId: 'aa00bb11cc22dd33', filename: '季度报表.xlsx', size: 2 * 1024 * 1024 }, { content: '[分享/文件]' }),
        attMsg({ kind: 'file', available: false, filename: '周报.docx', reason: '设备离线' }, { content: '[分享/文件]' }),
        attMsg({ kind: 'link', title: '一篇分享', url: 'https://example.com/a' }, { content: '[分享/文件]' }),
        attMsg({ kind: 'quote', reply: '收到', quotedName: '李四', quotedText: '明早十点开会' }, { content: '[分享/文件]' }),
      ],
    }),
  })
  const { wechatSearchChat } = wechatTools({ wechatLogStore: store })
  const out = await call(wechatSearchChat, { chat: '项目群' }, ctx)
  assert.match(out, /\[图片 png 60KB\]/)
  assert.match(out, /\[文件 季度报表\.xlsx 2\.0MB\]/)
  assert.match(out, /未同步 周报\.docx：设备离线/)
  assert.match(out, /\[链接\] 一篇分享 https:\/\/example\.com\/a/)
  assert.match(out, /收到（引用 李四：明早十点开会）/)
  assert.match(out, /wechat_fetch_chat_file/) // 有可取回附件时提示取回工具
})

test('wechat_fetch_chat_file copies the media file into the caller sandbox inbox/ (ADR-0029)', async () => {
  const tmp = path.join(os.tmpdir(), `wft-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const root = path.join(tmp, 'users')
  const mediaDir = path.join(tmp, 'media')
  fs.mkdirSync(mediaDir, { recursive: true })
  fs.writeFileSync(path.join(mediaDir, 'cca29ff8e2b515c7bfd7a52a.png'), 'png-bytes')
  let seenArgs, seenIdentity
  const store = makeFakeStore({
    searchChat: (args, identity) => {
      seenArgs = args; seenIdentity = identity
      return { truncated: false, messages: [attMsg({ kind: 'image', available: true, mediaId: 'cca29ff8e2b515c7bfd7a52a', ext: 'png', size: 9 })] }
    },
  })
  try {
    const { wechatFetchChatFile } = wechatTools({ wechatLogStore: store, root, mediaDir })
    const out = await call(wechatFetchChatFile, { chat: '项目群', time: '2026-09-16 10:00' }, ctx)
    // 参数走 chat+时间（重新过 accessibleChats 的路径），窗口是这一分钟
    assert.deepEqual(seenIdentity, { wxid: 'wxid_zhang', nickname: '张三' })
    assert.equal(seenArgs.sinceMs, Date.parse('2026-09-16T10:00:00+08:00'))
    assert.equal(seenArgs.untilMs, Date.parse('2026-09-16T10:00:00+08:00') + 59_999)
    assert.match(out, /已取回图片：inbox\//)
    const inbox = fs.readdirSync(path.join(root, 'u1', 'inbox'))
    assert.equal(inbox.length, 1)
    assert.equal(fs.readFileSync(path.join(root, 'u1', 'inbox', inbox[0]), 'utf8'), 'png-bytes')
    // 只读拷贝：源文件仍在
    assert.ok(fs.existsSync(path.join(mediaDir, 'cca29ff8e2b515c7bfd7a52a.png')))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('wechat_fetch_chat_file DENIES cross-tenant access via the real store: user A cannot fetch from user B\'s group (ADR-0029)', async () => {
  const tmp = path.join(os.tmpdir(), `wft-x-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const root = path.join(tmp, 'users')
  const mediaDir = path.join(tmp, 'media')
  const dbFile = path.join(tmp, 'sync.db')
  fs.mkdirSync(mediaDir, { recursive: true })
  fs.writeFileSync(path.join(mediaDir, 'deadbeefdeadbeefdeadbeef.png'), 'secret-bytes')
  const db = new DatabaseSync(dbFile)
  db.exec(`
    CREATE TABLE messages (
      msg_id TEXT PRIMARY KEY, account TEXT, chat_wxid TEXT, chat_display TEXT, is_group INTEGER,
      ts INTEGER, datetime TEXT, sender TEXT, sender_wxid TEXT, sender_display TEXT,
      msg_type INTEGER, content TEXT, attachment TEXT, device TEXT, received_at INTEGER
    );
    CREATE TABLE chat_roster (
      chat_wxid TEXT NOT NULL, chat_name TEXT, member_wxid TEXT NOT NULL,
      member_display TEXT, synced_at INTEGER NOT NULL, PRIMARY KEY (chat_wxid, member_wxid)
    );
  `)
  // 只有李四在「机密群」；附件消息就在这个群里
  db.prepare(`INSERT INTO chat_roster VALUES ('gB@chatroom', '机密群', 'wxid_li', '李四', 1)`).run()
  db.prepare(`INSERT INTO messages (msg_id, chat_wxid, chat_display, is_group, ts, sender_wxid, sender_display, msg_type, content, attachment)
    VALUES ('s1', 'gB@chatroom', '机密群', 1, ?, 'wxid_li', '李四', 3, '', ?)`)
    .run(Math.floor(TS / 1000), JSON.stringify({ kind: 'image', available: true, media_id: 'deadbeefdeadbeefdeadbeef', ext: 'png', size: 12 }))
  db.close()
  try {
    const store = new WechatLogStore({ file: dbFile })
    const { wechatFetchChatFile } = wechatTools({ wechatLogStore: store, root, mediaDir })
    // 张三（不在机密群）：拒绝，且沙箱里没有任何文件落地
    const ctxA = { context: { userId: 'uA', profile: { wxid: 'wxid_zhang', nickname: '张三' } } }
    const denied = await call(wechatFetchChatFile, { chat: '机密群', time: '2026-09-16 10:00' }, ctxA)
    assert.match(denied, /找不到|不在这个群/)
    assert.ok(!fs.existsSync(path.join(root, 'uA')), '越权用户的沙箱不应出现任何取回文件')
    // 李四（真在群里）：同一参数成功取回——证明拦住的是权限，不是功能坏了
    const ctxB = { context: { userId: 'uB', profile: { wxid: 'wxid_li', nickname: '李四' } } }
    const ok = await call(wechatFetchChatFile, { chat: '机密群', time: '2026-09-16 10:00' }, ctxB)
    assert.match(ok, /已取回图片：inbox\//)
    assert.equal(fs.readdirSync(path.join(root, 'uB', 'inbox')).length, 1)
  } finally {
    // store 持有 db 只读句柄，Windows 上删除会 EBUSY——与 wechat-log-store.test 的清理同款容错
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (e) {}
  }
})

test('wechat_fetch_chat_file honestly reports unsynced attachments and passes link urls through (ADR-0029)', async () => {
  const store = makeFakeStore({
    searchChat: () => ({
      truncated: false,
      messages: [
        attMsg({ kind: 'file', available: false, filename: '周报.docx', reason: '设备离线' }),
        attMsg({ kind: 'link', title: '一篇分享', url: 'https://example.com/a' }),
      ],
    }),
  })
  const { wechatFetchChatFile } = wechatTools({ wechatLogStore: store, root: 'unused', mediaDir: 'unused' })
  const out = await call(wechatFetchChatFile, { chat: '项目群', time: '2026-09-16 10:00' }, ctx)
  assert.match(out, /「周报\.docx」还没同步完成，暂时取不到：设备离线/)
  assert.match(out, /\[链接\] 一篇分享 https:\/\/example\.com\/a/)
})

test('wechat_fetch_chat_file rejects malformed time and reports empty windows clearly (ADR-0029)', async () => {
  const store = makeFakeStore({ searchChat: () => ({ truncated: false, messages: [] }) })
  const { wechatFetchChatFile } = wechatTools({ wechatLogStore: store, root: 'unused', mediaDir: 'unused' })
  assert.match(await call(wechatFetchChatFile, { chat: '项目群', time: '昨天' }, ctx), /时间格式不对/)
  assert.match(await call(wechatFetchChatFile, { chat: '项目群', time: '2026-09-16 10:00' }, ctx), /没有找到带附件的消息/)
})

// ---- ADR-0034: thumb（缩略图）字段的诚实提示 ----

test('formatResult marks images that are currently thumbnail-only, so the model does not treat them as full images (ADR-0034)', async () => {
  const store = makeFakeStore({
    searchChat: () => ({
      truncated: false,
      messages: [attMsg({ kind: 'image', available: true, mediaId: 'cca29ff8e2b515c7bfd7a52a', ext: 'png', size: 7986, thumb: true })],
    }),
  })
  const { wechatSearchChat } = wechatTools({ wechatLogStore: store })
  const out = await call(wechatSearchChat, { chat: '项目群' }, ctx)
  assert.match(out, /只有缩略图/)
})

test('wechat_fetch_chat_file warns when the fetched image is still thumbnail-only (ADR-0034)', async () => {
  const tmp = path.join(os.tmpdir(), `wft-thumb-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const root = path.join(tmp, 'users')
  const mediaDir = path.join(tmp, 'media')
  fs.mkdirSync(mediaDir, { recursive: true })
  fs.writeFileSync(path.join(mediaDir, 'cca29ff8e2b515c7bfd7a52a.png'), 'thumb-bytes')
  const store = makeFakeStore({
    searchChat: () => ({
      truncated: false,
      messages: [attMsg({ kind: 'image', available: true, mediaId: 'cca29ff8e2b515c7bfd7a52a', ext: 'png', size: 7986, thumb: true })],
    }),
  })
  try {
    const { wechatFetchChatFile } = wechatTools({ wechatLogStore: store, root, mediaDir })
    const out = await call(wechatFetchChatFile, { chat: '项目群', time: '2026-09-16 10:00' }, ctx)
    assert.match(out, /已取回图片：inbox\//)
    assert.match(out, /只是缩略图/)
    assert.match(out, /image_describe|点开这张图/) // 提示别急着丢给视觉模型，建议先在微信里点开原图
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('wechat_fetch_chat_file stays silent about thumbnails when thumb is false or absent — no regression (ADR-0034)', async () => {
  const tmp = path.join(os.tmpdir(), `wft-nothumb-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const root = path.join(tmp, 'users')
  const mediaDir = path.join(tmp, 'media')
  fs.mkdirSync(mediaDir, { recursive: true })
  fs.writeFileSync(path.join(mediaDir, 'cca29ff8e2b515c7bfd7a52a.png'), 'full-bytes')
  fs.writeFileSync(path.join(mediaDir, 'deadbeefdeadbeefdeadbeef.png'), 'full-bytes-2')
  const store = makeFakeStore({
    searchChat: () => ({
      truncated: false,
      messages: [
        attMsg({ kind: 'image', available: true, mediaId: 'cca29ff8e2b515c7bfd7a52a', ext: 'png', size: 61335, thumb: false }, { content: '[图片1]' }),
        attMsg({ kind: 'image', available: true, mediaId: 'deadbeefdeadbeefdeadbeef', ext: 'png', size: 61335 }, { content: '[图片2]' }),
      ],
    }),
  })
  try {
    const { wechatFetchChatFile } = wechatTools({ wechatLogStore: store, root, mediaDir })
    const out = await call(wechatFetchChatFile, { chat: '项目群', time: '2026-09-16 10:00' }, ctx)
    const lines = out.split('\n')
    assert.equal(lines.length, 2)
    for (const line of lines) {
      assert.match(line, /^已取回图片：inbox\/[^（]+（[^）]+）$/) // 没有额外的缩略图警告尾巴
      assert.doesNotMatch(line, /缩略图/)
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
