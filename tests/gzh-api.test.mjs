import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { gzhSearch, gzhContent, getGzhApiKey, SEARCH_SOURCE, DETAIL_SOURCE } from '../src/services/gzh-api.mjs'

function jsonResp(obj, ok = true) {
  return { ok, json: async () => obj }
}

function searchFetch(calls, pages) {
  return async (url, options) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body) })
    return jsonResp(pages.shift()())
  }
}

test('gzhSearch posts the documented payload with X-API-KEY and dedupes across pages', async () => {
  const calls = []
  const pages = [
    () => ({ code: 200, data: { list: [{ workUuid: 'a1', title: '甲', author: '号1', summary: 's1', readCount: 10, likeCount: 2, publishTime: '2026-09-01', workUrl: 'https://x/1' }, { workUuid: 'a2', title: '乙', author: '号2', summary: 's2' }], hasMore: 1 } }),
    () => ({ code: 200, data: { list: [{ workUuid: 'a1', title: '甲（重复）', author: '号1' }, { workUuid: 'a3', title: '丙', author: '号3' }], hasMore: 0 } }),
  ]
  const out = await gzhSearch({ keyword: 'agent安全', count: 10, apiKey: 'ak-test', fetchImpl: searchFetch(calls, pages) })
  assert.equal(out.length, 3)
  assert.deepEqual(out.map((a) => a.workUuid), ['a1', 'a2', 'a3'])
  // payload fields per the RedFoxHub protocol (same as gzh_tool.py)
  assert.equal(calls[0].url, 'https://redfox.hk/story/api/gzhData/searchArticle')
  assert.equal(calls[0].options.headers['X-API-KEY'], 'ak-test')
  assert.equal(calls[0].body.keyword, 'agent安全')
  assert.equal(calls[0].body.offset, 0)
  assert.equal(calls[0].body.sortType, 'default')
  assert.equal(calls[0].body.source, SEARCH_SOURCE)
  assert.equal(calls[1].body.offset, 2) // second page advances by batch length
})

test('gzhSearch rejects keywords longer than 10 chars', async () => {
  await assert.rejects(() => gzhSearch({ keyword: '这是一个超过十个字符的超长关键词吧', fetchImpl: async () => jsonResp({}) }), /关键词过长/)
  await assert.rejects(() => gzhSearch({ keyword: '  ', fetchImpl: async () => jsonResp({}) }), /关键词不能为空/)
})

test('gzhSearch retries once on the 3108 rate-limit code, then gives up on repeat failure', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return jsonResp({ code: 3108, msg: 'rate limited' }) }
  await assert.rejects(() => gzhSearch({ keyword: '热点', fetchImpl }), /3108/)
  assert.equal(calls, 2) // one retry
})

test('gzhSearch throws with the server message on other error codes', async () => {
  await assert.rejects(() => gzhSearch({ keyword: '热点', fetchImpl: async () => jsonResp({ code: 4000, msg: '额度不足' }) }), /额度不足/)
})

test('gzhContent fetches the full body by workUuid', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) })
    return jsonResp({ code: 200, data: [{ workUuid: 'w1', title: '标题', author: '作者', publishTime: '2026-09-02', content: '正文内容', workUrl: 'https://x/1' }] })
  }
  const doc = await gzhContent({ workUuid: 'w1', apiKey: 'ak-test', fetchImpl })
  assert.equal(calls[0].url, 'https://redfox.hk/story/api/gzhData/queryWork')
  assert.deepEqual(calls[0].body, { workUuid: 'w1', source: DETAIL_SOURCE })
  assert.equal(doc.content, '正文内容')
  assert.equal(doc.contentLength, 4)
})

test('getGzhApiKey prefers env, falls back to the shared redfox.json config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redfox-'))
  const cfg = path.join(dir, 'redfox.json')
  fs.writeFileSync(cfg, JSON.stringify({ api_key: 'ak-file' }))
  try {
    assert.equal(getGzhApiKey({ env: { REDFOX_API_KEY: 'ak-env' }, configPath: cfg }), 'ak-env')
    assert.equal(getGzhApiKey({ env: {}, configPath: cfg }), 'ak-file')
    assert.equal(getGzhApiKey({ env: {}, configPath: path.join(dir, 'missing.json') }), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
