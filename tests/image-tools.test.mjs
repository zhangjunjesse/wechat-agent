import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { imageTools } from '../src/tools/image-tools.mjs'

function call(toolFn, input, ctx) {
  return toolFn.invoke(ctx, JSON.stringify(input))
}

function makeEnv() {
  const root = path.join(os.tmpdir(), `imgt-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(path.join(root, 'u1', 'inbox'), { recursive: true })
  fs.writeFileSync(path.join(root, 'u1', 'inbox', 'photo.png'), 'png-bytes')
  fs.writeFileSync(path.join(root, 'u1', 'inbox', 'mask.png'), 'mask-bytes')
  return root
}

const ilinkCtx = { context: { userId: 'u1', channel: null } }

test('image_generate runs the full generate pipeline and returns sandbox paths', async () => {
  const root = makeEnv()
  const calls = []
  const api = {
    uploadImage: async ({ buffer, fileName, apiKey }) => { calls.push(['upload', fileName, buffer.toString(), apiKey]); return `https://up/${fileName}` },
    createImageTask: async (args) => { calls.push(['create', args.mode, args.size, args.resolution]); return 'task-1' },
    waitForImageTask: async () => ['https://img/1.png'],
    downloadImage: async ({ destPath, apiKey }) => { calls.push(['download', destPath, apiKey]); fs.mkdirSync(path.dirname(destPath), { recursive: true }); fs.writeFileSync(destPath, 'result-png'); return destPath },
  }
  try {
    const { imageGenerate } = imageTools({ root, getKey: () => 'sk-1', api })
    const out = await call(imageGenerate, { mode: 'generate', prompt: '未来城市', size: '16:9', resolution: '2k', image: 'inbox/photo.png' }, ilinkCtx)
    assert.match(out, /图片处理完成/)
    assert.match(out, /images\/img-.*\.png/)
    assert.match(out, /send_file/)
    assert.deepEqual(calls[0], ['upload', 'photo.png', 'png-bytes', 'sk-1'])
    assert.deepEqual(calls[1], ['create', 'generate', '16:9', '2k'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('image_generate requires an original image for edit mode and a mask for inpaint', async () => {
  const root = makeEnv()
  const api = { uploadImage: async () => { throw new Error('should not be called') } }
  try {
    const { imageGenerate } = imageTools({ root, getKey: () => 'sk-1', api })
    const noImg = await call(imageGenerate, { mode: 'edit', prompt: '改图' }, ilinkCtx)
    assert.match(noImg, /edit 模式必须提供原图/)
    const noMask = await call(imageGenerate, { mode: 'inpaint', prompt: '重绘', image: 'inbox/photo.png' }, ilinkCtx)
    assert.match(noMask, /inpaint 模式必须提供 mask/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('image_generate explains the missing API key', async () => {
  const root = makeEnv()
  try {
    const { imageGenerate } = imageTools({ root, getKey: () => null })
    const out = await call(imageGenerate, { prompt: '猫' }, ilinkCtx)
    assert.match(out, /未配置图片服务 API Key/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('image_generate validates resolution and rejects sandbox escape', async () => {
  const root = makeEnv()
  try {
    const { imageGenerate } = imageTools({ root, getKey: () => 'sk-1', api: { uploadImage: async () => { throw new Error('no') } } })
    const badRes = await call(imageGenerate, { prompt: 'x', resolution: '8k' }, ilinkCtx)
    assert.match(badRes, /不支持的 resolution/)
    const escape = await call(imageGenerate, { prompt: 'x', image: '../secret.png' }, ilinkCtx)
    assert.match(escape, /图片处理失败：路径越界/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('image_generate surfaces pipeline failures instead of crashing', async () => {
  const root = makeEnv()
  const api = {
    uploadImage: async ({ fileName }) => `https://up/${fileName}`,
    createImageTask: async () => { throw new Error('额度不足') },
  }
  try {
    const { imageGenerate } = imageTools({ root, getKey: () => 'sk-1', api })
    const out = await call(imageGenerate, { prompt: '猫' }, ilinkCtx)
    assert.match(out, /图片处理失败：额度不足/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
