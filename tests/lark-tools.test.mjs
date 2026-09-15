import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { LarkTokenStore } from '../src/services/lark-token-store.mjs'
import { LarkClient } from '../src/services/lark-client.mjs'
import { larkTools } from '../src/tools/lark-tools.mjs'

function call(toolFn, input, ctx) {
  return toolFn.invoke(ctx, JSON.stringify(input))
}

function setupTools({ client = null, redirectUri = 'https://x/lark/auth/callback' } = {}) {
  const file = path.join(os.tmpdir(), `lark-t-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const tokenStore = new LarkTokenStore({ file })
  const realClient = client || new LarkClient({
    appId: 'app_x', appSecret: 's', tokenStore,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: {} }) }),
  })
  const tools = larkTools({ client: realClient, redirectUri })
  return { file, tokenStore, client: realClient, tools }
}

test('lark tools return friendly messages when lark is not configured', async () => {
  const tools = larkTools({ client: null, redirectUri: '' })
  const ctx = { context: { userId: 'u1' } }
  const out = await call(tools.larkAuth, {}, ctx)
  assert.match(out, /未启用/)
  const out2 = await call(tools.larkReadDoc, { doc: 'W1abc12345' }, ctx)
  assert.match(out2, /未启用/)
})

test('lark_auth returns an authorization URL bound to the user', async () => {
  const { file, tokenStore, tools } = setupTools()
  try {
    const out = await call(tools.larkAuth, {}, { context: { userId: 'u1' } })
    assert.match(out, /open-apis\/authen\/v1\/index/)
    assert.match(out, /state=u1/)
    const status = await call(tools.larkAuthStatus, {}, { context: { userId: 'u1' } })
    assert.match(status, /尚未授权/)
  } finally {
    tokenStore.close(); fs.rmSync(file, { force: true })
  }
})

test('lark_auth_status reflects granted token; read/search call through to the client', async () => {
  const { file, tokenStore, tools } = setupTools()
  try {
    tokenStore.set({ userId: 'u1', accessToken: 'tok', refreshToken: 'r', expiresIn: 7200, refreshExpiresIn: 3600 })
    const status = await call(tools.larkAuthStatus, {}, { context: { userId: 'u1' } })
    assert.match(status, /已授权/)
    // read/search 走 client（mock fetch 返回空 data → 各自友好提示而非崩溃）
    const read = await call(tools.larkReadDoc, { doc: 'W1abc12345' }, { context: { userId: 'u1' } })
    assert.ok(typeof read === 'string')
  } finally {
    tokenStore.close(); fs.rmSync(file, { force: true })
  }
})

test('lark_export_doc saves the exported file into the user sandbox and asks for send_file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-root-'))
  const buffer = Buffer.from('%PDF-1.4 fake')
  const client = {
    authUrl: () => 'https://auth.example',
    tokenStore: { get: () => ({ accessToken: 'tok' }) },
    exportDoc: async (_userId, doc, { ext }) => ({ fileName: `报告.${ext}`, ext, buffer, title: '报告' }),
  }
  const tools = larkTools({ client, redirectUri: 'https://x/cb', root })
  try {
    const out = await call(tools.larkExportDoc, { doc: 'https://x.feishu.cn/docx/W1abc12345', format: 'pdf' }, { context: { userId: 'u1' } })
    assert.match(out, /已导出「报告\.pdf」/)
    assert.match(out, /文件路径：files\/报告\.pdf/)
    assert.match(out, /send_file/)
    const saved = fs.readFileSync(path.join(root, 'u1', 'files', '报告.pdf'))
    assert.equal(saved.toString(), '%PDF-1.4 fake')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
