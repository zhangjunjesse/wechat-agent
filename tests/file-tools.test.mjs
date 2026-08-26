import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileTools } from '../src/tools/file-tools.mjs'

// @openai/agents `tool()` wraps execute(): thrown errors are NOT rejected —
// the SDK's default errorFunction turns them into a string returned to the LLM.
// So we assert on the returned message instead of using assert.rejects.
function call(toolFn, input, ctx) {
  return toolFn.invoke(ctx, JSON.stringify(input))
}

test('file tools are sandboxed to the user directory', async () => {
  const root = path.join(os.tmpdir(), `ft-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const tools = fileTools({ root })
  const ctx = { context: { userId: 'u1' } }
  try {
    await call(tools.writeFile, { path: 'notes/a.txt', content: 'hello' }, ctx)
    const content = await call(tools.readFile, { path: 'notes/a.txt' }, ctx)
    assert.equal(content, 'hello')
    const listing = await call(tools.listFiles, { path: '' }, ctx)
    assert.match(listing, /notes/)
    const escaped = await call(tools.readFile, { path: '../other/b.txt' }, ctx)
    assert.match(escaped, /路径越界/)
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch (e) {}
  }
})

test('write_file returns a real download link when issueDownloadLink is wired, and stays silent without it', async () => {
  const root = path.join(os.tmpdir(), `ft-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const ctx = { context: { userId: 'u1' } }
  try {
    const calls = []
    const withLink = fileTools({ root, issueDownloadLink: (userId, relPath) => { calls.push([userId, relPath]); return `https://example.com/files/tok-${relPath}` } })
    const withLinkMsg = await call(withLink.writeFile, { path: 'out/a.csv', content: 'x' }, ctx)
    assert.match(withLinkMsg, /下载链接.*https:\/\/example\.com\/files\/tok-out\/a\.csv/)
    assert.deepEqual(calls, [['u1', 'out/a.csv']])

    const withoutLink = fileTools({ root })
    const noLinkMsg = await call(withoutLink.writeFile, { path: 'out/b.csv', content: 'y' }, ctx)
    assert.equal(noLinkMsg, '已写入 out/b.csv')
    assert.doesNotMatch(noLinkMsg, /下载链接/)
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch (e) {}
  }
})
