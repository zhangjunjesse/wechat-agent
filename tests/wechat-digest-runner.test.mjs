import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { WechatLogStore } from '../src/services/wechat-log-store.mjs'
import { GroupProfileStore } from '../src/services/group-profile-store.mjs'
import { ReportStore } from '../src/services/report-store.mjs'
import { WechatDigestRunner } from '../src/services/wechat-digest-runner.mjs'

// 北京时间 2026-09-16 21:30（daily@21:30 的触发点）
const NOW = Date.UTC(2026, 8, 16, 13, 30)
const HOUR = 3600_000
const DAY = 24 * HOUR

/** 与 wechat-chatlog-dsh 的 receiver.py SCHEMA 一致（同 wechat-log-store.test.mjs）。 */
function seedChatDb(file) {
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE messages (
      msg_id TEXT PRIMARY KEY, account TEXT, chat_wxid TEXT, chat_display TEXT,
      is_group INTEGER, ts INTEGER, datetime TEXT, sender TEXT, sender_wxid TEXT,
      sender_display TEXT, msg_type INTEGER, content TEXT, attachment TEXT,
      device TEXT, received_at INTEGER
    );
    CREATE TABLE chat_roster (
      chat_wxid TEXT NOT NULL, chat_name TEXT, member_wxid TEXT NOT NULL,
      member_display TEXT, synced_at INTEGER NOT NULL,
      PRIMARY KEY (chat_wxid, member_wxid)
    );
  `)
  const roster = (chat, name, wxid, display) =>
    db.prepare('INSERT INTO chat_roster (chat_wxid, chat_name, member_wxid, member_display, synced_at) VALUES (?,?,?,?,?)').run(chat, name, wxid, display, 1)
  const msg = (id, chat, display, isGroup, tsMs, senderWxid, senderDisplay, content) =>
    db.prepare(`INSERT INTO messages (msg_id, account, chat_wxid, chat_display, is_group, ts, datetime, sender, sender_wxid, sender_display, msg_type, content, attachment, device, received_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, 'acc', chat, display, isGroup ? 1 : 0, Math.floor(tsMs / 1000), '', senderWxid, senderWxid, senderDisplay, 1, content, null, 'dev', 1)

  // 张三在「项目群」和「家人群」；「别人的群」他不在（权限边界的反例）
  roster('g1@chatroom', '项目群', 'wxid_zhang', '张三')
  roster('g1@chatroom', '项目群', 'wxid_li', '李四')
  roster('g2@chatroom', '家人群', 'wxid_zhang', '张三')
  roster('g3@chatroom', '别人的群', 'wxid_li', '李四')
  // 「沉寂群」张三在，但本周期内没有消息（活跃度过滤的反例）
  roster('g4@chatroom', '沉寂群', 'wxid_zhang', '张三')

  msg('m1', 'g1@chatroom', '项目群', true, NOW - 3 * HOUR, 'wxid_li', '李四', '@张三 接口方案明天前给个答复')
  msg('m2', 'g2@chatroom', '家人群', true, NOW - 5 * HOUR, 'wxid_ma', '妈', '周六上午带爸去复查')
  msg('m3', 'g3@chatroom', '别人的群', true, NOW - 2 * HOUR, 'wxid_li', '李四', '机密内容不该出现在张三的日报里')
  msg('m4', 'g4@chatroom', '沉寂群', true, NOW - 30 * DAY, 'wxid_li', '李四', '很久以前的消息')
  // 张三与助手的 1:1（chat_wxid === 自己的 wxid）——digest 刻意排除
  msg('m5', 'wxid_zhang', '张三', false, NOW - HOUR, 'wxid_zhang', '张三', '帮我查天气')
  // 只在 7 天窗口内的消息（周报 vs 日报的取数差异）
  msg('m6', 'g1@chatroom', '项目群', true, NOW - 4 * DAY, 'wxid_li', '李四', '四天前的排期讨论')
  db.close()
}

const REDUCE_OK = JSON.stringify({
  focus: '今天主要是项目群和家人群',
  action_items: [{ title: '给李四回复接口方案', summary: '他等你的答复', source: '项目群', at: '2026-09-16 18:30' }],
  work_updates: [{ title: '周六带爸复查', summary: '上午', source: '家人群', at: '2026-09-16 16:30' }],
  fun: [],
})

