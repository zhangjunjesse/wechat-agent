import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { GroupCommandWatcher } from '../src/services/group-command-watcher.mjs'

function makeDb(rows) {
  const file = path.join(os.tmpdir(), `gcmd-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE messages (
      msg_id TEXT PRIMARY KEY, account TEXT, chat_wxid TEXT, chat_display TEXT, is_group INTEGER,
      ts INTEGER, datetime TEXT, sender TEXT, sender_wxid TEXT, sender_display TEXT,
      msg_type INTEGER, content TEXT, attachment TEXT, device TEXT, received_at INTEGER
    );
  `)
  const ins = db.prepare('INSERT INTO messages (msg_id, chat_wxid, chat_display, is_group, ts, sender_wxid, sender_display, msg_type, content, attachment) VALUES (?,?,?,?,?,?,?,?,?,?)')
  for (const r of rows) ins.run(r.msg_id, r.chat_wxid, r.chat_display || r.chat_wxid, 1, r.ts, r.sender_wxid || '', r.sender_display || '', r.msg_type || 1, r.content || '', r.attachment || '')
  db.close()
  return file
}

function setup({ rows, profiles = [{ userId: 'u1', nickname: 'Z.俊', wxid: 'wx_zj', ilinkUserId: 'ilink_zj' }], agentDelay = 0 } = {}) {
  const dbFile = makeDb(rows)
  const cursorFile = path.join(os.tmpdir(), `gcmd-cur-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  const calls = []
  const sent = []
  const agent = {
    respond: async (args) => {
      calls.push(args)
      if (agentDelay) await new Promise((r) => setTimeout(r, agentDelay))
      return { text: `已处理：${(args.text.match(/指令：(.+)/) || [])[1] || ''}` }
    },
  }
  const provider = { sendText: async (a) => { sent.push(a); return {} } }
  const profileStore = {
    list: async () => profiles,
    get: async (id) => profiles.find((p) => p.userId === id) || null,
  }
  const contextTokens = {
    get: (ilinkId) => (ilinkId === 'ilink_zj' ? { contextToken: 'tok-zj', providerBotId: 'bot-zj' } : null),
  }
  const watcher = new GroupCommandWatcher({ dbFile, agent, provider, profileStore, contextTokens, cursorFile, initialCursor: 0, progress: { ackDelayMs: 5, intervalMs: 10_000 } })
  return { dbFile, cursorFile, watcher, calls, sent }
}

const QUOTE_ATTACHMENT = JSON.stringify({ kind: 'quote', reply: '@助手 看一下', quoted_name: 'Z.俊', quoted_text: 'https://xingetech.feishu.cn/docx/JclldYOGMooflZxaEiYcfBeLngc?from=from_copylink' })

test('watcher turns a group @助手 quote into an agent call and a private push', async () => {
  const { cursorFile, watcher, calls, sent } = setup({
    agentDelay: 60, // 模拟长任务：ack（10ms）应在此期间发出
    rows: [{ msg_id: 'm1', chat_wxid: '53512663852@chatroom', chat_display: 'Agent安全测试群', ts: 1789471204, sender_display: 'Z.俊', content: '@助手\u2005看一下', attachment: QUOTE_ATTACHMENT }],
  })
  try {
    await watcher.sweep()
    assert.equal(calls.length, 1)
    const text = calls[0].text
    assert.match(text, /Agent安全测试群/)
    assert.match(text, /📌 引用的消息内容/)
    assert.match(text, /feishu\.cn\/docx\/JclldYOGMooflZxaEiYcfBeLngc/)
    assert.match(text, /指令：看一下/)
    assert.match(text, /wechat_search_chat/)
    // 身份与私聊通道：会话键 = ilinkUserId（与私聊一致），不是浏览器档案 id
    assert.equal(calls[0].userId, 'ilink_zj')
    assert.equal(calls[0].channel.toProviderUserId, 'ilink_zj')
    // 长任务体验：ack（延迟 5ms 触发）+ 结果，两条都发给该用户
    const waitFor = async (fn, ms = 500) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)) } return false }
    await waitFor(() => sent.length >= 2)
    assert.ok(sent.length >= 2, `expected ack + result, got ${sent.length}`)
    assert.match(sent[0].text, /收到，正在处理/)
    assert.equal(sent[0].toProviderUserId, 'ilink_zj')
    assert.match(sent[sent.length - 1].text, /已处理：看一下/)
    // 第二轮 sweep 不重复（msg_id 去重 + 游标推进）
    await watcher.sweep()
    assert.equal(calls.length, 1)
  } finally {
    fs.rmSync(cursorFile, { force: true })
  }
})

test('watcher ignores non-verified senders and non-@助手 messages', async () => {
  const { cursorFile, watcher, calls, sent } = setup({
    rows: [
      { msg_id: 'm1', chat_wxid: 'g1@chatroom', ts: 100, sender_display: '陌生人', content: '@助手 在吗' },
      { msg_id: 'm2', chat_wxid: 'g1@chatroom', ts: 200, sender_display: 'Z.俊', content: '普通消息不带@' },
    ],
  })
  try {
    await watcher.sweep()
    assert.equal(calls.length, 0)
    assert.equal(sent.length, 0)
  } finally {
    fs.rmSync(cursorFile, { force: true })
  }
})

test('watcher skips users without a private-channel token (no push possible)', async () => {
  const { cursorFile, watcher, calls } = setup({
    rows: [{ msg_id: 'm1', chat_wxid: 'g1@chatroom', ts: 100, sender_display: 'Z.俊', content: '@助手 处理下', attachment: QUOTE_ATTACHMENT }],
    profiles: [{ userId: 'u2', nickname: 'Z.俊', wxid: 'wx_zj', ilinkUserId: 'ilink_other' }], // ilink_other 无 token
  })
  try {
    await watcher.sweep()
    assert.equal(calls.length, 0) // 无 token 跳过，不调 agent
  } finally {
    fs.rmSync(cursorFile, { force: true })
  }
})

test('watcher picks the matching profile that has a push channel, skipping tokenless duplicates', async () => {
  const { cursorFile, watcher, calls, sent } = setup({
    agentDelay: 60,
    rows: [{ msg_id: 'm1', chat_wxid: 'g1@chatroom', chat_display: '测试群', ts: 100, sender_display: 'Z.俊', content: '@助手 读一下', attachment: QUOTE_ATTACHMENT }],
    // 第一个同名档案无 token（test-user 式残留），第二个有 token —— 应选第二个
    profiles: [
      { userId: 'test-user', nickname: 'Z.俊', wxid: 'wx_zj', ilinkUserId: 'ilink_none' },
      { userId: 'u-real', nickname: 'Z.俊', wxid: 'wx_zj', ilinkUserId: 'ilink_zj' },
    ],
  })
  try {
    await watcher.sweep()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].userId, 'ilink_zj') // 会话键 = 稳定 ilinkUserId（与私聊一致）
    assert.equal(calls[0].channel.toProviderUserId, 'ilink_zj')
    const t0 = Date.now()
    while (Date.now() - t0 < 500 && sent.length < 2) await new Promise((r) => setTimeout(r, 10))
    assert.ok(sent.length >= 2, `expected ack + result, got ${sent.length}`)
    assert.match(sent[0].text, /收到，正在处理/)
  } finally {
    fs.rmSync(cursorFile, { force: true })
  }
})

test('watcher surfaces media attachments in the prompt with a fetch hint, without touching quote behavior (ADR-0029)', async () => {
  const IMG_ATTACHMENT = JSON.stringify({ kind: 'image', available: true, media_id: 'cca29ff8e2b515c7bfd7a52a', ext: 'png', size: 61335 })
  const { cursorFile, watcher, calls } = setup({
    rows: [{ msg_id: 'm1', chat_wxid: 'g1@chatroom', chat_display: '测试群', ts: 1789471204, sender_display: 'Z.俊', content: '@助手 这张图看一下', attachment: IMG_ATTACHMENT }],
  })
  try {
    await watcher.sweep()
    assert.equal(calls.length, 1)
    const text = calls[0].text
    assert.match(text, /图片附件/)
    assert.match(text, /wechat_fetch_chat_file/)
    assert.match(text, /chat=「测试群」/)
    assert.match(text, /time=\d{4}-\d{2}-\d{2} \d{2}:\d{2}/) // 北京时间戳，可直接照抄给取回工具
    assert.doesNotMatch(text, /📌 引用的消息内容/) // 非 quote：不触发引用段
  } finally {
    fs.rmSync(cursorFile, { force: true })
  }
})

test('watcher reports unsynced attachments honestly and passes link shares through (ADR-0029)', async () => {
  const FILE_UNSYNCED = JSON.stringify({ kind: 'file', available: false, filename: '周报.docx', reason: '设备离线' })
  const LINK_ATTACHMENT = JSON.stringify({ kind: 'link', title: '一篇分享', url: 'https://example.com/a' })
  const { cursorFile, watcher, calls } = setup({
    rows: [
      { msg_id: 'm1', chat_wxid: 'g1@chatroom', chat_display: '测试群', ts: 100, sender_display: 'Z.俊', content: '@助手 发我一下', attachment: FILE_UNSYNCED },
      { msg_id: 'm2', chat_wxid: 'g1@chatroom', chat_display: '测试群', ts: 200, sender_display: 'Z.俊', content: '@助手 读一下这篇', attachment: LINK_ATTACHMENT },
    ],
  })
  try {
    await watcher.sweep()
    assert.equal(calls.length, 2)
    assert.match(calls[0].text, /「周报\.docx」/)
    assert.match(calls[0].text, /还没同步完成，暂时取不到（设备离线）/)
    assert.match(calls[1].text, /分享链接：一篇分享 https:\/\/example\.com\/a/)
  } finally {
    fs.rmSync(cursorFile, { force: true })
  }
})

// ---- ADR-0032: tiered wxid/nickname sender identification, not OR'd ----
// Same root cause as accessibleChats: nickname isn't unique across verified
// profiles. Here the stakes are actually higher than read-access — a wrong
// match doesn't just show the wrong group, it PUSHES the agent's reply
// (which can include private content, e.g. a fetched Feishu doc) to the
// wrong person's private chat.

test('ADR-0032: wxid match is authoritative — wrong-wxid same-nickname profile is never even considered', async () => {
  const dbFile = makeDb([{ msg_id: 'm1', chat_wxid: 'g1@chatroom', chat_display: '测试群', ts: 100, sender_wxid: 'wx_real_a', sender_display: 'Z.俊', content: '@助手 读一下', attachment: QUOTE_ATTACHMENT }])
  const cursorFile = path.join(os.tmpdir(), `gcmd-cur-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  const calls = []
  const agent = { respond: async (args) => { calls.push(args); return { text: 'ok' } } }
  const provider = { sendText: async () => ({}) }
  const profiles = [
    { userId: 'u-b', nickname: 'Z.俊', wxid: 'wx_real_b', ilinkUserId: 'ilink_b' }, // 同名但 wxid 不对，排第一且有 token
    { userId: 'u-a', nickname: 'Z.俊', wxid: 'wx_real_a', ilinkUserId: 'ilink_a' }, // 真正发消息的人
  ]
  const profileStore = { list: async () => profiles, get: async (id) => profiles.find((p) => p.userId === id) || null }
  const contextTokens = { get: (id) => (id === 'ilink_a' ? { contextToken: 'tok-a', providerBotId: 'bot' } : id === 'ilink_b' ? { contextToken: 'tok-b', providerBotId: 'bot' } : null) }
  const watcher = new GroupCommandWatcher({ dbFile, agent, provider, profileStore, contextTokens, cursorFile, initialCursor: 0, progress: { ackDelayMs: 5, intervalMs: 10_000 } })
  try {
    await watcher.sweep()
    assert.equal(calls.length, 1)
    // 必须投给真正发消息的 u-a（ilink_a），不是排第一、同名但 wxid 不对的 u-b
    assert.equal(calls[0].userId, 'ilink_a')
    assert.equal(calls[0].channel.toProviderUserId, 'ilink_a')
  } finally {
    fs.rmSync(cursorFile, { force: true })
  }
})

