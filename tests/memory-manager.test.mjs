import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { MemoryStore } from '../src/services/memory-store.mjs'
import { MemoryManager, relativeDue, fmtDate } from '../src/llm/memory-manager.mjs'
import { MemoryExtractor } from '../src/llm/memory-extractor.mjs'

function makeManager(file, extractResult, now = new Date('2026-08-24T10:00:00')) {
  const store = new MemoryStore({ file })
  const extractor = new MemoryExtractor({ complete: async () => extractResult })
  return new MemoryManager({ store, extractor, now: () => now })
}

test('evaluation layer 1: direct structured recall returns the exact fact', async () => {
  const file = path.join(os.tmpdir(), `mm-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  try {
    const manager = makeManager(file, '[{"action":"add","type":"semantic","category":"identity","content":"会员号12345"}]')
    await manager.absorb('u1', '我的会员号是12345', '已记住')
    assert.match(manager.recall('u1'), /会员号12345/)
  } finally { try { fs.rmSync(file, { force: true }) } catch (e) {} }
})

test('evaluation layer 2: multiple sessions retrieve all related facts (two cars)', async () => {
  const file = path.join(os.tmpdir(), `mm-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  try {
    const manager = makeManager(file, '[{"action":"add","type":"semantic","category":"fact","subject":"车","content":"有一辆特斯拉"},{"action":"add","type":"semantic","category":"fact","subject":"车","content":"有一辆宝马"}]')
    await manager.absorb('u1', '我有两辆车', '好的')
    const recall = manager.recall('u1')
    assert.match(recall, /特斯拉/)
    assert.match(recall, /宝马/)
  } finally { try { fs.rmSync(file, { force: true }) } catch (e) {} }
})

test('complex reasoning: allergy memory is retained and recallable for proactive warning', async () => {
  const file = path.join(os.tmpdir(), `mm-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  try {
    const manager = makeManager(file, '[{"action":"add","type":"semantic","category":"preference","subject":"饮食","content":"对花生过敏"}]')
    await manager.absorb('u1', '我对花生过敏', '已记住')
    // The agent would later inject this memory so the LLM can warn when
    // recommending Thai food; here we assert the allergy fact is in recall.
    assert.match(manager.recall('u1'), /花生过敏/)
  } finally { try { fs.rmSync(file, { force: true }) } catch (e) {} }
})

test('context switch: multiple topics stay coherent in one recall', async () => {
  const file = path.join(os.tmpdir(), `mm-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  try {
    const store = new MemoryStore({ file })
    const extractor = new MemoryExtractor({ complete: async () => '[]' })
    const manager = new MemoryManager({ store, extractor, now: () => new Date('2026-08-24T10:00:00') })
    store.upsert('u1', { category: 'fact', subject: '车', content: '有一辆特斯拉' })
    store.upsert('u1', { category: 'preference', content: '喜欢早起' })
    store.upsert('u1', { category: 'identity', content: '叫俊哥' })
    const recall = manager.recall('u1')
    assert.match(recall, /特斯拉/)
    assert.match(recall, /早起/)
    assert.match(recall, /俊哥/)
  } finally { try { fs.rmSync(file, { force: true }) } catch (e) {} }
})

test('time awareness: todo gets relative due days', () => {
  const now = new Date('2026-08-24T00:00:00')
  assert.match(relativeDue(Date.parse('2026-08-27'), now), /还剩 3 天/)
  assert.match(relativeDue(Date.parse('2026-08-25'), now), /明天到期/)
  assert.match(relativeDue(Date.parse('2026-08-20'), now), /已过期/)
  assert.match(fmtDate(Date.parse('2026-09-01')), /2026-09-01/)
})
