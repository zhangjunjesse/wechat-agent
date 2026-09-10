import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { ContextTokenCache } from '../src/services/context-token-cache.mjs'

function tmpFile() {
  return path.join(os.tmpdir(), `ctx-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

test('update/get round-trip and flush survives a restart (new instance)', async () => {
  const file = tmpFile()
  try {
    const c1 = new ContextTokenCache({ file, flushDelayMs: 5 })
    c1.update('wx-user-1', { contextToken: 'tok-1', providerBotId: 'bot-1', at: 111 })
    c1.update('wx-user-2', { contextToken: 'tok-2', providerBotId: 'bot-1', at: 222 })
    assert.equal(c1.get('wx-user-1').contextToken, 'tok-1')
    assert.equal(c1.get('wx-unknown'), null)
    await new Promise((r) => setTimeout(r, 30)) // debounced flush fires
    const c2 = new ContextTokenCache({ file, flushDelayMs: 5000 })
    assert.equal(c2.get('wx-user-2').contextToken, 'tok-2')
    assert.equal(c2.get('wx-user-1').providerBotId, 'bot-1')
    c1.close()
    c2.close()
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('invalid entries are ignored on load and empty updates are rejected', async () => {
  const file = tmpFile()
  try {
    fs.writeFileSync(file, JSON.stringify({ 'a': { contextToken: 'ok', providerBotId: 'b' }, 'b': { providerBotId: 'no-token' } }))
    const c = new ContextTokenCache({ file })
    assert.equal(c.get('a').contextToken, 'ok')
    assert.equal(c.get('b'), null)
    c.update('x', { contextToken: '' })
    assert.equal(c.get('x'), null)
    c.close()
  } finally {
    fs.rmSync(file, { force: true })
  }
})
