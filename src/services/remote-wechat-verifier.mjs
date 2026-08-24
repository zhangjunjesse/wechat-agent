import crypto from 'node:crypto'
import { findAssistantCode } from './profile-verifier.mjs'

export class RemoteWechatVerifier {
  #baseUrl; #accessKey; #fetch; #now
  constructor({ baseUrl, accessKey, fetchImpl = globalThis.fetch, now = () => Date.now() }) { if (!baseUrl || !accessKey || typeof fetchImpl !== 'function') throw new TypeError('baseUrl, accessKey and fetchImpl are required'); this.#baseUrl = baseUrl.replace(/\/$/, ''); this.#accessKey = accessKey; this.#fetch = fetchImpl; this.#now = now }
  createTask({ ilinkUserId, ttlMs = 5 * 60_000 }) { return { id: `verify-${Date.now().toString(36)}`, ilinkUserId, code: String(crypto.randomInt(100000, 1000000)), expiresAt: this.#now() + ttlMs, status: 'pending' } }
  async checkTask(task) {
    if (!task || task.expiresAt <= this.#now()) return { ...task, status: 'expired' }
    const chats = await this.#get('/wechat-api/chats')
    const chat = (chats.chats || []).find((x) => x.chat_display === '助手' || x.chat_display?.includes('助手') || x.chat_wxid === '助手' || x.chat_wxid === 'filehelper')
    if (!chat) return { ...task, status: 'assistant_not_found' }
    const messages = await this.#get(`/wechat-api/messages?chat=${encodeURIComponent(chat.chat_wxid)}&limit=500`)
    let match = findAssistantCode(messages.messages || [], task.code, { now: this.#now })
    // The sync connector may temporarily expose the contact under a different
    // display name. If the named chat has no match, search recent chats for the
    // one-time code; the code itself remains the binding proof.
    if (!match) {
      for (const candidate of chats.chats || []) {
        if (candidate.chat_wxid === chat.chat_wxid) continue
        const candidateMessages = await this.#get(`/wechat-api/messages?chat=${encodeURIComponent(candidate.chat_wxid)}&limit=200`)
        match = findAssistantCode(candidateMessages.messages || [], task.code, { now: this.#now })
        if (match) break
      }
    }
    return match ? { ...task, status: 'verified', profile: match } : { ...task, status: 'pending' }
  }
  async recentForProfile(profile, { limit = 80 } = {}) {
    const chats = await this.#get('/wechat-api/chats'); const rows = []
    for (const chat of chats.chats || []) { const messages = await this.#get(`/wechat-api/messages?chat=${encodeURIComponent(chat.chat_wxid)}&limit=${Math.min(limit, 200)}`); for (const message of messages.messages || []) rows.push({ ...message, chat: chat.chat_display || chat.chat_wxid }) }
    const nick = String(profile?.nickname || '').trim(); const wxid = String(profile?.wxid || '').trim()
    return rows.filter((m) => { const sender = `${m.sender_wxid || ''} ${m.sender_display || ''}`; const content = String(m.content || ''); return (wxid && sender.includes(wxid)) || (nick && (sender.includes(nick) || content.includes('@' + nick))) }).sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0)).slice(-limit)
  }
  async #get(p) { const s = p.includes('?') ? '&' : '?'; const r = await this.#fetch(`${this.#baseUrl}${p}${s}k=${encodeURIComponent(this.#accessKey)}`); if (!r.ok) throw new Error(`remote wechat API failed: ${r.status}`); return r.json() }
}
