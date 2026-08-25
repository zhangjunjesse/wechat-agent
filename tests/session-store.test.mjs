import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { SessionStore } from '../src/services/session-store.mjs'

test('session store persists full transcript and isolates users', () => {
  const file = path.join(os.tmpdir(), `sess-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  try {
    const store = new SessionStore({ file })
    for (let i = 0; i < 3; i++) store.append('u1', `q${i}`, `a${i}`)
    const a = store.get('u1')
    assert.equal(a.transcript.length, 6)             // full transcript kept (3 user + 3 assistant)
    assert.ok(a.tokenEstimate > 0)
    assert.equal(store.get('u2').transcript.length, 0) // isolated per user
    // fold keeps recent turns and replaces summary
    store.fold('u1', '早前聊过：讨论天气', a.transcript.slice(4))
    const folded = store.get('u1')
    assert.equal(folded.transcript.length, 2)
    assert.match(folded.summary, /讨论天气/)
    // persistence across instances (same file)
    const store2 = new SessionStore({ file })
    assert.equal(store2.get('u1').transcript.length, 2)
  } finally {
    try { fs.rmSync(file, { force: true }) } catch (e) {}
  }
})