const MAP_OK = JSON.stringify({ candidates: [{ section: 'action_items', title: '有事要办', detail: 'd', sender: '李四', at: '2026-09-16 18:30' }] })
const TAG_OK = JSON.stringify({ groups: [{ chatWxid: 'g1@chatroom', tag: 'work', confidence: 0.9 }, { chatWxid: 'g2@chatroom', tag: 'family', confidence: 0.8 }] })

/** mock agent：按 prompt 里的特征词路由到打标/map/reduce 三种回复，并记录每次调用。 */
function makeAgent({ reduce = REDUCE_OK, map = MAP_OK, tag = TAG_OK, fail = null } = {}) {
  const calls = []
  return {
    calls,
    respond: async (args) => {
      const kind = args.text.includes('性质分类') ? 'tag' : args.text.includes('合并规则') ? 'reduce' : 'map'
      calls.push({ kind, userId: args.userId, text: args.text, ephemeral: args.ephemeral })
      if (fail?.[kind]) throw new Error(fail[kind])
      return { text: kind === 'tag' ? tag : kind === 'reduce' ? reduce : map }
    },
  }
}

function setup({ agentOpts = {}, agent: agentOverride = null, memoryStore = null, posterRender = null, unparsableRetries = 2 } = {}) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const chatFile = path.join(os.tmpdir(), `dg-chat-${stamp}.db`)
  const gpFile = path.join(os.tmpdir(), `dg-gp-${stamp}.db`)
  const rpFile = path.join(os.tmpdir(), `dg-rp-${stamp}.db`)
  seedChatDb(chatFile)
  const wechatLogStore = new WechatLogStore({ file: chatFile })
  const groupProfiles = new GroupProfileStore({ file: gpFile })
  const reportStore = new ReportStore({ file: rpFile })
  const agent = agentOverride || makeAgent(agentOpts)
  const runner = new WechatDigestRunner({ agent, wechatLogStore, groupProfiles, memoryStore, reportStore, posterRender, unparsableRetries })
  const cleanup = () => {
    wechatLogStore.close(); groupProfiles.close(); reportStore.close()
    for (const f of [chatFile, gpFile, rpFile]) fs.rmSync(f, { force: true })
  }
  return { runner, agent, groupProfiles, reportStore, cleanup }
}

const TASK = { id: 'global-微信日报', name: '微信日报', schedule: 'daily@21:30', instruction: '只捞和我有关的' }
const WEEKLY_TASK = { id: 'global-微信周报', name: '微信周报', schedule: 'weekly@7@20:00', instruction: '回顾这一周' }
const ZHANG = { nickname: '张三', wxid: 'wxid_zhang' }

test('the digest pipeline runs map per active group, reduces once, and stores a digest report', async (t) => {
  const { runner, agent, reportStore, cleanup } = setup()
  t.after(cleanup)

  const r = await runner.generate({ task: TASK, userId: 'ilink-zhang', profile: ZHANG, now: NOW })
  assert.equal(r.ok, true)
  assert.equal(r.empty, false)

  // 一次打标 + 每个活跃群一次 map + 一次 reduce
  assert.equal(agent.calls.filter((c) => c.kind === 'tag').length, 1)
  assert.equal(agent.calls.filter((c) => c.kind === 'map').length, 2) // 项目群 + 家人群
  assert.equal(agent.calls.filter((c) => c.kind === 'reduce').length, 1)
  // 全部走 ephemeral 合成用户，绝不污染真实会话/记忆
  assert.ok(agent.calls.every((c) => c.ephemeral === true))
  assert.ok(agent.calls.every((c) => c.userId.startsWith('task-') && c.userId.includes('ilink-zhang')))

  // 入库：kind 与三节归属
  const stored = reportStore.getReport(r.report.id)
  assert.equal(stored.kind, 'wechat-digest')
  assert.equal(stored.userId, 'ilink-zhang')
  assert.equal(stored.focus, '今天主要是项目群和家人群')
  assert.deepEqual(stored.items.map((i) => i.section), ['action_items', 'work_updates'])
  // 溯源串
  assert.equal(stored.items[0].source, '来自 项目群 · 09-16 18:30')
  assert.equal(stored.items[0].title, '给李四回复接口方案')
})

