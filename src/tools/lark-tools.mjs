import { tool } from '@openai/agents'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveUserPath } from '../services/user-sandbox.mjs'

/** 飞书文档工具集（ADR-0021，与 skills/lark-docs 技能配合：工具做原子 API，
 * 技能做编排 SOP）。按 user_id 取各自 token，严格隔离。
 *
 * 条件注册：仅在配置了 LARK_APP_ID/LARK_APP_SECRET 时由 buildTools 注入；
 * 未配置时整套不注册（服务器行为零变化）。
 *
 * 写操作（lark_create_doc/lark_edit_doc）工具描述强制：执行前必须用 ask_user
 * 向用户复述将要做的改动并等用户确认——重要操作先确认是产品约定。 */
export function larkTools({ client, redirectUri, root = process.env.USER_FILES_ROOT || 'data/user-files' } = {}) {
  const authUrlFor = (userId) => client.authUrl({ redirectUri, state: userId })

  const larkAuth = tool({
    name: 'lark_auth',
    description:
      '发起飞书授权：返回授权链接，用户打开并同意后，助手即可代表用户读写其飞书文档。' +
      '用户说"连接飞书""绑定飞书""授权飞书文档"时使用；未授权时其他 lark_* 工具会提示先调用本工具。',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async (_input, ctx) => {
      const userId = ctx?.context?.userId
      if (!client) return '飞书功能未启用（服务器未配置 LARK_APP_ID/LARK_APP_SECRET）。'
      try {
        const url = authUrlFor(userId)
        return `请打开下面的链接授权飞书（授权后回复"已完成"）：\n${url}`
      } catch (e) {
        return `发起授权失败：${e.message}`
      }
    },
  })

  const larkAuthStatus = tool({
    name: 'lark_auth_status',
    description: '查看当前用户是否已授权飞书（以及授权是否临近过期）。',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async (_input, ctx) => {
      const userId = ctx?.context?.userId
      if (!client) return '飞书功能未启用（服务器未配置 LARK_APP_ID/LARK_APP_SECRET）。'
      const t = client.tokenStore?.get(userId)
      if (!t?.accessToken) return '尚未授权飞书。回复"连接飞书"即可开始授权。'
      const hours = Math.round((t.expiresAt - Date.now()) / 3600_000)
      return hours > 0 ? `已授权飞书（access token 剩余约 ${hours} 小时，自动刷新）。` : '飞书授权已过期，请重新授权（回复"连接飞书"）。'
    },
  })

  const larkSearchDocs = tool({
    name: 'lark_search_docs',
    description:
      '搜索用户可访问的飞书文档（按关键词），返回文档标题/链接/类型。' +
      '用户说"找到我飞书里关于 XX 的文档""搜索我的 XX 文档"时使用；搜到后用 lark_read_doc 读内容。',
    parameters: {
      type: 'object',
      properties: { keyword: { type: 'string', description: '搜索关键词' }, count: { type: 'number', description: '返回条数，默认 10，最多 20' } },
      required: ['keyword'],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      if (!client) return '飞书功能未启用（服务器未配置 LARK_APP_ID/LARK_APP_SECRET）。'
      try {
        const items = await client.searchDocs(userId, input.keyword, Number(input.count) || 10)
        if (!items.length) return `没有找到包含「${input.keyword}」的文档，换个关键词试试。`
        return `找到 ${items.length} 个文档：\n` + items.map((d, i) => `${i + 1}. ${d.title}\n   ${d.url}`).join('\n')
      } catch (e) {
        return `搜索失败：${e.message}`
      }
    },
  })

  const larkReadDoc = tool({
    name: 'lark_read_doc',
    description:
      '读取一个飞书文档的正文（支持文档链接或文档 id），返回 markdown 文本。' +
      '用户说"读一下这个文档""看看我飞书里 XX 文档写了什么"时使用。内容过长时会截断并提示。',
    parameters: {
      type: 'object',
      properties: { doc: { type: 'string', description: '飞书文档链接或文档 id' }, maxLen: { type: 'number', description: '最多返回字符数，默认 6000' } },
      required: ['doc'],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      if (!client) return '飞书功能未启用（服务器未配置 LARK_APP_ID/LARK_APP_SECRET）。'
      try {
        const { docId, content, length } = await client.readDoc(userId, input.doc)
        const max = Math.max(500, Number(input.maxLen) || 6000)
        const body = content.length > max ? `${content.slice(0, max)}\n…（内容过长已截断，全文 ${length} 字，可要求分段读取）` : content
        return `文档 ${docId}（${length} 字）：\n\n${body || '(空文档)'}`
      } catch (e) {
        return `读取失败：${e.message}`
      }
    },
  })

  const larkCreateDoc = tool({
    name: 'lark_create_doc',
    description:
      '新建一个飞书云文档（可选初始内容）。创建前必须先用 ask_user 与用户确认文档标题和要写入的内容概要，用户确认后才执行。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '文档标题' },
        content: { type: 'string', description: '初始内容（纯文本，多段用换行分隔；可选）' },
      },
      required: ['title'],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      if (!client) return '飞书功能未启用（服务器未配置 LARK_APP_ID/LARK_APP_SECRET）。'
      try {
        const doc = await client.createDoc(userId, { title: input.title })
        let extra = ''
        if (input.content) {
          const blocks = String(input.content).split('\n').filter((l) => l.trim()).map((content) => ({ content }))
          await client.appendBlocks(userId, doc.documentId, { blocks })
          extra = `（已写入 ${blocks.length} 段内容）`
        }
        return `已创建文档「${input.title}」${extra}\n${doc.url}`
      } catch (e) {
        return `创建失败：${e.message}`
      }
    },
  })

  const larkEditDoc = tool({
    name: 'lark_edit_doc',
    description:
      '编辑一个飞书文档：向文档末尾追加内容，或将指定文档的正文追加段落。' +
      '执行前必须先用 ask_user 向用户复述"将向文档 <标题/链接> 追加以下内容：<内容>"并等用户确认，用户确认后才执行；用户没确认绝不能改。',
    parameters: {
      type: 'object',
      properties: {
        doc: { type: 'string', description: '飞书文档链接或文档 id' },
        content: { type: 'string', description: '要追加的内容（纯文本，多段用换行分隔）' },
      },
      required: ['doc', 'content'],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      if (!client) return '飞书功能未启用（服务器未配置 LARK_APP_ID/LARK_APP_SECRET）。'
      try {
        const blocks = String(input.content).split('\n').filter((l) => l.trim()).map((content) => ({ content }))
        const { appended } = await client.appendBlocks(userId, input.doc, { blocks })
        return `已向文档追加 ${appended} 段内容。`
      } catch (e) {
        return `编辑失败：${e.message}`
      }
    },
  })

  const larkExportDoc = tool({
    name: 'lark_export_doc',
    description:
      '把一个飞书云文档导出成文件（默认 pdf，可选 docx），保存到用户文件目录并返回路径。' +
      '用户说"把这个飞书文档下载给我""导出成 PDF 发我""把这个文档发我一份"时使用；' +
      '导出完成后**必须调用 send_file** 把文件作为真实消息发给用户。' +
      '⚠️ **慢工具**：导出是异步任务 + 轮询，通常 10–60 秒，**单次调用就会把当前对话卡住**（不要拿"我只调了一次工具"来判断它快）。' +
      '所以：若你在主对话里（有 task_create 可用）→ 先把这件事建成板上任务交给后台，由后台执行时调用本工具；' +
      '若你本身就是那个后台子任务在执行导出 → 直接调用本工具，耐心等到返回。',
    parameters: {
      type: 'object',
      properties: {
        doc: { type: 'string', description: '飞书文档链接或文档 id' },
        format: { type: 'string', enum: ['pdf', 'docx'], description: '导出格式，默认 pdf' },
      },
      required: ['doc'],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      if (!client) return '飞书功能未启用（服务器未配置 LARK_APP_ID/LARK_APP_SECRET）。'
      try {
        const ext = input.format === 'docx' ? 'docx' : 'pdf'
        const { fileName, buffer } = await client.exportDoc(userId, input.doc, { ext })
        const rel = `files/${fileName}`
        const full = resolveUserPath(root, userId, rel)
        await fs.mkdir(path.dirname(full), { recursive: true })
        await fs.writeFile(full, buffer)
        return `已导出「${fileName}」（${Math.round(buffer.length / 1024)} KB），文件路径：${rel}\n请调用 send_file 把该文件发给用户。`
      } catch (e) {
        return `导出失败：${e.message}`
      }
    },
  })

  return { larkAuth, larkAuthStatus, larkSearchDocs, larkReadDoc, larkCreateDoc, larkEditDoc, larkExportDoc }
}
