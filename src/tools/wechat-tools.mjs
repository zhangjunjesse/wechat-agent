import { tool } from '@openai/agents'
import { beijingParse, beijingDateTimeStr } from '../services/time.mjs'
import { fetchChatMedia } from '../services/wechat-media.mjs'

const TIME_PARAM = { type: 'string', description: '时间，格式 YYYY-MM-DD HH:mm 或 YYYY-MM-DD（东八区），可留空' }
const LIMIT_DESC = '返回条数，默认 50，最多 300；超出会截断并提示，建议缩小时间范围而不是加大条数'

/** 可以取回落地文件的附件 kind（media_id 指向 wechat-sync 媒体目录里的真身）。
 * link/quote/merged 没有文件可取；sticker 有 media_id 的走文件、只有 url 的直接给 url。 */
const FETCHABLE_KINDS = new Set(['image', 'file', 'video', 'voice', 'sticker'])

/** WeChat chat-log search tools. Retrieval only — no analysis/summarization,
 * per the wechat-search skill's stated boundary. userId/profile identity
 * comes from run context, and every method delegates access control to
 * WechatLogStore (a user only ever sees chats their real WeChat identity
 * belongs to — see ADR-0007).
 *
 * `root`/`mediaDir` 供 wechat_fetch_chat_file（ADR-0029）：把历史消息附件从
 * wechat-sync 媒体目录拷进用户自己的沙箱 inbox/。 */
