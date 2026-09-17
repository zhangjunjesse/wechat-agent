import { DatabaseSync } from 'node:sqlite'

/** Read-only access to the WeChat sync receiver's SQLite file (`messages` +
 * `chat_roster` tables — see wechat-chatlog-dsh/server/receiver.py). No HTTP
 * hop: wechat-agent's container mounts the same file read-only and queries it
 * directly with indexed SQL (see ADR-0007).
 *
 * Access control (per ADR-0007, tightened by ADR-0032): a user may only see
 * chats their WeChat identity actually belongs to.
 *   - group chats: `chat_roster` has a row for this chat_wxid with their
 *     wxid (or, only when wxid is unknown, their display name) as a member
 *     (pushed from real WeChat group rosters, not inferred from message
 *     content).
 *   - their own 1:1 thread: from the synced account's perspective, "my 1:1
 *     chat with user X" is a `messages` row with `chat_wxid === X's own wxid`
 *     — so a user's own wxid IS their direct-chat identifier. This is also
 *     literally their conversation with 助手 (the synced account), since
 *     that's the account whose data is being read.
 *
 * Matching is **tiered, not OR'd** (ADR-0032): when `identity.wxid` is known,
 * nickname plays no part at all — a wxid match is the only source of truth.
 * Nickname-only matching is a *downgrade path* for identities whose wxid we
 * failed to capture at verification time, and nicknames are not unique (real
 * production data has 4 different verified users sharing the nickname
 * "Z.俊"). So the downgrade path refuses to guess: if the nickname resolves
 * to more than one distinct `member_wxid` in `chat_roster`, that's an
 * unresolvable same-name collision and this returns nothing rather than the
 * union of both people's chats — see `#onAmbiguousNickname`.
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
  #onAmbiguousNickname

  /** `onAmbiguousNickname({ nickname, memberWxids })` fires whenever the
   * nickname-downgrade path (see class doc, ADR-0032) hits a same-name
   * collision and refuses to resolve chats. Return value is empty either
   * way (fail closed) — this callback exists purely so the refusal is
   * *observable* (ops can see "user X is stuck on the ambiguous downgrade
   * path" instead of a silent, unexplained empty chat list). Defaults to
   * `console.error` so production containers surface it in logs even
   * without explicit wiring; tests override it to assert on the reason. */
  constructor({ file, onAmbiguousNickname = defaultAmbiguousNicknameHandler } = {}) {
    if (!file) throw new TypeError('file is required')
    this.#db = new DatabaseSync(file, { readOnly: true })
    this.#onAmbiguousNickname = onAmbiguousNickname
  }

  /** Chats `identity` ({ wxid, nickname }) may access: their group memberships
   * (from chat_roster) plus their own direct 1:1 thread. Order: groups first
   * (by name), then the direct thread.
   *
   * Matching is tiered (ADR-0032): wxid, when present, is the *only* signal
   * used for group membership — nickname is not consulted at all, so a
   * same-named different person can never widen this user's group list.
   * Nickname is used only as a downgrade when wxid is empty, and even then
   * refuses to resolve (returns no groups) if that nickname is ambiguous in
   * `chat_roster` (maps to more than one distinct real member_wxid). */
  accessibleChats(identity) {
    const wxid = String(identity?.wxid || '').trim()
    const nickname = String(identity?.nickname || '').trim()
    const out = new Map()
    if (wxid) {
      const rows = this.#db.prepare(
        `SELECT chat_wxid, MAX(chat_name) AS chat_name FROM chat_roster
         WHERE member_wxid = ? GROUP BY chat_wxid ORDER BY chat_name`
      ).all(wxid)
      for (const r of rows) out.set(r.chat_wxid, { chatWxid: r.chat_wxid, name: r.chat_name || r.chat_wxid, isGroup: true })
      out.set(wxid, { chatWxid: wxid, name: ASSISTANT_CHAT_LABEL, isGroup: false })
    } else if (nickname) {
      const owners = this.#db.prepare(
        `SELECT DISTINCT member_wxid FROM chat_roster WHERE member_display = ?`
      ).all(nickname)
      const distinctWxids = [...new Set(owners.map((o) => String(o.member_wxid || '')).filter(Boolean))]
      if (distinctWxids.length > 1) {
        this.#onAmbiguousNickname?.({ nickname, memberWxids: distinctWxids })
        return []
      }
      const rows = this.#db.prepare(
        `SELECT chat_wxid, MAX(chat_name) AS chat_name FROM chat_roster
         WHERE member_display = ? GROUP BY chat_wxid ORDER BY chat_name`
      ).all(nickname)
      for (const r of rows) out.set(r.chat_wxid, { chatWxid: r.chat_wxid, name: r.chat_name || r.chat_wxid, isGroup: true })
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
    const sql = `SELECT chat_wxid, chat_display, ts, sender_wxid, sender_display, msg_type, content, attachment
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
        attachment: parseAttachment(r.attachment),
      })),
    }
  }

  /** Release the underlying SQLite handle. Needed because the file is a
   * read-only mount owned by another process (wechat-chatlog-dsh) — holding
   * the handle open blocks nothing in production, but tests that create a
   * throwaway db file per case must close it before deleting the file, or
   * Windows refuses the unlink with EBUSY. Safe to call more than once. */
  close() {
    try { this.#db.close() } catch { /* already closed */ }
  }
}

/** ADR-0032 的默认「同名歧义」告警：`console.error` 而不是静默吞掉，即便调用方
 * 没有显式传 `onAmbiguousNickname` 也能在容器日志里看到"某用户被挡在降级路径
 * 上"，而不是查无实据的"怎么突然看不到群了"。 */
function defaultAmbiguousNicknameHandler({ nickname, memberWxids }) {
  console.error(`[wechat-log-store] accessibleChats: nickname "${nickname}" is ambiguous (${memberWxids.length} distinct member_wxid: ${memberWxids.join(', ')}) — refusing to resolve chats, no wxid on this identity to disambiguate (ADR-0032)`)
}

/** `messages.attachment` 是同步端写入的 JSON 文本，按 kind 归一化成结构化对象
 * （ADR-0029）。字段名的权威来源是 wechat-chatlog-dsh receiver.py 的消息渲染段：
 *   image/file/video/voice/sticker → media_id/ext/size/filename/available/reason
 *   （sticker 有的只有 url 没有 media_id）；link → title/url；
 *   quote → reply/quoted_name/quoted_text；merged → title/preview。
 * `thumb`（ADR-0034）：图片类附件当前是否只同步到了缩略图（210×118、几 KB，
 * 视觉模型看不出内容）——采集端原图晚到时会自动补齐，这里只负责如实透传，
 * 不做补全。
 * 白名单透传：未知字段丢弃、非 JSON/缺 kind 一律返回 null（调用方回退到
 * MSG_TYPE_LABELS 占位符），不把原始 JSON 泄给模型层。 */
export function parseAttachment(raw) {
  if (!raw) return null
  let a
  try { a = JSON.parse(String(raw)) } catch { return null }
  if (!a || typeof a !== 'object' || typeof a.kind !== 'string') return null
  const out = { kind: a.kind }
  if (a.media_id != null) out.mediaId = String(a.media_id)
  if (a.available != null) out.available = Boolean(a.available)
  if (a.ext != null) out.ext = String(a.ext)
  if (a.size != null) out.size = Number(a.size)
  if (a.filename != null) out.filename = String(a.filename)
  if (a.url != null) out.url = String(a.url)
  if (a.title != null) out.title = String(a.title)
  if (a.reason != null) out.reason = String(a.reason)
  if (a.reply != null) out.reply = String(a.reply)
  if (a.quoted_name != null) out.quotedName = String(a.quoted_name)
  if (a.quoted_text != null) out.quotedText = String(a.quoted_text)
  if (a.preview != null) out.preview = String(a.preview)
  if (a.thumb != null) out.thumb = Boolean(a.thumb)
  return out
}

/** Escape SQLite LIKE metacharacters (`\`, `%`, `_`) in user-supplied text so
 * it's matched literally; callers wrap the escaped result in their own `%`
 * wildcards (not escaped, by design). */
function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => '\\' + c)
}
