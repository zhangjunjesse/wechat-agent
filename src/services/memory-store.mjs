import { DatabaseSync } from 'node:sqlite'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Long-term user memory store backed by SQLite.
 *
 * Memory types follow cognitive taxonomy (per MEMORY-SPEC):
 *   - episodic:  a specific event (time, object, detail)
 *   - semantic:  stable general knowledge abstracted from many turns
 *   (procedural is out of scope; working memory is the SessionStore transcript)
 *
 * Each card also carries a business `category` (identity / preference / fact /
 * todo) and the Advanced-JSON-Card context fields:
 *   subject   — whose fact this is
 *   relation  — the subject's relation to the user (本人/牙科医生/父亲...)
 *   context   — the narrative source of this memory
 *   due       — for todo: a deadline timestamp (ms), else 0
 *
 * Conflict resolution: a memory is identified by (user, type, subject, relation,
 * category). Same key = same memory → replace content on contradiction. Same
 * subject but DIFFERENT relation coexist (e.g. 张医生 the dentist vs 张医生 the
 * father's cardiologist are two distinct cards).
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
        type        TEXT NOT NULL,        -- episodic | semantic
        category    TEXT NOT NULL,        -- identity | preference | fact | todo
        subject     TEXT NOT NULL DEFAULT '用户',
        relation    TEXT NOT NULL DEFAULT '本人',
        content     TEXT NOT NULL,
        context     TEXT NOT NULL DEFAULT '',
        due         INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, updated_at DESC);
    `)
    // migrate legacy schema (type held category values) if present
    this.#migrate()
  }

  #migrate() {
    const cols = this.#db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name)
    if (!cols.includes('category')) {
      this.#db.exec('ALTER TABLE memories ADD COLUMN category TEXT NOT NULL DEFAULT \'fact\'')
      this.#db.exec('ALTER TABLE memories ADD COLUMN due INTEGER NOT NULL DEFAULT 0')
      // legacy rows: type held e.g. 'identity'/'preference' → move to category, type=semantic
      this.#db.exec(`UPDATE memories SET category = type, type = 'semantic' WHERE type IN ('identity','preference','fact','todo')`)
    }
  }

  list(userId) {
    const rows = this.#db.prepare('SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC').all(String(userId))
    return rows.map(rowToCard)
  }

  listCategory(userId, category) {
    const rows = this.#db.prepare('SELECT * FROM memories WHERE user_id = ? AND category = ? ORDER BY due ASC, updated_at DESC').all(String(userId), String(category))
    return rows.map(rowToCard)
  }

  get(userId, id) {
    const row = this.#db.prepare('SELECT * FROM memories WHERE user_id = ? AND id = ?').get(String(userId), String(id))
    return row ? rowToCard(row) : null
  }

  /** Insert if the exact same memory (including content) is absent. Different
   * content always coexists (two cars, two doctors). */
  insert(userId, { type = 'semantic', category = 'fact', subject = '用户', relation = '本人', content, context = '', due = 0 }) {
    const existing = this.#db.prepare(
      'SELECT id FROM memories WHERE user_id = ? AND type = ? AND subject = ? AND relation = ? AND category = ? AND content = ?'
    ).get(String(userId), String(type), String(subject), String(relation), String(category), String(content))
    if (existing) return this.get(userId, existing.id)
    const now = Date.now()
    const id = crypto.randomUUID()
    this.#db.prepare(`
      INSERT INTO memories (id, user_id, type, category, subject, relation, content, context, due, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, String(userId), String(type), String(category), String(subject), String(relation), String(content), String(context), Number(due || 0), now, now)
    return this.get(userId, id)
  }

  /** Explicit contradiction: replace the newest card matching type+category+
   * subject+relation with new content. Only called when the extractor flagged
   * action=update. */
  update(userId, { type = 'semantic', category = 'fact', subject = '用户', relation = '本人', content, context = '', due = 0 }) {
    const existing = this.#db.prepare(
      'SELECT id FROM memories WHERE user_id = ? AND type = ? AND category = ? AND subject = ? AND relation = ? ORDER BY updated_at DESC LIMIT 1'
    ).get(String(userId), String(type), String(category), String(subject), String(relation))
    if (!existing) return this.insert(userId, { type, category, subject, relation, content, context, due })
    const now = Date.now()
    this.#db.prepare('UPDATE memories SET content = ?, context = ?, due = ?, updated_at = ? WHERE id = ?')
      .run(String(content), String(context), Number(due || 0), now, existing.id)
    return this.get(userId, existing.id)
  }

  /** Legacy alias: upsert() now means "insert (dedupe by content)". */
  upsert(userId, card) {
    return this.insert(userId, card)
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
    category: row.category,
    subject: row.subject,
    relation: row.relation,
    content: row.content,
    context: row.context,
    due: Number(row.due || 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}