test('permission boundary: only chats the user actually belongs to are ever read', async (t) => {
  const { runner, agent, cleanup } = setup()
  t.after(cleanup)
  await runner.generate({ task: TASK, userId: 'ilink-zhang', profile: ZHANG, now: NOW })

  const allPrompts = agent.calls.map((c) => c.text).join('\n')
  // 张三不在「别人的群」——它的名字和内容都不能出现在任何一次 prompt 里
  assert.doesNotMatch(allPrompts, /别人的群/)
  assert.doesNotMatch(allPrompts, /机密内容/)
  // 与助手的 1:1 也不进 digest（那不是"读不完的群"）
  assert.doesNotMatch(allPrompts, /帮我查天气/)
  // 本周期没有消息的群不花 LLM 调用
  assert.doesNotMatch(allPrompts, /沉寂群/)
  // 他自己在的群则确实被读到了
  assert.match(allPrompts, /接口方案明天前给个答复/)
  assert.match(allPrompts, /周六上午带爸去复查/)
})

test('auto tagging writes source=auto and drives the per-group extraction focus', async (t) => {
  const { runner, agent, groupProfiles, cleanup } = setup()
  t.after(cleanup)
  await runner.generate({ task: TASK, userId: 'u-zhang', profile: ZHANG, now: NOW })

  assert.equal(groupProfiles.get('u-zhang', 'g1@chatroom').tag, 'work')
  assert.equal(groupProfiles.get('u-zhang', 'g1@chatroom').source, 'auto')
  assert.equal(groupProfiles.get('u-zhang', 'g1@chatroom').chatName, '项目群')
  assert.equal(groupProfiles.get('u-zhang', 'g2@chatroom').tag, 'family')

  const maps = agent.calls.filter((c) => c.kind === 'map')
  const work = maps.find((c) => c.text.includes('项目群'))
  const family = maps.find((c) => c.text.includes('家人群'))
  assert.match(work.text, /deadline/)      // work 的侧重
  assert.match(family.text, /就医/)         // family 的侧重
  assert.doesNotMatch(family.text, /deadline/)
})

test('a user-set tag survives a later digest run, and dead groups are skipped entirely', async (t) => {
  const { runner, agent, groupProfiles, cleanup } = setup()
  t.after(cleanup)
  // 用户先把项目群标成死群
  groupProfiles.put({ userId: 'u-zhang', chatWxid: 'g1@chatroom', chatName: '项目群', tag: 'dead', source: 'user' })
  await runner.generate({ task: TASK, userId: 'u-zhang', profile: ZHANG, now: NOW })

  // 自动打标只会去动还没有画像的群（这里只剩家人群），不会覆盖用户的设定
  assert.equal(groupProfiles.get('u-zhang', 'g1@chatroom').tag, 'dead')
  assert.equal(groupProfiles.get('u-zhang', 'g1@chatroom').source, 'user')
  // 死群不调 LLM
  const maps = agent.calls.filter((c) => c.kind === 'map')
  assert.equal(maps.length, 1)
  assert.match(maps[0].text, /家人群/)
})

test('weekly digests widen the window to 7 days and ask for a trend comparison', async (t) => {
  const { runner, agent, reportStore, cleanup } = setup()
  t.after(cleanup)
  // 上一期的历史（供趋势对比注入）
  reportStore.saveReport({ taskId: WEEKLY_TASK.id, name: '微信周报', runAt: NOW - 7 * DAY, userId: 'u-zhang', kind: 'wechat-digest', items: [{ title: '上周的排期讨论', section: 'work_updates' }] })

  await runner.generate({ task: WEEKLY_TASK, userId: 'u-zhang', profile: ZHANG, now: NOW })
  const maps = agent.calls.filter((c) => c.kind === 'map')
  const projectMap = maps.find((c) => c.text.includes('项目群'))
  // 4 天前的消息只有在 7 天窗口里才看得到（日报的 1 天窗口看不到）
  assert.match(projectMap.text, /四天前的排期讨论/)
  assert.match(projectMap.text, /过去 7 天/)

  const reduce = agent.calls.find((c) => c.kind === 'reduce')
  assert.match(reduce.text, /上周的排期讨论/)
  assert.match(reduce.text, /趋势对比/)
})

test('daily digests do NOT see messages older than one day', async (t) => {
  const { runner, agent, cleanup } = setup()
  t.after(cleanup)
  await runner.generate({ task: TASK, userId: 'u-zhang', profile: ZHANG, now: NOW })
  const projectMap = agent.calls.filter((c) => c.kind === 'map').find((c) => c.text.includes('项目群'))
  assert.match(projectMap.text, /接口方案明天前给个答复/) // 3 小时前，在窗口内
  assert.doesNotMatch(projectMap.text, /四天前的排期讨论/) // 4 天前，在窗口外
})

