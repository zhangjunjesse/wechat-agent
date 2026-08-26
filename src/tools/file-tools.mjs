import { tool } from '@openai/agents'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveUserPath } from '../services/user-sandbox.mjs'

/** Sandboxed file tools scoped to one user's documents directory.
 * Paths are resolved against `<root>/<userId>/` and must stay inside it.
 * Returns tool definitions whose execute() reads the userId from run context.
 *
 * `issueDownloadLink(userId, relPath)` is optional: when provided, write_file
 * returns a real, fetchable URL for the file it just wrote (see
 * services/download-tokens.mjs + ADR-0008). This is the UNIVERSAL delivery
 * path — works from the web chat (no WeChat session to send through) and as
 * a fallback everywhere. On WeChat specifically, prefer the send_file tool
 * (ADR-0009) for a real file attachment instead of a link the user has to tap
 * out of the conversation. */
export function fileTools({ root = process.env.USER_FILES_ROOT || 'data/user-files', issueDownloadLink } = {}) {
  const resolve = (userId, relPath) => resolveUserPath(root, userId, relPath)

  const readFile = tool({
    name: 'read_file',
    description: '读取用户自己目录下的文本文件内容',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '相对路径，如 notes/meeting.txt' } }, required: ['path'] },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      const full = resolve(userId, input.path)
      const data = await fs.readFile(full, 'utf8')
      return data.length > 12000 ? data.slice(0, 12000) + '\n...(截断)' : data
    },
  })

  const writeFile = tool({
    name: 'write_file',
    description: '在用户自己目录下写入一个文本文件（用于整理资料、生成笔记/CSV/文档等）。写完后如果当前对话是微信，优先用 send_file 把这个文件直接发给用户；如果是网页对话或 send_file 不可用，就把这里返回的下载链接原样发给用户。不要说"已经发给你"这类没有对应动作的话——要么真的调用了 send_file，要么给的是链接。若内容是给 Excel 打开的 CSV 且含中文，请在 content 开头加 \\uFEFF（BOM）避免乱码。',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      const full = resolve(userId, input.path)
      await fs.mkdir(path.dirname(full), { recursive: true })
      await fs.writeFile(full, input.content, 'utf8')
      const link = issueDownloadLink?.(userId, input.path)
      return link ? `已写入 ${input.path}，下载链接（有效期内可打开）：${link}` : `已写入 ${input.path}`
    },
  })

  const listFiles = tool({
    name: 'list_files',
    description: '列出用户自己目录下的文件',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '相对路径，留空表示根目录' } }, required: [] },
    execute: async (input, ctx) => {
      const full = resolve(ctx?.context?.userId, input.path || '')
      const entries = await fs.readdir(full, { withFileTypes: true })
      return entries.map((e) => `${e.isDirectory() ? '[目录]' : '      '} ${e.name}`).join('\n') || '(空目录)'
    },
  })

  return { readFile, writeFile, listFiles }
}
