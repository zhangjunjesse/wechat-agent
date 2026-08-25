import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { SessionStore } from '../src/services/session-store.mjs'

test('session store persists, isolates and truncates with summary', () => {
  const file = path.join(os.tmpdir(), `sess-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  try {
    const store = new SessionStore({ file, maxTurns: 4 })
    for (let i = 0; i < 6; i++) store.append('u1', `q${i}`, `a${i}`)
    const a = store.get('u1')
    assert.equal(a.messages.length, 4)               // truncated to maxTurns
    assert.match(a.summary, /已折叠早期对话 2 轮/)     // folded note present
    assert.equal(store.get('u2').messages.length, 0) // isolated per user
    // persistence across instances (same file)
    const store2 = new SessionStore({ file })
    assert.equal(store2.get('u1').messages.length, 4)
  } finally {
    try { fs.rmSync(file, { force: true }) } catch (e) {}
  }
})
