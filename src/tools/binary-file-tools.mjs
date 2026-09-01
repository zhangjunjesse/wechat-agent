import { tool } from '@openai/agents'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveUserPath } from '../services/user-sandbox.mjs'
import { makeXlsx, makeDocx, makePdf } from '../services/office-generators.mjs'

export function binaryFileTools({ root = process.env.USER_FILES_ROOT || 'data/user-files', issueDownloadLink } = {}) {
  const createXlsx = tool({
    name: 'create_xlsx',
    description: '把二维表格数据生成真正的二进制 .xlsx Excel 文件。不要把 CSV 冒充 xlsx；生成后在微信对话中必须调用 send_file 发送。',
    parameters: { type: 'object', properties: { path: { type: 'string' }, rows: { type: 'array', items: { type: 'array', items: {} } } }, required: ['path', 'rows'] },
    execute: async (input, ctx) => writeBinary(root, issueDownloadLink, ctx, input.path, makeXlsx(input.rows), 'xlsx'),
  })
  const createDocx = tool({
    name: 'create_docx',
    description: '把标题和段落生成真正的二进制 .docx Word 文件。生成后在微信对话中必须调用 send_file 发送。',
    parameters: { type: 'object', properties: { path: { type: 'string' }, title: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' } } }, required: ['path', 'paragraphs'] },
    execute: async (input, ctx) => writeBinary(root, issueDownloadLink, ctx, input.path, makeDocx(input), 'docx'),
  })
  const createPdf = tool({
    name: 'create_pdf',
    description: '把标题和文本生成二进制 .pdf 文件。生成后在微信对话中必须调用 send_file 发送。',
    parameters: { type: 'object', properties: { path: { type: 'string' }, title: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'text'] },
    execute: async (input, ctx) => writeBinary(root, issueDownloadLink, ctx, input.path, makePdf(input), 'pdf'),
  })
  return { createXlsx, createDocx, createPdf }
}

async function writeBinary(root, issueDownloadLink, ctx, relPath, buffer, ext) {
  const userId = ctx?.context?.userId
  const requested = String(relPath || '').trim()
  if (!requested.toLowerCase().endsWith(`.${ext}`)) throw new Error(`路径必须以 .${ext} 结尾`)
  const full = resolveUserPath(root, userId, requested)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, buffer)
  const link = issueDownloadLink?.(userId, requested)
  return link ? `已生成 ${requested}（${buffer.length} 字节），下载链接：${link}` : `已生成 ${requested}（${buffer.length} 字节）`
}