export function wechatTools({ wechatLogStore, root, mediaDir, fetchMedia = fetchChatMedia }) {
  const identityOf = (ctx) => ({ wxid: ctx?.context?.profile?.wxid || '', nickname: ctx?.context?.profile?.nickname || '' })
  const range = (input) => ({
    sinceMs: input.start ? beijingParse(input.start) ?? undefined : undefined,
    untilMs: input.end ? beijingParse(input.end, { endOfDay: true }) ?? undefined : undefined,
  })

  const wechatListChats = tool({
    name: 'wechat_list_chats',
    description: '列出我在微信中参与的所有群组和与助手的私聊（只返回我实际在的会话，无法查看不属于我的群）',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async (_input, ctx) => {
      const chats = wechatLogStore.listMyChats(identityOf(ctx))
      if (!chats.length) return '暂无可查看的会话（可能尚未完成身份验证，或还没有同步到相关记录）'
      return chats.map((c) => `- ${c.name}${c.isGroup ? '（群聊）' : '（私聊）'}`).join('\n')
    },
  })

  const wechatSearchChat = tool({
    name: 'wechat_search_chat',
    description: '查询指定微信群组（或与助手的私聊）在某个时间范围内的完整对话。chat 填群名或"助手"。只能查我自己在的群',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: '群名称，或"助手"表示与助手的私聊' },
        start: TIME_PARAM, end: TIME_PARAM,
        limit: { type: 'number', description: LIMIT_DESC },
      },
      required: ['chat'],
    },
    execute: async (input, ctx) => {
      const r = wechatLogStore.searchChat({ chat: input.chat, ...range(input), limit: input.limit }, identityOf(ctx))
      return formatResult(r, input.chat)
    },
  })

  const wechatSearchMentions = tool({
    name: 'wechat_search_mentions',
    description: '查询"被@"的消息，返回所在群组和完整原文。target 默认查@我，也可以传"助手"查@助手的消息。只在我自己所在的群里查',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '被@的对象，默认"我"，也可传"助手"' },
        start: TIME_PARAM, end: TIME_PARAM,
        limit: { type: 'number', description: LIMIT_DESC },
      },
      required: [],
    },
    execute: async (input, ctx) => {
      const r = wechatLogStore.searchMentions({ target: input.target, ...range(input), limit: input.limit }, identityOf(ctx))
      return formatResult(r, `@${input.target || '我'}`)
    },
  })

  const wechatSearchMyMessages = tool({
    name: 'wechat_search_my_messages',
    description: '查询我自己发送过的消息，可选限定某个群组，否则查我所在的所有会话',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: '可选，限定某个群名称或"助手"；不填则查所有我在的会话' },
        start: TIME_PARAM, end: TIME_PARAM,
        limit: { type: 'number', description: LIMIT_DESC },
      },
      required: [],
    },
    execute: async (input, ctx) => {
      const r = wechatLogStore.searchMyMessages({ chat: input.chat, ...range(input), limit: input.limit }, identityOf(ctx))
      return formatResult(r, input.chat || '我参与的会话')
    },
  })

  const wechatFetchChatFile = tool({
    name: 'wechat_fetch_chat_file',
    description:
      '把历史聊天消息里的附件（图片/文件/视频/语音/表情）取回到我的文件目录 inbox/，' +
      '之后可直接用 read_file 查看、image_describe/image_generate 处理、send_file 发送。' +
      '定位方式是"会话 + 消息时间"：time 照抄 wechat_search_chat 等搜索结果里那条消息显示的时间戳，' +
      '同一分钟内的附件会全部取回（最多 5 个，可用 filename 过滤）。' +
      '分享链接（link）没有文件，直接返回 url；标记"未同步"的附件会如实说明取不到的原因；' +
      '图片如果目前只同步到了缩略图会明确提示（缩略图很小很糊，看不出内容，别直接拿去 image_describe）。' +
      '只能取我自己所在群/私聊里的附件（与搜索工具同一套权限边界）。',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: '群名称或"助手"（与 wechat_search_chat 的 chat 相同）' },
        time: { type: 'string', description: '消息时间，格式 YYYY-MM-DD HH:mm（东八区），照抄搜索结果里该消息的时间戳' },
        filename: { type: 'string', description: '可选，同一分钟有多个附件时按文件名过滤' },
      },
      required: ['chat', 'time'],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      const tsMs = beijingParse(input.time)
      if (tsMs == null) return '时间格式不对，请用 YYYY-MM-DD HH:mm（照抄搜索结果里该消息的时间戳）。'
      // 关键安全设计（ADR-0029）：不接受任何裸 media_id 参数——附件只能从
      // "重新过一遍 accessibleChats 租户校验后我自己能看到的消息"里解析出来，
      // 防止全局 media_id 穿透"用户只能看自己所在会话"的边界（ADR-0007）。
      const r = wechatLogStore.searchChat({ chat: input.chat, sinceMs: tsMs, untilMs: tsMs + 59_999, limit: 50 }, identityOf(ctx))
      if (r.error === 'chat_not_found_or_not_accessible') return `找不到「${input.chat}」，或你不在这个群里，无法查看。`
      if (r.error) return `查询失败：${r.error}`
      let candidates = (r.messages || []).filter((m) => m.attachment)
      if (input.filename) candidates = candidates.filter((m) => (m.attachment.filename || '').includes(input.filename))
      if (!candidates.length) return `「${input.chat}」在 ${input.time} 这一分钟内没有找到带附件的消息（时间请精确照抄搜索结果里的时间戳）。`

      const out = []
      let fetched = 0
      for (const m of candidates) {
        const a = m.attachment
        if (a.kind === 'link') { out.push(`[链接] ${[a.title, a.url].filter(Boolean).join(' ')}（无需取文件，url 可直接访问）`); continue }
        if (a.kind === 'quote') { out.push(`[引用回复] ${a.quotedName ? `${a.quotedName}：` : ''}${a.quotedText || ''}`); continue }
        if (a.kind === 'sticker' && !a.mediaId && a.url) { out.push(`[表情] ${a.url}（无需取文件，url 可直接访问）`); continue }
        if (!FETCHABLE_KINDS.has(a.kind)) { out.push(`[${a.kind}] 该类型附件暂不支持取回文件。`); continue }
        if (a.available === false) {
          out.push(`「${a.filename || labelOf(a.kind)}」还没同步完成，暂时取不到${a.reason ? `：${a.reason}` : ''}。`)
          continue
        }
        if (fetched >= 5) { out.push('（这一分钟附件较多，只取回前 5 个；如需其他请用 filename 精确指定）'); break }
        try {
          const f = await fetchMedia({ attachment: a, mediaDir, userId, root })
          fetched++
          const thumbNote = a.thumb
            ? '（⚠️ 现在同步到的还只是缩略图，很小很糊，基本看不出内容——建议让对方在微信里点开这张图看一眼，原图同步过来后再重新取一次）'
            : ''
          out.push(`已取回${labelOf(f.kind)}：${f.path}（${f.name}，${formatSize(f.size)}）${thumbNote}`)
        } catch (e) {
          out.push(`「${a.filename || labelOf(a.kind)}」取回失败：${e.message}`)
        }
      }
      return out.join('\n')
    },
  })

  return { wechatListChats, wechatSearchChat, wechatSearchMentions, wechatSearchMyMessages, wechatFetchChatFile }
}

