import crypto from 'node:crypto'

export function createVerificationCode() {
  return `WA-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
}

export function findAssistantCode(messages, code, { maxAgeMs = 5 * 60_000, now = Date.now } = {}) {
  const needle = String(code || '').trim()
  if (!needle) return null
  const rows = Array.isArray(messages) ? messages : []
  const cutoff = now() - maxAgeMs
  const match = rows.filter((row) => {
    const ts = Number(row.ts || row.timestamp || 0)
    return String(row.content || '').includes(needle) && (!ts || ts * (ts < 10_000_000_000 ? 1000 : 1) >= cutoff)
  }).sort((a, b) => Number(b.ts || b.timestamp || 0) - Number(a.ts || a.timestamp || 0))[0]
  if (!match) return null
  return { wxid: match.sender_wxid || match.senderWxid || '', nickname: match.sender_display || match.nickname || '', remark: match.remark || '', messageTs: match.ts || match.timestamp || 0, code: needle }
}
