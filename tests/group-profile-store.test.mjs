import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { GroupProfileStore, GROUP_TAGS } from '../src/services/group-profile-store.mjs'

function makeStore() {
  const file = path.join(os.tmpdir(), `gp-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  return { file, store: new GroupProfileStore({ file }) }
}

test('group profiles are per-user and round-trip', () => {
  const { file, store } = makeStore()
  try {
    store.put({ userId: 'u1', chatWxid: 'g1@chatroom', chatName: '项目群', tag: 'work', confidence: 0.9, at: 1000 })
    store.put({ userId: 'u2', chatWxid: 'g1@chatroom', chatName: '项目群', tag: 'notice', confidence: 0.4, at: 1000 })

    const a = store.get('u1', 'g1@chatroom')
    assert.equal(a.tag, 'work')
    assert.equal(a.chatName, '项目群')
    assert.equal(a.confidence, 0.9)
    assert.equal(a.source, 'auto')
    assert.equal(a.updatedAt, 1000)
    // 同一个群对不同人可以是不同性质 —— 这是本表按 (user_id, chat_wxid) 建主键的原因
    assert.equal(store.get('u2', 'g1@chatroom').tag, 'notice')
    assert.equal(store.get('u3', 'g1@chatroom'), null)
    assert.equal(store.list('u1').length, 1)
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})

test('auto tagging never overwrites a user-set tag (the trust invariant)', () => {
  const { file, store } = makeStore()
  try {
    store.put({ userId: 'u1', chatWxid: 'g1', chatName: '某群', tag: 'friends', source: 'auto', at: 1000 })
    // 用户纠正
    store.put({ userId: 'u1', chatWxid: 'g1', chatName: '某群', tag: 'work', confidence: 1, source: 'user', at: 2000 })
    assert.equal(store.get('u1', 'g1').tag, 'work')
    assert.equal(store.get('u1', 'g1').source, 'user')

    // 之后的自动打标必须原样退让（整行不动：tag/confidence/updated_at 都不变）
    const kept = store.put({ userId: 'u1', chatWxid: 'g1', chatName: '某群改名了', tag: 'dead', confidence: 0.95, source: 'auto', at: 3000 })
    assert.equal(kept.tag, 'work')
    assert.equal(kept.source, 'user')
    assert.equal(kept.confidence, 1)
    assert.equal(kept.updatedAt, 2000)
    assert.equal(kept.chatName, '某群')
    assert.equal(store.get('u1', 'g1').tag, 'work')

    // 用户可以改自己的主意
    store.put({ userId: 'u1', chatWxid: 'g1', chatName: '某群', tag: 'dead', source: 'user', at: 4000 })
    assert.equal(store.get('u1', 'g1').tag, 'dead')
    // auto 覆盖 auto 是允许的
    store.put({ userId: 'u1', chatWxid: 'g2', tag: 'friends', source: 'auto', at: 1000 })
    store.put({ userId: 'u1', chatWxid: 'g2', tag: 'hobby', source: 'auto', at: 5000 })
    assert.equal(store.get('u1', 'g2').tag, 'hobby')
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})

test('invalid tags and missing ids are rejected rather than persisted', () => {
  const { file, store } = makeStore()
  try {
    assert.throws(() => store.put({ userId: 'u1', chatWxid: 'g1', tag: '工作群' }), /未知群标签/)
    assert.throws(() => store.put({ userId: 'u1', chatWxid: 'g1', tag: '' }), /未知群标签/)
    assert.throws(() => store.put({ userId: '', chatWxid: 'g1', tag: 'work' }), /必填/)
    assert.throws(() => store.put({ userId: 'u1', chatWxid: '', tag: 'work' }), /必填/)
    assert.equal(store.list('u1').length, 0)
    // 白名单本身
    for (const t of GROUP_TAGS) store.put({ userId: 'uT', chatWxid: `c-${t}`, tag: t })
    assert.equal(store.list('uT').length, GROUP_TAGS.length)
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})

test('untagged() selects exactly the chats without a profile row', () => {
  const { file, store } = makeStore()
  try {
    const chats = [
      { chatWxid: 'g1', name: 'A', isGroup: true },
      { chatWxid: 'g2', name: 'B', isGroup: true },
      { chatWxid: 'g3', name: 'C', isGroup: true },
    ]
    assert.deepEqual(store.untagged('u1', chats).map((c) => c.chatWxid), ['g1', 'g2', 'g3'])
    store.put({ userId: 'u1', chatWxid: 'g2', tag: 'work' })
    assert.deepEqual(store.untagged('u1', chats).map((c) => c.chatWxid), ['g1', 'g3'])
    // 另一个用户的画像不算数
    store.put({ userId: 'u2', chatWxid: 'g1', tag: 'work' })
    assert.deepEqual(store.untagged('u1', chats).map((c) => c.chatWxid), ['g1', 'g3'])
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})

test('the store reopens an existing file without losing rows', () => {
  const { file, store } = makeStore()
  try {
    store.put({ userId: 'u1', chatWxid: 'g1', chatName: 'A', tag: 'work', source: 'user', at: 7 })
    store.close()
    const again = new GroupProfileStore({ file })
    try {
      assert.equal(again.get('u1', 'g1').tag, 'work')
      assert.equal(again.get('u1', 'g1').source, 'user')
    } finally { again.close() }
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})
