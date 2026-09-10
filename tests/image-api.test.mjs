import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { getImageApiKey, uploadImage, createImageTask, waitForImageTask, downloadImage, extFromUrl } from '../src/services/image-api.mjs'

function jsonResp(body, ok = true) {
  return { ok, json: async () => body }
}

test('getImageApiKey prefers env, falls back to the key file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgkey-'))
  const file = path.join(dir, 'key')
  fs.writeFileSync(file, '  sk-file-key\n')
  try {
    assert.equal(getImageApiKey({ env: { TOAPIS_API_KEY: 'sk-env' }, keyFile: file }), 'sk-env')
    assert.equal(getImageApiKey({ env: {}, keyFile: file }), 'sk-file-key')
    assert.equal(getImageApiKey({ env: {}, keyFile: path.join(dir, 'missing') }), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('uploadImage posts multipart with Bearer auth and returns the uploaded url', async () => {
  let seen
  const url = await uploadImage({
    buffer: Buffer.from('png-bytes'),
    fileName: 'photo.png',
    apiKey: 'sk-1',
    fetchImpl: async (u, opts) => {
      seen = { u: String(u), opts }
      return jsonResp({ success: true, data: { url: 'https://files.example/u/1.png' } })
    },
  })
  assert.equal(url, 'https://files.example/u/1.png')
  assert.match(seen.u, /\/v1\/uploads\/images$/)
  assert.equal(seen.opts.method, 'POST')
  assert.equal(seen.opts.headers.Authorization, 'Bearer sk-1')
  assert.ok(seen.opts.body instanceof FormData)
})

test('uploadImage rejects oversized images with a clear message', async () => {
  await assert.rejects(
    () => uploadImage({ buffer: Buffer.alloc(10 * 1024 * 1024 + 1), fileName: 'big.png', apiKey: 'sk', fetchImpl: async () => jsonResp({}) }),
    /10MB 上传上限/,
  )
})

test('createImageTask builds mode-specific payloads', async () => {
  const calls = []
  const fetchImpl = async (u, opts) => {
    calls.push(JSON.parse(opts.body))
    return jsonResp({ id: 'task_1', status: 'queued' })
  }
  await createImageTask({ mode: 'generate', prompt: '城市夜景', refs: ['https://r/1'], apiKey: 'sk', fetchImpl })
  await createImageTask({ mode: 'edit', prompt: '加按钮', refs: ['https://r/1'], apiKey: 'sk', fetchImpl })
  await createImageTask({ mode: 'inpaint', prompt: '改区域', refs: ['https://r/1'], maskUrl: 'https://m/1', apiKey: 'sk', fetchImpl })
  assert.deepEqual(calls[0].reference_images, ['https://r/1'])
  assert.equal(calls[0].image_urls, undefined)
  assert.deepEqual(calls[1].image_urls, ['https://r/1'])
  assert.equal(calls[1].reference_images, undefined)
  assert.deepEqual(calls[2].image_urls, ['https://r/1'])
  assert.equal(calls[2].mask_url, 'https://m/1')
  assert.equal(calls[0].model, 'gpt-image-2')
  assert.equal(calls[0].size, '1:1')
  assert.equal(calls[0].resolution, '1k')
})

test('createImageTask rejects invalid modes and missing refs/mask', async () => {
  const fetchImpl = async () => jsonResp({ id: 'x' })
  await assert.rejects(() => createImageTask({ mode: 'nope', prompt: 'x', apiKey: 'sk', fetchImpl }), /未知模式/)
  await assert.rejects(() => createImageTask({ mode: 'edit', prompt: 'x', apiKey: 'sk', fetchImpl }), /至少需要一张参考图/)
  await assert.rejects(() => createImageTask({ mode: 'inpaint', prompt: 'x', refs: ['https://r/1'], apiKey: 'sk', fetchImpl }), /mask/)
})

test('waitForImageTask polls until completed and dedupes result urls', async () => {
  const states = [
    { status: 'queued' },
    { status: 'in_progress' },
    { status: 'completed', result: { data: [{ url: 'https://img/1.png' }, { url: 'https://img/1.png' }, { url: 'https://img/2.png' }] } },
  ]
  let i = 0
  const urls = await waitForImageTask({ taskId: 't1', apiKey: 'sk', pollIntervalMs: 1, fetchImpl: async () => jsonResp(states[i++]) })
  assert.deepEqual(urls, ['https://img/1.png', 'https://img/2.png'])
  assert.equal(i, 3)
})

test('waitForImageTask surfaces failure and timeout', async () => {
  await assert.rejects(
    () => waitForImageTask({ taskId: 't', apiKey: 'sk', pollIntervalMs: 1, fetchImpl: async () => jsonResp({ status: 'failed', error: { message: '出图超限' } }) }),
    /出图超限/,
  )
  await assert.rejects(
    () => waitForImageTask({ taskId: 't', apiKey: 'sk', pollIntervalMs: 1, timeoutMs: 5, fetchImpl: async () => jsonResp({ status: 'queued' }) }),
    /超时/,
  )
})

test('downloadImage writes the file with auth and browser UA', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgdl-'))
  try {
    let seen
    const dest = path.join(dir, 'out.png')
    await downloadImage({
      url: 'https://files.example/img.png',
      destPath: dest,
      apiKey: 'sk',
      fetchImpl: async (u, opts) => {
        seen = { u: String(u), opts }
        const b = Buffer.from('fake-png')
        return { ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
      },
    })
    assert.equal(fs.readFileSync(dest, 'utf8'), 'fake-png')
    assert.equal(seen.opts.headers.Authorization, 'Bearer sk')
    assert.match(seen.opts.headers['User-Agent'], /Mozilla/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('extFromUrl picks the extension', () => {
  assert.equal(extFromUrl('https://x/a.png?token=1'), '.png')
  assert.equal(extFromUrl('https://x/b.JPG'), '.jpg')
  assert.equal(extFromUrl('https://x/c.webp'), '.webp')
  assert.equal(extFromUrl('https://x/none'), '.png')
})
