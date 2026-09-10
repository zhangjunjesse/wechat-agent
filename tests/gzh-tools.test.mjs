import test from 'node:test'
import assert from 'node:assert/strict'
import { gzhTools } from '../src/tools/gzh-tools.mjs'

function call(toolFn, input) {
  return toolFn.invoke({}, JSON.stringify(input))
}

const SAMPLE = [{ workUuid: 'w1', title: '第一篇', author: '号A', summary: '摘要一', readCount: 100, likeCount: 5, publishTime: '2026-09-01', url: 'https://x/1' }]

test('gzh_search formats the result list with workUuid for follow-up gzh_content calls', async () => {
  const seen = []
  const { gzhSearch } = gzhTools({ search: async (args) => { seen.push(args); return SAMPLE }, getKey: () => 'ak-test' })
  const out = await call(gzhSearch, { keyword: 'AI安全', count: 15 })
  assert.match(out, /搜到 1 条/)
  assert.match(out, /第一篇/)
  assert.match(out, /workUuid: w1/)
  assert.match(out, /公众号：号A/)
  assert.equal(seen[0].count, 15)
  assert.equal(seen[0].apiKey, 'ak-test')
})

test('gzh_search clamps count to 1..50 and reports empty results honestly', async () => {
  const seen = []
  const { gzhSearch } = gzhTools({ search: async (args) => { seen.push(args); return [] }, getKey: () => 'ak-test' })
  await call(gzhSearch, { keyword: '无结果', count: 999 })
  assert.equal(seen[0].count, 50)
  const empty = await call(gzhSearch, { keyword: '无结果', count: 0 })
  assert.match(empty, /没有搜到结果/)
})

test('gzh_search explains the missing API key instead of crashing', async () => {
  const { gzhSearch } = gzhTools({ search: async () => { throw new Error('should not be called') }, getKey: () => null })
  const out = await call(gzhSearch, { keyword: '热点' })
  assert.match(out, /REDFOX_API_KEY/)
  assert.match(out, /redfox\.hk/)
})

test('gzh_search surfaces API errors as actionable text', async () => {
  const { gzhSearch } = gzhTools({ search: async () => { throw new Error('API 返回错误码 4000：额度不足') }, getKey: () => 'ak-test' })
  const out = await call(gzhSearch, { keyword: '热点' })
  assert.match(out, /搜索失败：API 返回错误码 4000：额度不足/)
})

test('gzh_content returns the article headline and full body', async () => {
  const seen = []
  const { gzhContent } = gzhTools({ content: async (args) => { seen.push(args); return { workUuid: 'w1', title: '深度长文', author: '号A', publishTime: '2026-09-02', content: '这里是完整正文内容', contentLength: 8, url: 'https://x/1' } }, getKey: () => 'ak-test' })
  const out = await call(gzhContent, { workUuid: 'w1' })
  assert.match(out, /标题：深度长文/)
  assert.match(out, /正文长度：8/)
  assert.match(out, /这里是完整正文内容/)
  assert.equal(seen[0].workUuid, 'w1')
})

test('gzh_content requires a key and fails gracefully', async () => {
  const { gzhContent } = gzhTools({ content: async () => { throw new Error('x') }, getKey: () => null })
  const out = await call(gzhContent, { workUuid: 'w1' })
  assert.match(out, /REDFOX_API_KEY/)
})