test('memory profile and preferences are injected into reduce as hard constraints', async (t) => {
  const memoryStore = {
    getProfile: () => ({ content: '常年做后端，关注架构' }),
    listCategory: (_u, cat) => (cat === 'preference' ? [{ content: '别再给我推摄影群的图片刷屏' }] : []),
  }
  const { runner, agent, cleanup } = setup({ memoryStore })
  t.after(cleanup)
  await runner.generate({ task: TASK, userId: 'u-zhang', profile: ZHANG, now: NOW })
  const reduce = agent.calls.find((c) => c.kind === 'reduce')
  assert.match(reduce.text, /常年做后端/)
  assert.match(reduce.text, /别再给我推摄影群的图片刷屏/)
  assert.match(reduce.text, /必须遵守/)
})

test('an empty result is reported as empty (not as a failure) and costs no reduce call', async (t) => {
  // 每个群都抽不出候选 → 连 reduce 都不该调
  const { runner, agent, cleanup } = setup({ agentOpts: { map: '{"candidates":[]}' } })
  t.after(cleanup)
  const r = await runner.generate({ task: TASK, userId: 'u-zhang', profile: ZHANG, now: NOW })
  assert.deepEqual({ ok: r.ok, empty: r.empty, report: r.report }, { ok: true, empty: true, report: null })
  assert.equal(agent.calls.filter((c) => c.kind === 'reduce').length, 0)
})

test('a reduce that legitimately returns three empty sections is also "empty", not a failure', async (t) => {
  const { runner, cleanup } = setup({ agentOpts: { reduce: '{"focus":"","action_items":[],"work_updates":[],"fun":[]}' } })
  t.after(cleanup)
  const r = await runner.generate({ task: TASK, userId: 'u-zhang', profile: ZHANG, now: NOW })
  assert.equal(r.ok, true)
  assert.equal(r.empty, true)
})

test('ADR-0032: an identity with no wxid whose nickname is ambiguous (chat_roster has >1 distinct member_wxid for it) gets a normal empty result, not an error, and burns zero LLM calls', async (t) => {
  // 生产实测：已核验用户的 wxid 常年是空字符串，且真的有 4 个不同用户共享同一个
  // 昵称"Z.俊"。在这条降级路径上，WechatLogStore.accessibleChats 现在会拒绝
  // 返回（宁可这个用户看不到群，也不能把另一个同名人的群塞给他，见 ADR-0032）。
  // digest 管道消费的是 accessibleChats 的返回值，天然继承这个"拒绝"——这里钉死
  // 它落地为管道已有的"没有可读的群" empty 路径，而不是一个新的错误分支：
  // 对订阅者来说，"我的群昵称撞车了" 和 "我确实不在任何群里" 都应该是同一种
  // 静默、不打扰的结果，不该让用户看到一条自己无法理解/无法处理的错误。
  // 真正的可观测性在 WechatLogStore 层（onAmbiguousNickname 回调 + 默认
  // console.error），不需要在 digest 管道再重复一份。
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const chatFile = path.join(os.tmpdir(), `dg-amb-${stamp}.db`)
  const gpFile = path.join(os.tmpdir(), `dg-amb-gp-${stamp}.db`)
  const rpFile = path.join(os.tmpdir(), `dg-amb-rp-${stamp}.db`)
  const db = new DatabaseSync(chatFile)
  db.exec(`
    CREATE TABLE messages (
      msg_id TEXT PRIMARY KEY, account TEXT, chat_wxid TEXT, chat_display TEXT,
      is_group INTEGER, ts INTEGER, datetime TEXT, sender TEXT, sender_wxid TEXT,
      sender_display TEXT, msg_type INTEGER, content TEXT, attachment TEXT,
      device TEXT, received_at INTEGER
    );
    CREATE TABLE chat_roster (
      chat_wxid TEXT NOT NULL, chat_name TEXT, member_wxid TEXT NOT NULL,
      member_display TEXT, synced_at INTEGER NOT NULL,
      PRIMARY KEY (chat_wxid, member_wxid)
    );
  `)
  // 两个不同的真实人，昵称都是"Z.俊"，分别在不同的群里。
  db.prepare('INSERT INTO chat_roster (chat_wxid, chat_name, member_wxid, member_display, synced_at) VALUES (?,?,?,?,?)').run('g1@chatroom', '项目群', 'zj391504704', 'Z.俊', 1)
  db.prepare('INSERT INTO chat_roster (chat_wxid, chat_name, member_wxid, member_display, synced_at) VALUES (?,?,?,?,?)').run('g9@chatroom', '别人的群', 'wxid_impostor', 'Z.俊', 1)
  db.close()

  const wechatLogStore = new WechatLogStore({ file: chatFile })
  const groupProfiles = new GroupProfileStore({ file: gpFile })
  const reportStore = new ReportStore({ file: rpFile })
  const agent = makeAgent()
  const runner = new WechatDigestRunner({ agent, wechatLogStore, groupProfiles, reportStore })
  t.after(() => {
    wechatLogStore.close(); groupProfiles.close(); reportStore.close()
    for (const f of [chatFile, gpFile, rpFile]) fs.rmSync(f, { force: true })
  })

  const r = await runner.generate({ task: TASK, userId: 'u-tongming', profile: { nickname: 'Z.俊', wxid: '' }, now: NOW })
  assert.deepEqual({ ok: r.ok, empty: r.empty, report: r.report }, { ok: true, empty: true, report: null })
  assert.equal(agent.calls.length, 0) // 权限边界在第一步就拒绝了，没有任何 LLM 调用
})

