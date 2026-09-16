import { tool } from '@openai/agents'
import { GROUP_TAGS, GROUP_TAG_LABELS } from '../services/group-profile-store.mjs'

/** 群画像工具（DESIGN-wechat-digest.md）：让用户在**对话里**纠正群性质，
 * 而不是去某个设置页面改配置。
 *
 * 为什么必须有这两个工具：自动打标一定会错——"XX 项目群"可能其实是纯通知群，
 * "家族群"可能才是真正谈生意的地方。错了之后用户唯一自然的表达是"XX 群是工作
 * 群，别当闲聊处理"，这句话必须能落到数据上，否则下一期照错不误，用户就再也
 * 不会说第二次了。写入一律 `source='user'`，之后自动打标**永不覆盖**
 * （不变量在 GroupProfileStore.put 里兜底，不依赖调用方自觉）。
 *
 * 权限边界与 wechat_* 工具完全一致：群只能从
 * `wechatLogStore.accessibleChats(identity)` 里解析（ADR-0007），用户无法给
 * 一个自己不在的群打标——那既是越权，也会让别人的 digest 被污染。 */
export function groupTagTools({ groupProfiles, wechatLogStore }) {
  const identityOf = (ctx) => ({ wxid: ctx?.context?.profile?.wxid || '', nickname: ctx?.context?.profile?.nickname || '' })

  /** 把用户说的群名解析成 accessibleChats 里的那个群（精确 → 部分匹配）。
   * 解析不到就是"不存在或你不在这个群"，不区分两者（不泄露群是否存在）。 */
  const resolveChat = (name, identity) => {
    const q = String(name || '').trim()
    if (!q) return null
    const chats = wechatLogStore.accessibleChats(identity).filter((c) => c.isGroup)
    return chats.find((c) => c.chatWxid === q || c.name === q) || chats.find((c) => c.name.includes(q)) || null
  }

  const listGroupTags = tool({
    name: 'list_group_tags',
    description:
      '列出我的微信群目前被判定成什么性质（工作/家人/朋友/兴趣/通知/交易/死群），以及是自动判的还是我自己设的。' +
      '微信日报/周报按这个性质决定从每个群里捞什么内容。用户问"你是怎么分类我的群的""日报为什么没捞到 XX 群的事"时使用。',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async (_input, ctx) => {
      const userId = ctx?.context?.userId
      const identity = identityOf(ctx)
      const chats = wechatLogStore.accessibleChats(identity).filter((c) => c.isGroup)
      if (!chats.length) return '没有可查看的群（可能尚未完成身份验证，或还没有同步到群聊记录）。'
      const byId = new Map(groupProfiles.list(userId).map((r) => [r.chatWxid, r]))
      const lines = chats.map((c) => {
        const row = byId.get(c.chatWxid)
        if (!row) return `- ${c.name}：尚未分类（下次生成微信日报时会自动判一次）`
        return `- ${c.name}：${GROUP_TAG_LABELS[row.tag] || row.tag}（${row.source === 'user' ? '你设定的' : '自动判定'}）`
      })
      return `你的群分类：\n${lines.join('\n')}\n\n判错了直接告诉我，比如「XX群是工作群」，我改了之后自动判定就不会再覆盖它。`
    },
  })

  const setGroupTag = tool({
    name: 'set_group_tag',
    description:
      '修正某个微信群的性质分类，影响微信日报/周报从这个群里捞什么内容。' +
      '用户说"XX群是工作群""XX群就是个通知群，别给我推闲聊""XX群已经死了，不用看"这类话时使用。' +
      `可选性质：${GROUP_TAGS.map((t) => `${t}(${GROUP_TAG_LABELS[t]})`).join('、')}。` +
      '设定后自动分类不会再覆盖它。',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: '群名称（可以是部分名称，会在我所在的群里匹配）' },
        tag: { type: 'string', description: `群性质：${GROUP_TAGS.join(' / ')}`, enum: GROUP_TAGS },
      },
      required: ['chat', 'tag'],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      const identity = identityOf(ctx)
      if (!identity.wxid && !identity.nickname) return '请先完成身份验证。'
      if (!GROUP_TAGS.includes(input.tag)) {
        return `不认识的性质「${input.tag}」。可选：${GROUP_TAGS.map((t) => `${t}（${GROUP_TAG_LABELS[t]}）`).join('、')}`
      }
      const chat = resolveChat(input.chat, identity)
      if (!chat) return `找不到「${input.chat}」，或你不在这个群里。可以先用 list_group_tags 看看有哪些群。`
      try {
        // confidence=1：用户说的，没有"把握程度"可言。
        groupProfiles.put({ userId, chatWxid: chat.chatWxid, chatName: chat.name, tag: input.tag, confidence: 1, source: 'user' })
      } catch (e) {
        return `设置失败：${e.message}`
      }
      const extra = input.tag === 'dead' ? '以后微信日报会直接跳过这个群。' : `以后微信日报会按「${GROUP_TAG_LABELS[input.tag]}」的侧重从这个群里捞内容。`
      return `已把「${chat.name}」设为${GROUP_TAG_LABELS[input.tag]}群。${extra}自动分类不会再覆盖它。`
    },
  })

  return { listGroupTags, setGroupTag }
}
