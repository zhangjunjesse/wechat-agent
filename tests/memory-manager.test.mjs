import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { MemoryStore } from '../src/services/memory-store.mjs'
import { MemoryManager } from '../src/llm/memory-manager.mjs'
import { MemoryExtractor } from '../src/llm/memory-extractor.mjs'

function makeManager(file, extractResult) {
  const store = new MemoryStore({ file })
  const extractor = new MemoryExtractor({ complete: async () => extractResult })
  return new MemoryManager({ store, extractor, now: () => new Date('2026-08-24T10:00:00') })
}

test('memory manager recalls and absorbs; time line is present', async () => {
  const file = path.join(os.tmpdir(), `mm-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  try {
    const manager = makeManager(file, '[{"action":"add","type":"identity","content":"叫俊哥"},{"action":"add","type":"fact","subject":"车","content":"有两辆车"}]')
    const absorbed = await manager.absorb('u1', '我叫俊哥，我有两辆车', '好的俊哥')
    assert.equal(absorbed, 2)
    const recall = manager.recall('u1')
    assert.match(recall, /叫俊哥/)
    assert.match(recall, /两辆车/)
    assert.match(manager.nowLine(), /2026-08-24/)
  } finally {
    try { fs.rmSync(file, { force: true }) } catch (e) {}
  }
})

test('evaluation layer 1: direct structured recall returns the exact fact', async () => {
  const file = path.join(os.tmpdir(), `mm2-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  try {
    const manager = makeManager(file, '[{"action":"add","type":"identity","content":"会员号12345"}]')
    await manager.absorb('u1', '我的会员号是12345', '已记住')
    const recall = manager.recall('u1')
    assert.match(recall, /会员号12345/)
  } finally {
    try { fs.rmSync(file, { force: true }) } catch (e) {}
  }
})

test('evaluation layer 2: multiple sessions retrieve all related facts', async () => {
  const file = path.join(os.tmpdir(), `mm3-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  try {
    const manager = makeManager(file, '[{"action":"add","type":"fact","subject":"车","content":"有一辆特斯拉"},{"action":"add","type":"fact","subject":"车","content":"有一辆宝马"}]')
    await manager.absorb('u1', '我有两辆车', '好的')
    const recall = manager.recall('u1')
    assert.match(recall, /特斯拉/)
    assert.match(recall, /宝马/)
  } finally {
    try { fs.rmSync(file, { force: true }) } catch (e) {}
  }
})
