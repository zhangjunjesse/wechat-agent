import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'

// The media size cap is read from env at module import time, so it must be set
// before the import below. 1MB keeps the "video over the cap" test lightweight.
process.env.SEND_MEDIA_MAX_MB = '1'
const { wechatSendTools } = await import('../src/tools/wechat-send-tools.mjs')

function call(toolFn, input, ctx) {
  return toolFn.invoke(ctx, JSON.stringify(input))
}

function tmpRoot() {
  return path.join(os.tmpdir(), `wst-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

test('send_file declines gracefully when the current turn has no WeChat channel (e.g. web chat)', async () => {
  const root = tmpRoot()
  await fsp.mkdir(path.join(root, 'u1'), { recursive: true })
  await fsp.writeFile(path.join(root, 'u1', 'a.csv'), 'x,y\n1,2', 'utf8')
  try {
    const provider = { sendFile: async () => { throw new Error('should not be called') } }
    const { sendFile } = wechatSendTools({ provider, root })
    const out = await call(sendFile, { path: 'a.csv' }, { context: { userId: 'u1', channel: null } })
    assert.match(out, /不是通过微信进行的/)
    assert.match(out, /write_file/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('send_file declines gracefully when the provider has no sendFile capability', async () => {
  const root = tmpRoot()
  await fsp.mkdir(path.join(root, 'u1'), { recursive: true })
  await fsp.writeFile(path.join(root, 'u1', 'a.csv'), 'x,y\n1,2', 'utf8')
  try {
    const { sendFile } = wechatSendTools({ provider: {}, root })
    const ctx = { context: { userId: 'u1', channel: { type: 'ilink', providerBotId: 'b', toProviderUserId: 'u', contextToken: 'c' } } }
    const out = await call(sendFile, { path: 'a.csv' }, ctx)
    assert.match(out, /不是通过微信进行的|无法直接发送/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('send_file calls provider.sendFile with the channel identifiers and file contents when on WeChat', async () => {
  const root = tmpRoot()
  await fsp.mkdir(path.join(root, 'u1', 'out'), { recursive: true })
  await fsp.writeFile(path.join(root, 'u1', 'out', 'report.csv'), 'name,phone\nZ,123', 'utf8')
  try {
    const calls = []
    const provider = { sendFile: async (args) => { calls.push(args); return { providerMessageId: 'ilink-1' } } }
    const { sendFile } = wechatSendTools({ provider, root })
    const ctx = { context: { userId: 'u1', channel: { type: 'ilink', providerBotId: 'bot-1', toProviderUserId: 'wx-peer', contextToken: 'ctx-1' } } }
    const out = await call(sendFile, { path: 'out/report.csv' }, ctx)
    assert.match(out, /已发送文件.*report\.csv/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].providerBotId, 'bot-1')
    assert.equal(calls[0].toProviderUserId, 'wx-peer')
    assert.equal(calls[0].contextToken, 'ctx-1')
    assert.equal(calls[0].fileName, 'report.csv')
    assert.equal(Buffer.isBuffer(calls[0].buffer), true)
    assert.equal(calls[0].buffer.toString('utf8'), 'name,phone\nZ,123')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('send_file honors an explicit filename override', async () => {
  const root = tmpRoot()
  await fsp.mkdir(path.join(root, 'u1'), { recursive: true })
  await fsp.writeFile(path.join(root, 'u1', 'raw.csv'), 'a,b', 'utf8')
  try {
    const calls = []
    const provider = { sendFile: async (args) => { calls.push(args); return {} } }
    const { sendFile } = wechatSendTools({ provider, root })
    const ctx = { context: { userId: 'u1', channel: { type: 'ilink', providerBotId: 'b', toProviderUserId: 'u', contextToken: 'c' } } }
    await call(sendFile, { path: 'raw.csv', filename: '筛选结果.csv' }, ctx)
    assert.equal(calls[0].fileName, '筛选结果.csv')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('send_file stays sandboxed to the user directory', async () => {
  const root = tmpRoot()
  await fsp.mkdir(path.join(root, 'u1'), { recursive: true })
  await fsp.mkdir(path.join(root, 'other'), { recursive: true })
  await fsp.writeFile(path.join(root, 'other', 'secret.csv'), 'nope', 'utf8')
  try {
    const provider = { sendFile: async () => { throw new Error('should not be called') } }
    const { sendFile } = wechatSendTools({ provider, root })
    const ctx = { context: { userId: 'u1', channel: { type: 'ilink', providerBotId: 'b', toProviderUserId: 'u', contextToken: 'c' } } }
    const out = await call(sendFile, { path: '../other/secret.csv' }, ctx)
    assert.match(out, /路径越界/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('send_file refuses a file over the size cap', async () => {
  const root = tmpRoot()
  await fsp.mkdir(path.join(root, 'u1'), { recursive: true })
  // 21MB > the 20MB cap
  await fsp.writeFile(path.join(root, 'u1', 'big.bin'), Buffer.alloc(21 * 1024 * 1024))
  try {
    const provider = { sendFile: async () => { throw new Error('should not be called') } }
    const { sendFile } = wechatSendTools({ provider, root })
    const ctx = { context: { userId: 'u1', channel: { type: 'ilink', providerBotId: 'b', toProviderUserId: 'u', contextToken: 'c' } } }
    const out = await call(sendFile, { path: 'big.bin' }, ctx)
    assert.match(out, /太大/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function ilinkCtx() {
  return { context: { userId: 'u1', channel: { type: 'ilink', providerBotId: 'b', toProviderUserId: 'u', contextToken: 'c' } } }
}

test('send_file routes a video file to provider.sendVideo as a native video message', async () => {
  const root = tmpRoot()
  await fsp.mkdir(path.join(root, 'u1'), { recursive: true })
  await fsp.writeFile(path.join(root, 'u1', 'clip.mp4'), Buffer.alloc(128 * 1024))
  try {
    const calls = []
    const provider = { sendVideo: async (args) => { calls.push(args); return { providerMessageId: 'ilink-v' } } }
    const { sendFile } = wechatSendTools({ provider, root })
    const out = await call(sendFile, { path: 'clip.mp4' }, ilinkCtx())
    assert.match(out, /已发送视频.*clip\.mp4/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].fileName, 'clip.mp4')
    assert.equal(calls[0].providerBotId, 'b')
    assert.equal(Buffer.isBuffer(calls[0].buffer), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('send_file routes an image file to provider.sendImage as a native image message', async () => {
  const root = tmpRoot()
  await fsp.mkdir(path.join(root, 'u1'), { recursive: true })
  await fsp.writeFile(path.join(root, 'u1', 'photo.png'), Buffer.alloc(64 * 1024))
  try {
    const calls = []
    const provider = { sendImage: async (args) => { calls.push(args); return {} } }
    const { sendFile } = wechatSendTools({ provider, root })
    const out = await call(sendFile, { path: 'photo.png' }, ilinkCtx())
    assert.match(out, /已发送图片.*photo\.png/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].fileName, 'photo.png')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('send_file falls back to the FILE channel when the provider lacks sendVideo', async () => {
  const root = tmpRoot()
  await fsp.mkdir(path.join(root, 'u1'), { recursive: true })
  await fsp.writeFile(path.join(root, 'u1', 'clip.mp4'), Buffer.alloc(64 * 1024))
  try {
    const calls = []
    const provider = { sendFile: async (args) => { calls.push(args); return {} } }
    const { sendFile } = wechatSendTools({ provider, root })
    const out = await call(sendFile, { path: 'clip.mp4' }, ilinkCtx())
    assert.match(out, /已发送文件.*clip\.mp4/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].fileName, 'clip.mp4')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('send_file refuses a video over the media size cap (env SEND_MEDIA_MAX_MB)', async () => {
  const root = tmpRoot()
  await fsp.mkdir(path.join(root, 'u1'), { recursive: true })
  // 1.5MB > the 1MB media cap set at the top of this file
  await fsp.writeFile(path.join(root, 'u1', 'big.mp4'), Buffer.alloc(Math.ceil(1.5 * 1024 * 1024)))
  try {
    const provider = { sendVideo: async () => { throw new Error('should not be called') } }
    const { sendFile } = wechatSendTools({ provider, root })
    const out = await call(sendFile, { path: 'big.mp4' }, ilinkCtx())
    assert.match(out, /太大/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