test('an unparsable reduce is a real failure (retryable); a failing single group is not', async (t) => {
  const bad = setup({ agentOpts: { reduce: '模型今天罢工了' } })
  t.after(bad.cleanup)
  const r = await bad.runner.generate({ task: TASK, userId: 'u-zhang', profile: ZHANG, now: NOW })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'digest_unparsable')
  assert.equal(r.rawText, '模型今天罢工了')

  // map 整体抛错 → 没有候选 → 判空，而不是整期失败
  const mapFail = setup({ agentOpts: { fail: { map: 'LLM 402' } } })
  t.after(mapFail.cleanup)
  const r2 = await mapFail.runner.generate({ task: TASK, userId: 'u-zhang', profile: ZHANG, now: NOW })
  assert.equal(r2.ok, true)
  assert.equal(r2.empty, true)
})

// 2026-09-18 事故第 1 件整改：reduce 解析失败当场重生成，不等 retryIntervalMs。
test('reduce in-place regenerate succeeds on the second attempt within the same generate() call', async (t) => {
  let reduceCalls = 0
  const prompts = []
  const agent = {
    calls: [],
    respond: async (args) => {
      const kind = args.text.includes('性质分类') ? 'tag' : args.text.includes('合并规则') ? 'reduce' : 'map'
      agent.calls.push({ kind, userId: args.userId })
      if (kind === 'tag') return { text: TAG_OK }
      if (kind === 'map') return { text: MAP_OK }
      reduceCalls++
      prompts.push(args.text)
      return { text: reduceCalls === 1 ? '模型这次没输出 JSON' : REDUCE_OK }
    },
  }
  const { runner, cleanup } = setup({ agent })
  t.after(cleanup)
  const r = await runner.generate({ task: TASK, userId: 'u-zhang', profile: ZHANG, now: NOW })
  assert.equal(reduceCalls, 2) // 第 1 次坏输出，第 2 次（带纠正提示）成功
  assert.match(prompts[1], /注意：你上一次的输出不是合法 JSON/)
  assert.equal(r.ok, true)
  assert.equal(r.empty, false)
  assert.ok(r.report) // 用户最终拿到的是正常简报，感知不到中途那次坏输出
})

test('reduce in-place regenerate exhausts unparsableRetries then reports digest_unparsable', async (t) => {
  let reduceCalls = 0
  const agent = {
    respond: async (args) => {
      const kind = args.text.includes('性质分类') ? 'tag' : args.text.includes('合并规则') ? 'reduce' : 'map'
      if (kind === 'tag') return { text: TAG_OK }
      if (kind === 'map') return { text: MAP_OK }
      reduceCalls++
      return { text: '模型死活不给 JSON' }
    },
  }
  const { runner, cleanup } = setup({ agent, unparsableRetries: 2 })
  t.after(cleanup)
  const r = await runner.generate({ task: TASK, userId: 'u-zhang', profile: ZHANG, now: NOW })
  assert.equal(reduceCalls, 3) // unparsableRetries=2 → 最多问 3 次
  assert.equal(r.ok, false)
  assert.equal(r.error, 'digest_unparsable')
})

