import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { groupTagTools } from '../src/tools/group-tag-tools.mjs'
import { GroupProfileStore } from '../src/services/group-profile-store.mjs'

function call(toolFn, input, ctx) {
  return toolFn.invoke(ctx, JSON.stringify(input))
}

const CTX = { context: { userId: 'ilink-zhang', profile: { wxid: 'wxid_zhang', nickname: '张三' } } }

// 张三在「项目群」「摄影群」；「别人的群」不在他的 accessibleChats 里。
const CHATS = [
  { chatWxid: 'g1@chatroom', name: '项目群', isGroup: true },
  { chatWxid: 'g2@chatroom', name: '摄影群', isGroup: true },
  { chatWxid: 'wxid_zhang', name: '与助手的对话（私聊）', isGroup: false },
]

function setup() {
  const file = path.join(os.tmpdir(), `gtt-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const groupProfiles = new GroupProfileStore({ file })
  const seenIdentity = []
  const wechatLogStore = { accessibleChats: (identity) => { seenIdentity.push(identity); return CHATS } }
  const tools = groupTagTools({ groupProfiles, wechatLogStore })
  return { tools, groupProfiles, seenIdentity, cleanup: () => { groupProfiles.close(); fs.rmSync(file, { force: true }) } }
}

test('set_group_tag persists the user correction as source=user', async (t) => {
  const { tools, groupProfiles, seenIdentity, cleanup } = setup()
  t.after(cleanup)
  const out = await call(tools.setGroupTag, { chat: '项目群', tag: 'work' }, CTX)
  assert.match(out, /项目群/)
  assert.match(out, /工作/)
  assert.match(out, /不会再覆盖/)

  const row = groupProfiles.get('ilink-zhang', 'g1@chatroom')
  assert.equal(row.tag, 'work')
  assert.equal(row.source, 'user')
  assert.equal(row.confidence, 1)
  assert.equal(row.chatName, '项目群')
  // 权限校验用的是 run context 里的 profile 身份（同 wechat_* 工具）
  assert.deepEqual(seenIdentity[0], { wxid: 'wxid_zhang', nickname: '张三' })
})

test('set_group_tag matches partial group names but never a chat the user is not in', async (t) => {
  const { tools, groupProfiles, cleanup } = setup()
  t.after(cleanup)
  // 部分匹配
  await call(tools.setGroupTag, { chat: '摄影', tag: 'hobby' }, CTX)
  assert.equal(groupProfiles.get('ilink-zhang', 'g2@chatroom').tag, 'hobby')

  // 权限边界：不在 accessibleChats 里的群打不了标，且不区分"不存在"与"你不在"
  const denied = await call(tools.setGroupTag, { chat: '别人的群', tag: 'work' }, CTX)
  assert.match(denied, /找不到「别人的群」，或你不在这个群里/)
  assert.equal(groupProfiles.list('ilink-zhang').length, 1)

  // 1:1 私聊不是群，不能打标
  const direct = await call(tools.setGroupTag, { chat: '与助手的对话（私聊）', tag: 'work' }, CTX)
  assert.match(direct, /找不到/)
})

test('set_group_tag rejects unknown tags and unverified users without writing anything', async (t) => {
  const { tools, groupProfiles, cleanup } = setup()
  t.after(cleanup)
  const bad = await call(tools.setGroupTag, { chat: '项目群', tag: '工作群' }, CTX)
  assert.match(bad, /不认识的性质/)
  assert.equal(groupProfiles.list('ilink-zhang').length, 0)

  const anon = await call(tools.setGroupTag, { chat: '项目群', tag: 'work' }, { context: { userId: 'u', profile: {} } })
  assert.match(anon, /请先完成身份验证/)
  assert.equal(groupProfiles.list('u').length, 0)
})

test('set_group_tag on a dead group says it will be skipped entirely', async (t) => {
  const { tools, cleanup } = setup()
  t.after(cleanup)
  const out = await call(tools.setGroupTag, { chat: '摄影群', tag: 'dead' }, CTX)
  assert.match(out, /直接跳过这个群/)
})

test('list_group_tags shows every accessible group, tagged or not, with its provenance', async (t) => {
  const { tools, groupProfiles, cleanup } = setup()
  t.after(cleanup)
  groupProfiles.put({ userId: 'ilink-zhang', chatWxid: 'g1@chatroom', chatName: '项目群', tag: 'work', source: 'auto' })
  groupProfiles.put({ userId: 'ilink-zhang', chatWxid: 'g2@chatroom', chatName: '摄影群', tag: 'hobby', source: 'user' })

  const out = await call(tools.listGroupTags, {}, CTX)
  assert.match(out, /项目群：工作（自动判定）/)
  assert.match(out, /摄影群：兴趣（你设定的）/)
  assert.doesNotMatch(out, /与助手的对话/) // 只列群
  assert.match(out, /判错了直接告诉我/)

  // 还没分类的群如实说"尚未分类"，不假装有结论
  const fresh = setup()
  t.after(fresh.cleanup)
  const out2 = await call(fresh.tools.listGroupTags, {}, CTX)
  assert.match(out2, /项目群：尚未分类/)
})

test('list_group_tags degrades honestly when there are no groups at all', async (t) => {
  const file = path.join(os.tmpdir(), `gtt-e-${Date.now()}.db`)
  const groupProfiles = new GroupProfileStore({ file })
  t.after(() => { groupProfiles.close(); fs.rmSync(file, { force: true }) })
  const { listGroupTags } = groupTagTools({ groupProfiles, wechatLogStore: { accessibleChats: () => [] } })
  assert.match(await call(listGroupTags, {}, CTX), /没有可查看的群/)
})
