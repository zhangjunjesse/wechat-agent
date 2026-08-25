import { DatabaseSync } from 'node:sqlite'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Long-term user memory store backed by SQLite.
 *
 * Each memory is an "Advanced JSON Card": it records a fact plus the subject
 * (whose fact), the relation to the user, the narrative context that sourced
 * it, and timestamps — so the same fact can be disambiguated in different
 * situations ("张医生" the user's dentist vs the father's cardiologist).
 *
 * Types follow the spec: preference / fact / todo / identity (episodic +
 * semantic combined for a personal assistant; procedural is out of scope).
 */
export class MemoryStore {
  #db

  constructor({ file = path.resolve('data/memories.db') } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.#db = new DatabaseSync(file)
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        type        TEXT NOT NULL,
        subject     TEXT NOT NULL DEFAULT '用户',
        relation    TEXT NOT NULL DEFAULT '本人',
        content     TEXT NOT NULL,
        context     TEXT NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, updated_at DESC);
    `)
  }

  list(userId) {
    const rows = this.#db.prepare('SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC').all(String(userId))
    return rows.map(rowToCard)
  }

  get(userId, id) {
    const row = this.#db.prepare('SELECT * FROM memories WHERE user_id = ? AND id = ?').get(String(userId), String(id))
    return row ? rowToCard(row) : null
  }

  /** Upsert a card. Cards with the same user_id + type + subject + content are
   * treated as the same memory (deduped); otherwise a new card is created. */
  upsert(userId, { type, subject = '用户', relation = '本人', content, context = '' }) {
    const now = Date.now()
    const existing = this.#db.prepare(
      'SELECT id FROM memories WHERE user_id = ? AND type = ? AND subject = ? AND content = ?'
    ).get(String(userId), String(type), String(subject), String(content))
    if (existing) {
      this.#db.prepare('UPDATE memories SET relation = ?, context = ?, updated_at = ? WHERE id = ?')
        .run(String(relation), String(context), now, existing.id)
      return this.get(userId, existing.id)
    }
    const id = crypto.randomUUID()
    this.#db.prepare(`
      INSERT INTO memories (id, user_id, type, subject, relation, content, context, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, String(userId), String(type), String(subject), String(relation), String(content), String(context), now, now)
    return this.get(userId, id)
  }

  /** Resolve a conflict: replace the content of an existing card when new info
   * contradicts it. Match by type + subject (e.g. the "称呼" identity), then
   * overwrite content/context and bump updated_at. Returns the updated card or null. */
  replace(userId, { type, subject = '用户', content, context = '', relation = '本人' }) {
    const existing = this.#db.prepare(
      'SELECT id FROM memories WHERE user_id = ? AND type = ? AND subject = ? ORDER BY updated_at DESC LIMIT 1'
    ).get(String(userId), String(type), String(subject))
    if (!existing) {
      return this.upsert(userId, { type, subject, relation, content, context })
    }
    const now = Date.now()
    this.#db.prepare('UPDATE memories SET content = ?, context = ?, relation = ?, updated_at = ? WHERE id = ?')
      .run(String(content), String(context), String(relation), now, existing.id)
    return this.get(userId, existing.id)
  }

  delete(userId, id) {
    return this.#db.prepare('DELETE FROM memories WHERE user_id = ? AND id = ?').run(String(userId), String(id)).changes > 0
  }
}

function rowToCard(row) {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    subject: row.subject,
    relation: row.relation,
    content: row.content,
    context: row.context,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}