function formatResult(r, label) {
  if (r.error === 'chat_not_found_or_not_accessible') return `找不到「${label}」，或你不在这个群里，无法查看。`
  if (r.error === 'no_target') return '需要指定查询目标。'
  if (r.error === 'no_identity') return '请先完成身份验证。'
  if (!r.messages.length) return `「${label}」在这个时间范围内没有找到消息。`
  const lines = r.messages.map((m) => `[${beijingDateTimeStr(m.tsMs)}][${m.chatName}][${m.sender}] ${renderBody(m)}`)
  if (r.messages.some((m) => hasFetchableFile(m.attachment))) {
    lines.push('（带附件的消息可用 wechat_fetch_chat_file 取回文件到我的文件目录，参数照抄该消息的会话和时间戳）')
  }
  if (r.truncated) lines.push(`（结果较多，已截断到最近的记录，建议缩小时间范围获取更早的消息）`)
  return lines.join('\n')
}

/** 非文本消息按附件 kind 渲染有意义的描述（文件名/大小/url/引用原文），不再是
 * 干巴巴的 [图片] 占位符（ADR-0029）；无附件信息时回退到 store 给的占位 content。 */
function renderBody(m) {
  const a = m.attachment
  if (!a) return m.content
  switch (a.kind) {
    case 'image':
      return a.available === false
        ? `[图片·未同步${a.reason ? `：${a.reason}` : ''}]`
        : `[图片${a.ext ? ` ${a.ext}` : ''}${a.size ? ` ${formatSize(a.size)}` : ''}${a.thumb ? '·目前只有缩略图，看不清内容' : ''}]`
    case 'file':
      return a.available === false
        ? `[文件·未同步 ${a.filename || ''}${a.reason ? `：${a.reason}` : ''}]`
        : `[文件 ${a.filename || ''}${a.size ? ` ${formatSize(a.size)}` : ''}]`
    case 'video':
      return a.available === false ? '[视频·未同步]' : `[视频${a.size ? ` ${formatSize(a.size)}` : ''}]`
    case 'voice':
      return a.available === false ? '[语音·未同步]' : `[语音${a.size ? ` ${formatSize(a.size)}` : ''}]`
    case 'sticker':
      return a.url && !a.mediaId ? `[表情 ${a.url}]` : '[表情]'
    case 'link':
      return `[链接] ${[a.title, a.url].filter(Boolean).join(' ')}`
    case 'quote':
      return `${a.reply || m.content}（引用${a.quotedName ? ` ${a.quotedName}` : ''}：${a.quotedText || ''}）`
    case 'merged':
      return `[合并转发的聊天记录 ${a.title || ''}]`
    default:
      return m.content
  }
}

function hasFetchableFile(a) {
  return Boolean(a && FETCHABLE_KINDS.has(a.kind) && a.available !== false && (a.mediaId || a.kind !== 'sticker'))
}

function labelOf(kind) {
  return { image: '图片', file: '文件', video: '视频', voice: '语音', sticker: '表情' }[kind] || '附件'
}

function formatSize(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`
  if (n >= 1024) return `${Math.round(n / 1024)}KB`
  return `${n}B`
}
