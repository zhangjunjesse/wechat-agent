import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { MemoryStore } from '../src/services/memory-store.mjs'

test('memory store upserts, dedupes, replaces (conflict resolution) and isolates', () => {
  const file = path.join(os.tmpdir(), `mem-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  try {
    const store = new MemoryStore({ file })
    // add
    store.upsert('u1', { type: 'identity', content: '叫俊哥' })
    assert.equal(store.list('u1').length, 1)
    // dedupe: same type+subject+content
    store.upsert('u1', { type: 'identity', content: '叫俊哥' })
    assert.equal(store.list('u1').length, 1)
    // replace: new contradicting content for same type+subject
    store.replace('u1', { type: 'identity', content: '现在别叫俊哥' })
    assert.equal(store.list('u1').length, 1)
    assert.equal(store.list('u1')[0].content, '现在别叫俊哥')
    // isolation
    assert.equal(store.list('u2').length, 0)
    // two different facts coexist
    store.upsert('u1', { type: 'fact', subject: '车', content: '有一辆特斯拉' })
    store.upsert('u1', { type: 'fact', subject: '车', content: '有一辆宝马' })
    assert.equal(store.list('u1').length, 3)
  } finally {
    try { fs.rmSync(file, { force: true }) } catch (e) {}
  }
})
