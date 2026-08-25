import { tool } from '@openai/agents'
import fs from 'node:fs/promises'
import path from 'node:path'

/** Sandboxed file tools scoped to one user's documents directory.
 * Paths are resolved against `<root>/<userId>/` and must stay inside it.
 * Returns tool definitions whose execute() reads the userId from run context. */
export function fileTools({ root = process.env.USER_FILES_ROOT || 'data/user-files' } = {}) {
  const base = path.resolve(root)
  const resolve = (userId, relPath) => {
    const userRoot = path.join(base, String(userId))
    const full = path.resolve(userRoot, String(relPath || ''))
    if (!full.startsWith(userRoot + path.sep) && full !== userRoot) {
      throw new Error('路径越界：只能访问你自己的文件目录')
    }
    return full
  }

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
    description: '在用户自己目录下写入一个文本文件（用于整理资料、生成笔记/文档等）',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    execute: async (input, ctx) => {
      const full = resolve(ctx?.context?.userId, input.path)
      await fs.mkdir(path.dirname(full), { recursive: true })
      await fs.writeFile(full, input.content, 'utf8')
      return `已写入 ${input.path}`
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