test('tagging failure degrades to the default tag instead of aborting the digest', async (t) => {
  const { runner, agent, groupProfiles, cleanup } = setup({ agentOpts: { fail: { tag: '打标挂了' } } })
  t.after(cleanup)
  const r = await runner.generate({ task: TASK, userId: 'u-zhang', profile: ZHANG, now: NOW })
  assert.equal(r.ok, true)
  assert.equal(r.empty, false)
  assert.equal(groupProfiles.list('u-zhang').length, 0) // 失败不落库
  // 走 DEFAULT_TAG='friends'：宁可少捞（假阴性），不要把闲聊当决策（假阳性）
  const maps = agent.calls.filter((c) => c.kind === 'map')
  assert.equal(maps.length, 2)
  assert.ok(maps.every((c) => /高热度话题/.test(c.text)))
})

test('a model-invented chat id in the tagging reply is discarded', async (t) => {
  const { runner, groupProfiles, cleanup } = setup({
    agentOpts: { tag: '{"groups":[{"chatWxid":"g1@chatroom","tag":"work"},{"chatWxid":"不存在的群","tag":"work"}]}' },
  })
  t.after(cleanup)
  await runner.generate({ task: TASK, userId: 'u-zhang', profile: ZHANG, now: NOW })
  assert.equal(groupProfiles.get('u-zhang', 'g1@chatroom').tag, 'work')
  assert.equal(groupProfiles.get('u-zhang', '不存在的群'), null)
})

test('a user with no identity, or with no groups at all, is handled without crashing', async (t) => {
  const { runner, cleanup } = setup()
  t.after(cleanup)
  assert.deepEqual(await runner.generate({ task: TASK, userId: 'u', profile: {}, now: NOW }), { ok: false, error: 'no_identity' })
  const stranger = await runner.generate({ task: TASK, userId: 'u', profile: { wxid: 'wxid_nobody', nickname: '路人' }, now: NOW })
  assert.equal(stranger.ok, true)
  assert.equal(stranger.empty, true)
})

test('poster rendering is attached when available and non-fatal when it throws', async (t) => {
  const posterFile = path.join(os.tmpdir(), `dg-poster-${Date.now()}.png`)
  fs.writeFileSync(posterFile, Buffer.from([137, 80, 78, 71]))
  t.after(() => fs.rmSync(posterFile, { force: true }))

  const okRun = setup({ posterRender: async (_report, html) => { assert.match(html, /需要你行动/); return posterFile } })
  t.after(okRun.cleanup)
  const ok = await okRun.runner.generate({ task: TASK, userId: 'u-zhang', profile: ZHANG, now: NOW })
  assert.equal(ok.report.posterPath, posterFile)
  assert.equal(okRun.reportStore.getReport(ok.report.id).kind, 'wechat-digest') // 二次保存不丢 kind

  const badRun = setup({ posterRender: async () => { throw new Error('没有无头浏览器') } })
  t.after(badRun.cleanup)
  const degraded = await badRun.runner.generate({ task: TASK, userId: 'u-zhang', profile: ZHANG, now: NOW })
  assert.equal(degraded.ok, true)
  assert.equal(degraded.report.posterPath, '') // 纯文本降级，不整体失败
})

test('scanning more groups than the cap is truncated, but the truncation is recorded honestly', async (t) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const chatFile = path.join(os.tmpdir(), `dg-cap-chat-${stamp}.db`)
  const gpFile = path.join(os.tmpdir(), `dg-cap-gp-${stamp}.db`)
  const rpFile = path.join(os.tmpdir(), `dg-cap-rp-${stamp}.db`)
  seedChatDb(chatFile)
  const wechatLogStore = new WechatLogStore({ file: chatFile })
  const groupProfiles = new GroupProfileStore({ file: gpFile })
  const reportStore = new ReportStore({ file: rpFile })
  t.after(() => {
    wechatLogStore.close(); groupProfiles.close(); reportStore.close()
    for (const f of [chatFile, gpFile, rpFile]) fs.rmSync(f, { force: true })
  })

  const agent = makeAgent()
  // 张三有 2 个活跃群（项目群 + 家人群），上限压到 1
  const runner = new WechatDigestRunner({ agent, wechatLogStore, groupProfiles, reportStore, maxChats: 1 })
  const r = await runner.generate({ task: TASK, userId: 'u-zhang', profile: ZHANG, now: NOW })
  assert.equal(r.ok, true)
  assert.equal(agent.calls.filter((c) => c.kind === 'map').length, 1)
  // 静默截断会让"我的群怎么没被读"变成查无实据的投诉 —— 必须留痕
  assert.match(r.report.rawText, /另有 1 个因数量上限未扫描/)
})
