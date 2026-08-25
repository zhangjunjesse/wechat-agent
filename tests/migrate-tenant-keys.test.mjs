import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { buildTenantMap, migrateTenantKeys } from '../scripts/migrate-tenant-keys.mjs'

const PID = 'o9cq80xxx@im.wechat'

function makeMemories(file) {
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'fact', subject TEXT NOT NULL DEFAULT '用户', relation TEXT NOT NULL DEFAULT '本人', content TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', due INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
  const ins = db.prepare('INSERT INTO memories (id, user_id, type, category, subject, relation, content, context, due, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  const now = Date.now()
  ins.run('m1', 'u_51cf2368-99a', 'semantic', 'identity', '用户', '本人', '助手名为小新', '', 0, now, now)
  ins.run('m2', 'u_51cf2368-99a', 'semantic', 'identity', '用户', '本人', '用户称呼为张工', '', 0, now, now)
  ins.run('m3', PID, 'semantic', 'identity', '用户', '本人', '助手名为小新', '', 0, now, now) // duplicate of m1
  return db
}

function makeSessions(file) {
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE sessions (user_id TEXT PRIMARY KEY, transcript TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '', token_estimate INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`)
  db.prepare('INSERT INTO sessions (user_id, transcript, summary, token_estimate, updated_at) VALUES (?,?,?,?,?)')
    .run('u_51cf2368-99a', JSON.stringify([{ role: 'user', content: '旧消息' }]), '旧摘要', 10, 1)
  db.prepare('INSERT INTO sessions (user_id, transcript, summary, token_estimate, updated_at) VALUES (?,?,?,?,?)')
    .run(PID, JSON.stringify([{ role: 'user', content: '新消息' }]), '新摘要', 10, 2)
  return db
}

test('buildTenantMap merges bindings and profiles', () => {
  const map = buildTenantMap(
    [{ userId: 'a', profile: { providerUserId: 'p1' } }, { userId: 'b', providerSession: { profile: { providerUserId: 'p2' } } }],
    [{ userId: 'c', ilinkUserId: 'p3' }]
  )
  assert.equal(map.get('a'), 'p1')
  assert.equal(map.get('b'), 'p2')
  assert.equal(map.get('c'), 'p3')
})

test('migrate moves + dedupes memories and merges sessions, idempotently', () => {
  const dir = path.join(os.tmpdir(), `mtk-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(dir, { recursive: true })
  const memFile = path.join(dir, 'memories.db')
  const sesFile = path.join(dir, 'sessions.db')
  const mdb = makeMemories(memFile)
  const sdb = makeSessions(sesFile)
  mdb.close(); sdb.close()
  try {
    const map = new Map([['u_51cf2368-99a', PID]])
    const r1 = migrateTenantKeys({ map, memoriesFile: memFile, sessionsFile: sesFile })
    assert.equal(r1.memMoved, 1)      // 张工 moved
    assert.equal(r1.memDedup, 1)      // 小新 deduped (already in PID)
    assert.equal(r1.sesMerged, 1)     // session merged
    assert.equal(r1.sesMoved, 0)

    // verify memories: PID now has 2 (小新 kept, 张工 moved); legacy id gone
    const mcheck = new DatabaseSync(memFile)
    const pidMem = mcheck.prepare('SELECT content FROM memories WHERE user_id=? ORDER BY content').all(PID).map((r) => r.content)
    assert.deepEqual(pidMem, ['助手名为小新', '用户称呼为张工'])
    assert.equal(mcheck.prepare('SELECT COUNT(*) n FROM memories WHERE user_id=?').get('u_51cf2368-99a').n, 0)
    mcheck.close()

    // verify session merged (legacy older first)
    const scheck = new DatabaseSync(sesFile)
    const merged = JSON.parse(scheck.prepare('SELECT transcript FROM sessions WHERE user_id=?').get(PID).transcript)
    assert.deepEqual(merged.map((m) => m.content), ['旧消息', '新消息'])
    assert.equal(scheck.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get('u_51cf2368-99a').n, 0)
    scheck.close()

    // idempotent: second run is a no-op
    const r2 = migrateTenantKeys({ map, memoriesFile: memFile, sessionsFile: sesFile })
    assert.deepEqual(r2, { memMoved: 0, memDedup: 0, sesMoved: 0, sesMerged: 0 })
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {}
  }
})
