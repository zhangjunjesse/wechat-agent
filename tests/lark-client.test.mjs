import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { LarkTokenStore } from '../src/services/lark-token-store.mjs'
import { LarkClient, extractDocId } from '../src/services/lark-client.mjs'

function mockFetch(routes) {
  return async (url, init = {}) => {
    const u = String(url)
    const hit = routes.find((r) => r.test(u, init))
    if (!hit) return { ok: false, status: 404, json: async () => ({ code: 404, msg: `no route: ${u}` }) }
    return { ok: true, status: 200, json: async () => hit.body }
  }
}

function setup({ routes = [] } = {}) {
  const file = path.join(os.tmpdir(), `lark-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const tokenStore = new LarkTokenStore({ file })
  const client = new LarkClient({ appId: 'app_x', appSecret: 'secret_x', tokenStore, fetchImpl: mockFetch(routes) })
  return { file, tokenStore, client }
}

test('extractDocId handles links and bare ids', () => {
  assert.equal(extractDocId('https://xxx.feishu.cn/docx/W1abc12345'), 'W1abc12345')
  assert.equal(extractDocId('https://docs.feishu.cn/docx/W1abc12345?from=1'), 'W1abc12345')
  assert.equal(extractDocId('W1abc12345'), 'W1abc12345')
  assert.throws(() => extractDocId('https://feishu.cn/wiki/xxx'), /无法识别/)
  assert.throws(() => extractDocId(''), /无法识别/)
})

test('authUrl embeds app id, redirect uri and state', () => {
  const { client } = setup()
  const url = client.authUrl({ redirectUri: 'https://x.example/lark/auth/callback', state: 'u_abc' })
  assert.match(url, /open-apis\/authen\/v1\/index/)
  assert.match(url, /app_id=app_x/)
  assert.match(url, /redirect_uri=https%3A%2F%2Fx\.example%2Flark%2Fauth%2Fcallback/)
  assert.match(url, /state=u_abc/)
})

test('exchangeCode stores per-user token; ensureToken refreshes when expired', async () => {
  const { file, tokenStore, client } = setup({
    routes: [
      { test: (u) => u.includes('/authen/v1/oidc/access_token'), body: { code: 0, data: { access_token: 'tok-1', refresh_token: 'ref-1', expires_in: 10, refresh_expires_in: 3600 } } },
      { test: (u) => u.includes('/authen/v1/oidc/refresh_access_token'), body: { code: 0, data: { access_token: 'tok-2', refresh_token: 'ref-2', expires_in: 7200, refresh_expires_in: 3600 } } },
    ],
  })
  try {
    await client.exchangeCode({ code: 'auth-code', userId: 'u1' })
    const t = tokenStore.get('u1')
    assert.equal(t.accessToken, 'tok-1')
    assert.equal(t.refreshToken, 'ref-1')
    // 未过期直接用
    assert.equal(await client.ensureToken('u1'), 'tok-1')
    // 手动把 expires_at 拨回过去 → ensureToken 自动刷新
    tokenStore.set({ userId: 'u1', accessToken: 'tok-1', refreshToken: 'ref-1', expiresIn: -10, refreshExpiresIn: 3600 })
    assert.equal(await client.ensureToken('u1'), 'tok-2')
    assert.equal(tokenStore.get('u1').accessToken, 'tok-2')
    // 未授权用户
    await assert.rejects(() => client.ensureToken('u2'), /尚未授权/)
    // refresh token 也过期 → 明确提示重新授权
    tokenStore.set({ userId: 'u1', accessToken: 'x', refreshToken: 'y', expiresIn: -1, refreshExpiresIn: -1 })
    await assert.rejects(() => client.ensureToken('u1'), /重新授权/)
  } finally {
    tokenStore.close(); fs.rmSync(file, { force: true })
  }
})

test('readDoc fetches markdown raw content from a docx link', async () => {
  const { file, tokenStore, client } = setup({
    routes: [
      { test: (u) => u.includes('/authen/v1/oidc/access_token'), body: { code: 0, data: { access_token: 'tok', refresh_token: 'r', expires_in: 7200, refresh_expires_in: 3600 } } },
      { test: (u) => u.includes('/docx/v1/documents/W1abc12345/raw_content'), body: { code: 0, data: { content: '# 标题\n正文内容' } } },
    ],
  })
  try {
    tokenStore.set({ userId: 'u1', accessToken: 'tok', refreshToken: 'r', expiresIn: 7200, refreshExpiresIn: 3600 })
    const r = await client.readDoc('u1', 'https://xxx.feishu.cn/docx/W1abc12345')
    assert.equal(r.docId, 'W1abc12345')
    assert.match(r.content, /# 标题/)
    assert.equal(r.length, r.content.length)
  } finally {
    tokenStore.close(); fs.rmSync(file, { force: true })
  }
})

test('searchDocs / createDoc / appendBlocks hit the right endpoints', async () => {
  const seen = []
  const { file, tokenStore, client } = setup({
    routes: [
      { test: (u) => u.includes('/authen/v1/oidc/access_token'), body: { code: 0, data: { access_token: 'tok', refresh_token: 'r', expires_in: 7200, refresh_expires_in: 3600 } } },
      { test: (u, init) => { seen.push([u, init]); return u.includes('/suite/docs-api/search/object') }, body: { code: 0, data: { entities: [{ docs: { title: 'AI 方案', url: 'https://feishu.cn/docx/D1', obj_type: 'docx' } }, { docs: { title: '周报', url: 'https://feishu.cn/docx/D2', obj_type: 'docx' } }] } } },
      { test: (u, init) => { seen.push([u, init]); return u.includes('/docx/v1/documents') && init.method === 'POST' && !u.includes('/blocks/') }, body: { code: 0, data: { document: { document_id: 'Dnew123456', url: 'https://feishu.cn/docx/Dnew123456' } } } },
      { test: (u, init) => { seen.push([u, init]); return u.includes('/blocks/document/children') }, body: { code: 0, data: { children: [{ block_id: 'b1' }, { block_id: 'b2' }] } } },
    ],
  })
  try {
    tokenStore.set({ userId: 'u1', accessToken: 'tok', refreshToken: 'r', expiresIn: 7200, refreshExpiresIn: 3600 })
    const docs = await client.searchDocs('u1', 'AI', 10)
    assert.equal(docs.length, 2)
    assert.equal(docs[0].title, 'AI 方案')
    const created = await client.createDoc('u1', { title: '新文档' })
    assert.equal(created.documentId, 'Dnew123456')
    const append = await client.appendBlocks('u1', 'Dnew123456', { blocks: [{ content: '第一段' }, { content: '第二段' }] })
    assert.equal(append.appended, 2)
    // 请求带 Bearer token
    const searchReq = seen.find(([u]) => u.includes('search/object'))
    assert.match(searchReq[1].headers.Authorization, /Bearer tok/)
  } finally {
    tokenStore.close(); fs.rmSync(file, { force: true })
  }
})
