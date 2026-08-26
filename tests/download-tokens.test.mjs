import test from 'node:test'
import assert from 'node:assert/strict'
import { DownloadTokenStore } from '../src/services/download-tokens.mjs'

test('issue/resolve round-trips userId and relPath, and rejects unknown tokens', () => {
  const store = new DownloadTokenStore()
  const token = store.issue('u1', 'notes/a.csv')
  assert.equal(typeof token, 'string')
  assert.ok(token.length > 10)
  assert.deepEqual(store.resolve(token), { userId: 'u1', relPath: 'notes/a.csv' })
  assert.equal(store.resolve('does-not-exist'), null)
})

test('a token only ever reveals the one file it was issued for', () => {
  const store = new DownloadTokenStore()
  const t1 = store.issue('u1', 'a.csv')
  const t2 = store.issue('u1', 'b.csv')
  const t3 = store.issue('u2', 'a.csv')
  assert.equal(store.resolve(t1).relPath, 'a.csv')
  assert.equal(store.resolve(t2).relPath, 'b.csv')
  assert.equal(store.resolve(t3).userId, 'u2')
  assert.notEqual(t1, t2)
  assert.notEqual(t1, t3)
})

test('tokens expire after their TTL', () => {
  let now = 1_000_000
  const store = new DownloadTokenStore({ now: () => now, ttlMs: 1000 })
  const token = store.issue('u1', 'a.csv')
  assert.ok(store.resolve(token))
  now += 1001
  assert.equal(store.resolve(token), null)
})

test('per-issue ttlMs overrides the store default', () => {
  let now = 0
  const store = new DownloadTokenStore({ now: () => now, ttlMs: 10_000 })
  const shortLived = store.issue('u1', 'a.csv', 50)
  now = 51
  assert.equal(store.resolve(shortLived), null)
})
