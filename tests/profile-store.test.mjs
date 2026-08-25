import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { ProfileStore } from '../src/services/profile-store.mjs'

test('profile store looks up by browser userId and stable ilinkUserId', async () => {
  const file = path.join(os.tmpdir(), `pf-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  try {
    const store = new ProfileStore({ file })
    await store.put('browser-abc', { nickname: 'Z.俊', wxid: '', ilinkUserId: 'o9cq80xxx@im.wechat' })
    // by browser id
    assert.equal((await store.get('browser-abc')).nickname, 'Z.俊')
    // by stable ilink id (same WeChat user after refresh)
    assert.equal((await store.get('o9cq80xxx@im.wechat')).nickname, 'Z.俊')
    assert.equal((await store.getByIlink('o9cq80xxx@im.wechat')).nickname, 'Z.俊')
    // unrelated user not found
    assert.equal(await store.get('other'), null)
  } finally {
    try { fs.rmSync(file, { force: true }) } catch (e) {}
  }
})

test('stableKey resolves browser id to providerUserId and is idempotent', async () => {
  const file = path.join(os.tmpdir(), `pf-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  try {
    const store = new ProfileStore({ file })
    await store.put('browser-abc', { nickname: 'Z.俊', wxid: '', ilinkUserId: 'o9cq80xxx@im.wechat' })
    await store.put('browser-raw', { nickname: '未验证' })
    assert.equal(await store.stableKey('browser-abc'), 'o9cq80xxx@im.wechat')
    // already-stable key stays stable
    assert.equal(await store.stableKey('o9cq80xxx@im.wechat'), 'o9cq80xxx@im.wechat')
    // unverified user falls back to its browser id
    assert.equal(await store.stableKey('browser-raw'), 'browser-raw')
  } finally {
    try { fs.rmSync(file, { force: true }) } catch (e) {}
  }
})
