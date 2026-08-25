import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

/** Persistent per-user agent session store backed by SQLite (node:sqlite).
 *
 * Each user has one logical session: an ordered JSON array of {role,content}
 * messages plus an optional summary of already-folded early turns. Keeps at
 * most `maxTurns` recent turns; older turns are folded into a summary so the
 * context window stays bounded and cost stays predictable.
 */
export class SessionStore {
  #db
  #maxTurns

  constructor({ file = path.resolve('data/sessions.db'), maxTurns = 40 } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.#db = new DatabaseSync(file)
    this.#maxTurns = maxTurns
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        user_id   TEXT PRIMARY KEY,
        summary   TEXT NOT NULL DEFAULT '',
        messages  TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL DEFAULT 0
      );
    `)
  }

  get(userId) {
    const row = this.#db.prepare('SELECT summary, messages, updated_at FROM sessions WHERE user_id = ?').get(String(userId))
    if (!row) return { summary: '', messages: [], updatedAt: 0 }
    return { summary: row.summary || '', messages: safeJson(row.messages, []), updatedAt: Number(row.updated_at || 0) }
  }

  /** Append a user+assistant turn, then enforce the truncation window. */
  append(userId, userText, assistantText) {
    const cur = this.get(userId)
    const messages = [...cur.messages, { role: 'user', content: userText }, { role: 'assistant', content: assistantText }]
    let summary = cur.summary || ''
    if (messages.length > this.#maxTurns) {
      const dropped = messages.length - this.#maxTurns
      const droppedText = messages.slice(0, dropped).map((m) => `${m.role}: ${m.content}`).join('\n').slice(0, 1200)
      summary = [summary, `[已折叠早期对话 ${dropped} 轮] ${droppedText}`].filter(Boolean).join('\n').slice(0, 2000)
      messages.splice(0, dropped)
    }
    this.#write(userId, summary, messages)
    return { summary, messages: [...messages] }
  }

  putSummary(userId, summary) {
    const cur = this.get(userId)
    const next = (cur.summary ? cur.summary + '\n' : '') + summary
    this.#write(userId, next, cur.messages)
    return { summary: next, messages: [...cur.messages] }
  }

  #write(userId, summary, messages) {
    this.#db.prepare(`
      INSERT INTO sessions (user_id, summary, messages, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        summary = excluded.summary,
        messages = excluded.messages,
        updated_at = excluded.updated_at
    `).run(String(userId), summary, JSON.stringify(messages), Date.now())
  }
}

function safeJson(text, fallback) {
  try { const v = JSON.parse(text); return Array.isArray(v) ? v : fallback } catch (e) { return fallback }
}
