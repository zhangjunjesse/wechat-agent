import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { estimateMessagesTokens } from './tokenizer.mjs'

/** Persistent per-user agent session store backed by SQLite (node:sqlite).
 *
 * Follows Claude Code's context-engineering model:
 *   - `transcript` keeps the FULL raw history (never dropped);
 *   - `summary` holds an LLM-generated fold of already-compacted early turns;
 *   - a cheap token estimate drives WHEN to fold (by ratio, not turn count).
 *
 * The store itself only persists. The decision to fold, and the LLM call that
 * produces the summary, live in the agent layer so this class stays dependency-free.
 */
export class SessionStore {
  #db

  constructor({ file = path.resolve('data/sessions.db') } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.#db = new DatabaseSync(file)
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        user_id         TEXT PRIMARY KEY,
        transcript      TEXT NOT NULL DEFAULT '[]',
        summary         TEXT NOT NULL DEFAULT '',
        token_estimate  INTEGER NOT NULL DEFAULT 0,
        updated_at      INTEGER NOT NULL DEFAULT 0
      );
    `)
  }

  get(userId) {
    const row = this.#db.prepare('SELECT transcript, summary, token_estimate, updated_at FROM sessions WHERE user_id = ?').get(String(userId))
    if (!row) return { transcript: [], summary: '', tokenEstimate: 0, updatedAt: 0 }
    return { transcript: safeJson(row.transcript, []), summary: row.summary || '', tokenEstimate: Number(row.token_estimate || 0), updatedAt: Number(row.updated_at || 0) }
  }

  /** Append one user+assistant turn to the full transcript. Never drops. */
  append(userId, userText, assistantText) {
    const cur = this.get(userId)
    const transcript = [...cur.transcript, { role: 'user', content: userText }, { role: 'assistant', content: assistantText }]
    this.#write(userId, cur.summary, transcript)
    return { transcript: [...transcript], summary: cur.summary, tokenEstimate: estimateMessagesTokens(transcript) }
  }

  /** Fold: keep `keptTranscript` (recent turns) and replace the summary with
   * a fresh LLM-generated one. The pre-fold history is dropped from the active
   * transcript only — archived retention is intentionally out of scope. */
  fold(userId, summary, keptTranscript) {
    this.#write(userId, summary, keptTranscript || [])
    return { transcript: [...(keptTranscript || [])], summary }
  }

  #write(userId, summary, transcript) {
    const tokenEstimate = estimateMessagesTokens(transcript)
    this.#db.prepare(`
      INSERT INTO sessions (user_id, transcript, summary, token_estimate, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        transcript = excluded.transcript,
        summary = excluded.summary,
        token_estimate = excluded.token_estimate,
        updated_at = excluded.updated_at
    `).run(String(userId), JSON.stringify(transcript), summary, tokenEstimate, Date.now())
  }
}

function safeJson(text, fallback) {
  try { const v = JSON.parse(text); return Array.isArray(v) ? v : fallback } catch (e) { return fallback }
}
