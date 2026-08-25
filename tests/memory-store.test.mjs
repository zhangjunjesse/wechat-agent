import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { MemoryStore } from '../src/services/memory-store.mjs'

test('memory store inserts, dedupes by content, and isolates', () => {
  const file = path.join(os.tmpdir(), `mem-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  try {
    const store = new MemoryStore({ file })
    store.insert('u1', { category: 'identity', content: '叫俊哥' })
    assert.equal(store.list('u1').length, 1)
    // same content dedupes
    store.insert('u1', { category: 'identity', content: '叫俊哥' })
    assert.equal(store.list('u1').length, 1)
    // isolation
    assert.equal(store.list('u2').length, 0)
  } finally {
    try { fs.rmSync(file, { force: true }) } catch (e) {}
  }
})

test('conflict resolution: update replaces same key; different relation coexists', () => {
  const file = path.join(os.tmpdir(), `mem-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  try {
    const store = new MemoryStore({ file })
    store.insert('u1', { category: 'identity', content: '叫俊哥' })
    store.update('u1', { category: 'identity', content: '现在别叫俊哥' })
    assert.equal(store.list('u1').length, 1)
    assert.equal(store.list('u1')[0].content, '现在别叫俊哥')

    // same subject "张医生", different relation → coexist
    store.insert('u1', { category: 'fact', subject: '张医生', relation: '牙科医生', content: '是用户自己的牙科医生' })
    store.insert('u1', { category: 'fact', subject: '张医生', relation: '父亲的心脏病医生', content: '是用户父亲的心脏病医生' })
    const zhang = store.list('u1').filter((c) => c.subject === '张医生')
    assert.equal(zhang.length, 2)
  } finally {
    try { fs.rmSync(file, { force: true }) } catch (e) {}
  }
})

test('different content coexists (two cars are two memories)', () => {
  const file = path.join(os.tmpdir(), `mem-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  try {
    const store = new MemoryStore({ file })
    store.insert('u1', { category: 'fact', subject: '车', content: '有一辆特斯拉' })
    store.insert('u1', { category: 'fact', subject: '车', content: '有一辆宝马' })
    assert.equal(store.list('u1').length, 2)
  } finally {
    try { fs.rmSync(file, { force: true }) } catch (e) {}
  }
})
