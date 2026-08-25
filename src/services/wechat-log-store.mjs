import { DatabaseSync } from 'node:sqlite'

/** Read-only access to the WeChat sync receiver's SQLite file (`messages` +
 * `chat_roster` tables — see wechat-chatlog-dsh/server/receiver.py). No HTTP
 * hop: wechat-agent's container mounts the same file read-only and queries it
 * directly with indexed SQL (see ADR-0007).
 *
 * Access control (per ADR-0007): a user may only see chats their WeChat
 * identity actually belongs to.
 *   - group chats: `chat_roster` has a row for this chat_wxid with their
 *     wxid or display name as a member (pushed from real WeChat group
 *     rosters, not inferred from message content).
 *   - their own 1:1 thread: from the synced account's perspective, "my 1:1
 *     chat with user X" is a `messages` row with `chat_wxid === X's own wxid`
 *     — so a user's own wxid IS their direct-chat identifier. This is also
 *     literally their conversation with 助手 (the synced account), since
 *     that's the account whose data is being read.
 *
 * `ts` in the underlying schema is unix SECONDS; this module's public API
 * works in epoch ms (JS convention) and converts at the boundary.
 */

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 300
const ASSISTANT_CHAT_LABEL = '与助手的对话（私聊）'
const ASSISTANT_ALIASES = new Set(['助手', 'assistant', '私聊', 'assistant_chat'])
const MSG_TYPE_LABELS = { 3: '[图片]', 34: '[语音]', 43: '[视频]', 49: '[分享/文件]', 47: '[表情]', 10000: '[系统消息]' }

export class WechatLogStore {
  #db

  constructor({ file }) {
    if (!file) throw new TypeError('file is required')
    this.#db = new DatabaseSync(file, { readOnly: true })
  }

