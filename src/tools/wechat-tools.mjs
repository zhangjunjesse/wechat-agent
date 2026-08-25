import { tool } from '@openai/agents'
import { beijingParse, beijingDateTimeStr } from '../services/time.mjs'

const TIME_PARAM = { type: 'string', description: '时间，格式 YYYY-MM-DD HH:mm 或 YYYY-MM-DD（东八区），可留空' }
const LIMIT_DESC = '返回条数，默认 50，最多 300；超出会截断并提示，建议缩小时间范围而不是加大条数'

/** WeChat chat-log search tools. Retrieval only — no analysis/summarization,
 * per the wechat-search skill's stated boundary. userId/profile identity
 * comes from run context, and every method delegates access control to
 * WechatLogStore (a user only ever sees chats their real WeChat identity
 * belongs to — see ADR-0007). */
export function wechatTools({ wechatLogStore }) {
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

  return { wechatListChats, wechatSearchChat, wechatSearchMentions, wechatSearchMyMessages }
}

function formatResult(r, label) {
  if (r.error === 'chat_not_found_or_not_accessible') return `找不到「${label}」，或你不在这个群里，无法查看。`
  if (r.error === 'no_target') return '需要指定查询目标。'
  if (r.error === 'no_identity') return '请先完成身份验证。'
  if (!r.messages.length) return `「${label}」在这个时间范围内没有找到消息。`
  const lines = r.messages.map((m) => `[${beijingDateTimeStr(m.tsMs)}][${m.chatName}][${m.sender}] ${m.content}`)
  if (r.truncated) lines.push(`（结果较多，已截断到最近的记录，建议缩小时间范围获取更早的消息）`)
  return lines.join('\n')
}
