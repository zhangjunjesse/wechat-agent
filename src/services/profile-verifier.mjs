import crypto from 'node:crypto'

export function createVerificationCode() {
  return String(crypto.randomInt(100000, 1000000))
}

/** ADR-0032: the message-level `sender_wxid` field is frequently empty for
 * 1:1 chats in production (the sync side apparently only bothers resolving
 * per-message sender identity where it's needed to disambiguate — group
 * chats — and treats the chat itself as sufficient identification for 1:1
 * threads). But per ADR-0007, a 1:1 chat's own `chat_wxid` IS the peer's
 * real wxid. So when the caller tells us which chat this message came from
 * (`chatWxid`) and it's not a group (`@chatroom` suffix — the real WeChat
 * group-id convention, confirmed by wechat-chatlog-dsh's own schema/tests),
 * that's a reliable fallback identity source. Never used for group chats:
 * a group's chat_wxid is not anybody's personal wxid. */
export function findAssistantCode(messages, code, { maxAgeMs = 5 * 60_000, now = Date.now, chatWxid = '' } = {}) {
  const needle = String(code || '').trim()
  if (!needle) return null
  const rows = Array.isArray(messages) ? messages : []
  const cutoff = now() - maxAgeMs
  const match = rows.filter((row) => {
    const ts = Number(row.ts || row.timestamp || 0)
    return String(row.content || '').includes(needle) && (!ts || ts * (ts < 10_000_000_000 ? 1000 : 1) >= cutoff)
  }).sort((a, b) => Number(b.ts || b.timestamp || 0) - Number(a.ts || a.timestamp || 0))[0]
  if (!match) return null
  const chat = String(chatWxid || '').trim()
  const chatFallbackWxid = chat && !chat.endsWith('@chatroom') ? chat : ''
  return { wxid: match.sender_wxid || match.senderWxid || chatFallbackWxid || '', nickname: match.sender_display || match.nickname || '', remark: match.remark || '', messageTs: match.ts || match.timestamp || 0, code: needle }
}