  /** Chats `identity` ({ wxid, nickname }) may access: their group memberships
   * (from chat_roster) plus their own direct 1:1 thread. Order: groups first
   * (by name), then the direct thread. */
  accessibleChats(identity) {
    const wxid = String(identity?.wxid || '').trim()
    const nickname = String(identity?.nickname || '').trim()
    const out = new Map()
    if (wxid || nickname) {
      const rows = this.#db.prepare(
        `SELECT chat_wxid, MAX(chat_name) AS chat_name FROM chat_roster
         WHERE (? != '' AND member_wxid = ?) OR (? != '' AND member_display = ?)
         GROUP BY chat_wxid ORDER BY chat_name`
      ).all(wxid, wxid, nickname, nickname)
      for (const r of rows) out.set(r.chat_wxid, { chatWxid: r.chat_wxid, name: r.chat_name || r.chat_wxid, isGroup: true })
    }
    if (wxid) {
      out.set(wxid, { chatWxid: wxid, name: ASSISTANT_CHAT_LABEL, isGroup: false })
    }
    return [...out.values()]
  }

  listMyChats(identity) {
    return this.accessibleChats(identity)
  }

  /** Full conversation in one chat, within an optional time range. `chat` may
   * be a chat_wxid, a group name (exact or partial match against accessible
   * chats), or "助手"/"assistant"/"私聊" for the user's own direct thread.
   * Returns { error } if the chat doesn't exist or isn't accessible — deny
   * without revealing whether the chat exists at all. */
  searchChat({ chat, sinceMs, untilMs, limit = DEFAULT_LIMIT } = {}, identity) {
    const chatWxid = this.#resolveChat(chat, identity)
    if (!chatWxid) return { error: 'chat_not_found_or_not_accessible' }
    return this.#queryMessages({ chatWxids: [chatWxid], sinceMs, untilMs, limit })
  }

  /** Messages that "@"-mention `target` (default: the identity's own nickname;
   * pass "助手" to find mentions of the assistant instead), scoped to every
   * chat the identity can access. */
  searchMentions({ target = '', sinceMs, untilMs, limit = DEFAULT_LIMIT } = {}, identity) {
    const label = target && !['我', 'me', '自己'].includes(target)
      ? (ASSISTANT_ALIASES.has(target) ? '助手' : target)
      : String(identity?.nickname || '').trim()
    if (!label) return { error: 'no_target' }
    const chatWxids = this.accessibleChats(identity).map((c) => c.chatWxid)
    if (!chatWxids.length) return { messages: [], truncated: false }
    return this.#queryMessages({ chatWxids, contentLike: `%@${escapeLike(label)}%`, sinceMs, untilMs, limit })
  }

  /** Messages the identity themself sent, either in one chat (`chat` given)
   * or across every chat they can access. */
  searchMyMessages({ chat, sinceMs, untilMs, limit = DEFAULT_LIMIT } = {}, identity) {
    const wxid = String(identity?.wxid || '').trim()
    const nickname = String(identity?.nickname || '').trim()
    if (!wxid && !nickname) return { error: 'no_identity' }
    let chatWxids
    if (chat) {
      const resolved = this.#resolveChat(chat, identity)
      if (!resolved) return { error: 'chat_not_found_or_not_accessible' }
      chatWxids = [resolved]
    } else {
      chatWxids = this.accessibleChats(identity).map((c) => c.chatWxid)
    }
    if (!chatWxids.length) return { messages: [], truncated: false }
    return this.#queryMessages({ chatWxids, senderWxid: wxid, senderDisplay: nickname, sinceMs, untilMs, limit })
  }

  #resolveChat(chat, identity) {
    const q = String(chat || '').trim()
    if (!q) return null
    const accessible = this.accessibleChats(identity)
    if (ASSISTANT_ALIASES.has(q)) {
      const direct = accessible.find((c) => !c.isGroup)
      return direct ? direct.chatWxid : null
    }
    const exact = accessible.find((c) => c.chatWxid === q || c.name === q)
    if (exact) return exact.chatWxid
    const partial = accessible.find((c) => c.name.includes(q))
    return partial ? partial.chatWxid : null
  }

  #queryMessages({ chatWxids, contentLike, senderWxid, senderDisplay, sinceMs, untilMs, limit = DEFAULT_LIMIT }) {
    if (!chatWxids?.length) return { messages: [], truncated: false }
    const clauses = [`chat_wxid IN (${chatWxids.map(() => '?').join(',')})`]
    const params = [...chatWxids]
    if (sinceMs != null) { clauses.push('ts >= ?'); params.push(Math.floor(sinceMs / 1000)) }
    if (untilMs != null) { clauses.push('ts <= ?'); params.push(Math.floor(untilMs / 1000)) }
    if (contentLike) { clauses.push("content LIKE ? ESCAPE '\\'"); params.push(contentLike) }
    if (senderWxid || senderDisplay) {
      const sub = []
      if (senderWxid) { sub.push('sender_wxid = ?'); params.push(senderWxid) }
      if (senderDisplay) { sub.push('sender_display = ?'); params.push(senderDisplay) }
      clauses.push(`(${sub.join(' OR ')})`)
    }
    const cappedLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT))
    const sql = `SELECT chat_wxid, chat_display, ts, sender_wxid, sender_display, msg_type, content
                 FROM messages WHERE ${clauses.join(' AND ')} ORDER BY ts DESC LIMIT ?`
    params.push(cappedLimit + 1)
    const rows = this.#db.prepare(sql).all(...params)
    const truncated = rows.length > cappedLimit
    const page = rows.slice(0, cappedLimit).reverse()
    return {
      truncated,
      messages: page.map((r) => ({
        chatWxid: r.chat_wxid,
        chatName: r.chat_display || r.chat_wxid,
        tsMs: Number(r.ts) * 1000,
        sender: r.sender_display || r.sender_wxid || '',
        content: r.msg_type === 1 ? String(r.content || '') : (MSG_TYPE_LABELS[r.msg_type] || `[不支持的消息类型:${r.msg_type}]`),
      })),
    }
  }
}

/** Escape SQLite LIKE metacharacters (`\`, `%`, `_`) in user-supplied text so
 * it's matched literally; callers wrap the escaped result in their own `%`
 * wildcards (not escaped, by design). */
function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => '\\' + c)
}
