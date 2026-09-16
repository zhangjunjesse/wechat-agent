import test from 'node:test'
import assert from 'node:assert/strict'
import { VisionClient, mimeForImage } from '../src/services/vision-client.mjs'

// 自动化测试一律 mock fetch，绝不真打网关（ADR-0030 验收口径：生产网关的
// 真实连通性由部署时的一次人工验证覆盖）。

function okResponse(content) {
  return { ok: true, json: async () => ({ choices: [{ message: { content } }], usage: { completion_tokens_details: { reasoning_tokens: 0 } } }) }
}

test('describeImage posts a standard OpenAI vision request and returns the text (ADR-0030)', async () => {
  let seenUrl, seenInit
  const client = new VisionClient({
    baseUrl: 'http://gw.example/v1/', // 尾斜杠应被归一化
    apiKey: 'sk-test', model: 'gpt-5.6-terra',
    fetchImpl: async (url, init) => { seenUrl = url; seenInit = init; return okResponse('图中是一只猫。') },
  })
  const out = await client.describeImage({ buffer: Buffer.from('png-bytes'), mimeType: 'image/png', question: '这是什么？' })
  assert.equal(out, '图中是一只猫。')
  assert.equal(seenUrl, 'http://gw.example/v1/chat/completions')
  assert.equal(seenInit.headers.authorization, 'Bearer sk-test')
  const body = JSON.parse(seenInit.body)
  assert.equal(body.model, 'gpt-5.6-terra')
  const [textBlock, imageBlock] = body.messages[0].content
  assert.deepEqual(textBlock, { type: 'text', text: '这是什么？' })
  assert.equal(imageBlock.type, 'image_url')
  assert.equal(imageBlock.image_url.url, `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`)
})

test('describeImage falls back to a generic Chinese prompt when no question is given', async () => {
  let body
  const client = new VisionClient({
    baseUrl: 'http://gw.example/v1', apiKey: 'k', model: 'm',
    fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return okResponse('描述') },
  })
  await client.describeImage({ buffer: Buffer.from('x') })
  assert.match(body.messages[0].content[0].text, /描述这张图片/)
})

test('gateway errors surface honestly with status and body excerpt, not a crash', async () => {
  const client = new VisionClient({
    baseUrl: 'http://gw.example/v1', apiKey: 'k', model: 'm',
    fetchImpl: async () => ({ ok: false, status: 502, text: async () => 'upstream exploded' }),
  })
  await assert.rejects(() => client.describeImage({ buffer: Buffer.from('x') }), /HTTP 502.*upstream exploded/)
})

test('empty model content is an error, never silently returned as an empty description', async () => {
  const client = new VisionClient({
    baseUrl: 'http://gw.example/v1', apiKey: 'k', model: 'm',
    fetchImpl: async () => okResponse('   '),
  })
  await assert.rejects(() => client.describeImage({ buffer: Buffer.from('x') }), /空内容/)
})

test('a hung gateway is cut off by the timeout with an honest message (ADR-0030)', async () => {
  const client = new VisionClient({
    baseUrl: 'http://gw.example/v1', apiKey: 'k', model: 'm', timeoutMs: 20,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }),
  })
  await assert.rejects(() => client.describeImage({ buffer: Buffer.from('x') }), /超时/)
})

test('mimeForImage maps common extensions and falls back to image/png', () => {
  assert.equal(mimeForImage('a.jpg'), 'image/jpeg')
  assert.equal(mimeForImage('b.webp'), 'image/webp')
  assert.equal(mimeForImage('c.unknown'), 'image/png')
})