test('ADR-0032: sender_wxid empty + nickname ambiguous across ≥2 distinct wxids → refuses rather than guessing', async () => {
  const { cursorFile, watcher, calls } = setup({
    rows: [{ msg_id: 'm1', chat_wxid: 'g1@chatroom', chat_display: '测试群', ts: 100, sender_display: 'Z.俊', content: '@助手 读一下', attachment: QUOTE_ATTACHMENT }], // 无 sender_wxid
    profiles: [
      { userId: 'u-a', nickname: 'Z.俊', wxid: 'wx_real_a', ilinkUserId: 'ilink_zj' }, // 有 token（复用 setup 默认认可的 ilink_zj）
      { userId: 'u-b', nickname: 'Z.俊', wxid: 'wx_real_b', ilinkUserId: 'ilink_other' },
    ],
  })
  try {
    await watcher.sweep()
    // 旧逻辑：昵称 OR 匹配到两个，挑第一个有 token 的（u-a）就会投出去——
    // 但我们其实不知道这条群消息到底是谁发的（sender_wxid 缺失），不能猜。
    assert.equal(calls.length, 0)
  } finally {
    fs.rmSync(cursorFile, { force: true })
  }
})

test('ADR-0032: sender_wxid empty + nickname unique still works exactly as before (no regression on the common case)', async () => {
  const { cursorFile, watcher, calls } = setup({
    rows: [{ msg_id: 'm1', chat_wxid: 'g1@chatroom', chat_display: '测试群', ts: 100, sender_display: 'Z.俊', content: '@助手 读一下', attachment: QUOTE_ATTACHMENT }],
  })
  try {
    await watcher.sweep()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].userId, 'ilink_zj')
  } finally {
    fs.rmSync(cursorFile, { force: true })
  }
})

test('cursor persists so restarts do not reprocess', async () => {
  const { dbFile, cursorFile, watcher, calls } = setup({
    rows: [{ msg_id: 'm1', chat_wxid: 'g1@chatroom', ts: 500, sender_display: 'Z.俊', content: '@助手 你好', attachment: QUOTE_ATTACHMENT }],
  })
  try {
    await watcher.sweep()
    assert.equal(calls.length, 1)
    watcher.stop() // 落盘游标
    const saved = JSON.parse(fs.readFileSync(cursorFile, 'utf8'))
    assert.equal(saved.ts, 500)
    // 重建 watcher（同游标文件）→ 不再处理旧消息
    const agent2 = { respond: async () => { calls.push('again'); return { text: 'x' } } }
    const watcher2 = new GroupCommandWatcher({ dbFile, agent: agent2, provider: { sendText: async () => ({}) }, profileStore: { list: async () => [{ userId: 'u1', nickname: 'Z.俊' }], get: async () => ({}) }, contextTokens: { get: () => ({ contextToken: 't', providerBotId: 'b' }) }, cursorFile })
    await watcher2.sweep()
    assert.equal(calls.length, 1) // 未新增处理
  } finally {
    fs.rmSync(cursorFile, { force: true })
  }
})
