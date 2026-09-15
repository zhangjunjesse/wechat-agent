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
 * v2 (DESIGN-memory-lifecycle.md, three-tier compression) adds:
 *   importance / access_count / last_access_at / emotion — 第一层评分输入
 *   kind       — 'atomic' | 'generalized'（第三层泛化产物）
 *   source_ids — 合并/泛化的来源卡片 id（可追溯）
 *   status     — 'active' | 'merged' | 'archived'（归档不物理删除）
 * plus three tables: archived_memories（二级存储）/ memory_profiles（派生档案视图）
 * / memory_maintenance（维护脏标记 + 上次维护结果）。
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
        updated_at  INTEGER NOT NULL,
        importance     REAL    NOT NULL DEFAULT 0.5,
        access_count   INTEGER NOT NULL DEFAULT 0,
        last_access_at INTEGER NOT NULL DEFAULT 0,
        emotion        REAL    NOT NULL DEFAULT 0,
        kind           TEXT    NOT NULL DEFAULT 'atomic',
        source_ids     TEXT    NOT NULL DEFAULT '[]',
        status         TEXT    NOT NULL DEFAULT 'active'
      );
      CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, updated_at DESC);

      -- 二级存储：归档的原始卡片（MEMORY-SPEC 第二层「原始记忆存档」），不物理删除
      CREATE TABLE IF NOT EXISTS archived_memories (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        payload     TEXT NOT NULL,
        reason      TEXT NOT NULL,      -- low_importance | merged | generalized_source | aged_todo
        archived_at INTEGER NOT NULL,
        restored_at INTEGER NOT NULL DEFAULT 0
      );

      -- 派生视图：用户档案（可随时丢弃重建，非真相源）
      CREATE TABLE IF NOT EXISTS memory_profiles (
        user_id      TEXT PRIMARY KEY,
        content      TEXT NOT NULL,
        version      INTEGER NOT NULL DEFAULT 1,
        generated_at INTEGER NOT NULL,
        source_count INTEGER NOT NULL DEFAULT 0
      );

      -- 维护编排状态（脏标记 + 上次重量维护结果）
      CREATE TABLE IF NOT EXISTS memory_maintenance (
        user_id        TEXT PRIMARY KEY,
        last_run_at    INTEGER NOT NULL DEFAULT 0,
        last_change_at INTEGER NOT NULL DEFAULT 0,
        last_result    TEXT NOT NULL DEFAULT ''
      );
    `)
    this.#migrate()
  }

  /** Per-column migration.
   *
   * The legacy version checked a single column name (`category`), which would
   * leave an old DB that already had `category` without any v2 column. Every
   * target column is detected independently, so the migration is re-entrant:
   * a crash mid-way only fills in the still-missing columns on the next start. */
  #migrate() {
    const cols = new Set(this.#db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name))
    // legacy schema (type held category values) if present
    if (!cols.has('category')) {
      this.#db.exec("ALTER TABLE memories ADD COLUMN category TEXT NOT NULL DEFAULT 'fact'")
      this.#db.exec('ALTER TABLE memories ADD COLUMN due INTEGER NOT NULL DEFAULT 0')
      this.#db.exec(`UPDATE memories SET category = type, type = 'semantic' WHERE type IN ('identity','preference','fact','todo')`)
      cols.add('category')
      cols.add('due')
    }
    const addColumn = (name, ddl) => {
      if (!cols.has(name)) this.#db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${ddl}`)
    }
    addColumn('importance', 'REAL NOT NULL DEFAULT 0.5')
    addColumn('access_count', 'INTEGER NOT NULL DEFAULT 0')
    addColumn('last_access_at', 'INTEGER NOT NULL DEFAULT 0')
    addColumn('emotion', 'REAL NOT NULL DEFAULT 0')
    addColumn('kind', "TEXT NOT NULL DEFAULT 'atomic'")
    addColumn('source_ids', "TEXT NOT NULL DEFAULT '[]'")
    addColumn('status', "TEXT NOT NULL DEFAULT 'active'")
    // ⚠️ 索引引用 v2 列，必须放在补列**之后**：老库在 CREATE TABLE IF NOT EXISTS
    // 阶段还没有 status 列，索引提前创建会以 "no such column: status" 直接失败。
    this.#db.exec('CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(user_id, status)')
  }

  list(userId) {
    return this.#rows('SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC', userId)
  }

  /** Active cards only — the input for recall and for maintenance. */
  listActive(userId) {
    return this.#rows("SELECT * FROM memories WHERE user_id = ? AND status = 'active' ORDER BY updated_at DESC", userId)
  }

  /** Active cards of one business category (archived/merged cards are hidden). */
  listCategory(userId, category) {
    return this.#rows("SELECT * FROM memories WHERE user_id = ? AND category = ? AND status = 'active' ORDER BY due ASC, updated_at DESC", userId, category)
  }

  listByKind(userId, kind) {
    return this.#rows("SELECT * FROM memories WHERE user_id = ? AND kind = ? AND status = 'active' ORDER BY updated_at DESC", userId, kind)
  }

  get(userId, id) {
    const row = this.#db.prepare('SELECT * FROM memories WHERE user_id = ? AND id = ?').get(String(userId), String(id))
    return row ? rowToCard(row) : null
  }

  /** Every user that still owns active cards (maintenance sweep input). */
  listActiveUserIds() {
    return this.#db.prepare("SELECT DISTINCT user_id FROM memories WHERE status = 'active'").all().map((r) => r.user_id)
  }

  countActive(userId) {
    const row = this.#db.prepare("SELECT COUNT(*) n FROM memories WHERE user_id = ? AND status = 'active'").get(String(userId))
    return Number(row?.n || 0)
  }

  /** Insert if the exact same memory (including content) is absent. Different
   * content always coexists (two cars, two doctors). */
  insert(userId, { type = 'semantic', category = 'fact', subject = '用户', relation = '本人', content, context = '', due = 0, emotion = 0, kind = 'atomic', sourceIds = null, importance = 0.5 } = {}) {
    const existing = this.#db.prepare(
      'SELECT id FROM memories WHERE user_id = ? AND type = ? AND subject = ? AND relation = ? AND category = ? AND content = ?'
    ).get(String(userId), String(type), String(subject), String(relation), String(category), String(content))
    if (existing) return this.get(userId, existing.id)
    const now = Date.now()
    const id = crypto.randomUUID()
    this.#db.prepare(`
      INSERT INTO memories (id, user_id, type, category, subject, relation, content, context, due,
                            created_at, updated_at, importance, access_count, last_access_at, emotion,
                            kind, source_ids, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 'active')
    `).run(id, String(userId), String(type), String(category), String(subject), String(relation), String(content), String(context), Number(due || 0), now, now, Number(importance ?? 0.5), Number(emotion || 0), String(kind || 'atomic'), JSON.stringify(sourceIds || []))
    this.touchChange(userId, now)
    return this.get(userId, id)
  }

  /** Explicit contradiction: replace the newest active card matching
   * type+category+subject+relation with new content. Only called when the
   * extractor flagged action=update. */
  update(userId, { type = 'semantic', category = 'fact', subject = '用户', relation = '本人', content, context = '', due = 0, emotion = 0 } = {}) {
    const existing = this.#db.prepare(
      "SELECT id FROM memories WHERE user_id = ? AND type = ? AND category = ? AND subject = ? AND relation = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1"
    ).get(String(userId), String(type), String(category), String(subject), String(relation))
    if (!existing) return this.insert(userId, { type, category, subject, relation, content, context, due, emotion })
    const now = Date.now()
    this.#db.prepare('UPDATE memories SET content = ?, context = ?, due = ?, emotion = ?, updated_at = ? WHERE id = ?')
      .run(String(content), String(context), Number(due || 0), Number(emotion || 0), now, existing.id)
    this.touchChange(userId, now)
    return this.get(userId, existing.id)
  }

  /** Legacy alias: upsert() now means "insert (dedupe by content)". */
  upsert(userId, card) {
    return this.insert(userId, card)
  }

  delete(userId, id) {
    return this.#db.prepare('DELETE FROM memories WHERE user_id = ? AND id = ?').run(String(userId), String(id)).changes > 0
  }

  /** Recall bookkeeping: bump access stats for the cards actually injected into
   * the prompt — the only behavioural signal feeding 第一层评分. */
  markAccessed(userId, ids, at = Date.now()) {
    const list = [...new Set((ids || []).map(String))].filter(Boolean)
    if (!list.length) return 0
    const holes = list.map(() => '?').join(',')
    return this.#db.prepare(
      `UPDATE memories SET access_count = access_count + 1, last_access_at = ? WHERE user_id = ? AND id IN (${holes})`
    ).run(Number(at), String(userId), ...list).changes
  }

  setImportance(userId, id, score) {
    return this.#db.prepare('UPDATE memories SET importance = ? WHERE user_id = ? AND id = ?')
      .run(clamp01(score), String(userId), String(id)).changes > 0
  }

  /** Archive (never a physical delete): status → 'archived' plus a full payload
   * copy in archived_memories so the card stays auditable and restorable.
   * `updated_at` is deliberately untouched — archiving is not activity. */
  archive(userId, ids, reason, at = Date.now()) {
    const list = (ids || []).map(String)
    if (!list.length) return 0
    let archived = 0
    this.#db.exec('BEGIN')
    try {
      for (const id of list) {
        const row = this.#db.prepare("SELECT * FROM memories WHERE user_id = ? AND id = ? AND status = 'active'").get(String(userId), id)
        if (!row) continue
        this.#db.prepare('INSERT OR REPLACE INTO archived_memories (id, user_id, payload, reason, archived_at, restored_at) VALUES (?, ?, ?, ?, ?, 0)')
          .run(row.id, row.user_id, JSON.stringify(rowToCard(row)), String(reason), Number(at))
        this.#db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(id)
        archived++
      }
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    return archived
  }

  /** Restore archived cards from the 二级存储 payload (rollback path). */
  restore(userId, ids, at = Date.now()) {
    const list = (ids || []).map(String)
    if (!list.length) return 0
    let restored = 0
    this.#db.exec('BEGIN')
    try {
      for (const id of list) {
        const row = this.#db.prepare('SELECT id FROM archived_memories WHERE user_id = ? AND id = ? AND restored_at = 0').get(String(userId), id)
        if (!row) continue
        this.#db.prepare("UPDATE memories SET status = 'active' WHERE id = ? AND user_id = ?").run(id, String(userId))
        this.#db.prepare('UPDATE archived_memories SET restored_at = ? WHERE id = ?').run(Number(at), id)
        restored++
      }
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    return restored
  }

  /** 第二层聚类压缩的应用：插合并卡 + 原卡标记 merged 并归档（单事务）。 */
  mergeInto(userId, originalIds, mergedCard, at = Date.now()) {
    const sources = (originalIds || []).map(String)
    if (sources.length < 2) return null
    this.#db.exec('BEGIN')
    try {
      const merged = this.insert(userId, { ...mergedCard, kind: 'atomic', sourceIds: sources })
      for (const id of sources) {
        const row = this.#db.prepare("SELECT * FROM memories WHERE user_id = ? AND id = ? AND status = 'active'").get(String(userId), id)
        if (!row) continue
        this.#db.prepare('INSERT OR REPLACE INTO archived_memories (id, user_id, payload, reason, archived_at, restored_at) VALUES (?, ?, ?, ?, ?, 0)')
          .run(row.id, row.user_id, JSON.stringify(rowToCard(row)), 'merged', Number(at))
        this.#db.prepare("UPDATE memories SET status = 'merged' WHERE id = ?").run(id)
      }
      this.#db.exec('COMMIT')
      return merged
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /** Derived profile view: rebuildable projection, never a source of truth. */
  upsertProfile(userId, content, sourceCount = 0, at = Date.now()) {
    this.#db.prepare(`
      INSERT INTO memory_profiles (user_id, content, version, generated_at, source_count)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        content = excluded.content,
        version = memory_profiles.version + 1,
        generated_at = excluded.generated_at,
        source_count = excluded.source_count
    `).run(String(userId), String(content), Number(at), Number(sourceCount))
    return this.getProfile(userId)
  }

  getProfile(userId) {
    const row = this.#db.prepare('SELECT * FROM memory_profiles WHERE user_id = ?').get(String(userId))
    if (!row) return null
    return { userId: row.user_id, content: row.content, version: Number(row.version), generatedAt: Number(row.generated_at), sourceCount: Number(row.source_count) }
  }

  /** Mark "cards changed" so maintenance knows the user is dirty/active. */
  touchChange(userId, at = Date.now()) {
    this.#db.prepare(`
      INSERT INTO memory_maintenance (user_id, last_run_at, last_change_at, last_result)
      VALUES (?, 0, ?, '')
      ON CONFLICT(user_id) DO UPDATE SET last_change_at = excluded.last_change_at
    `).run(String(userId), Number(at))
  }

  getMaintenance(userId) {
    const row = this.#db.prepare('SELECT * FROM memory_maintenance WHERE user_id = ?').get(String(userId))
    if (!row) return { userId: String(userId), lastRunAt: 0, lastChangeAt: 0, lastResult: '' }
    return { userId: row.user_id, lastRunAt: Number(row.last_run_at), lastChangeAt: Number(row.last_change_at), lastResult: row.last_result || '' }
  }

  markMaintenanceRun(userId, at, result = '') {
    this.#db.prepare(`
      INSERT INTO memory_maintenance (user_id, last_run_at, last_change_at, last_result)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(user_id) DO UPDATE SET last_run_at = excluded.last_run_at, last_result = excluded.last_result
    `).run(String(userId), Number(at), String(result))
  }

  /** Archived payload lookup (audit / restore tooling). */
  listArchived(userId) {
    return this.#db.prepare('SELECT id, user_id, payload, reason, archived_at, restored_at FROM archived_memories WHERE user_id = ? ORDER BY archived_at DESC')
      .all(String(userId))
      .map((r) => ({ id: r.id, userId: r.user_id, card: safeParse(r.payload, null), reason: r.reason, archivedAt: Number(r.archived_at), restoredAt: Number(r.restored_at) }))
  }

  #rows(sql, userId, extra) {
    const rows = extra === undefined
      ? this.#db.prepare(sql).all(String(userId))
      : this.#db.prepare(sql).all(String(userId), String(extra))
    return rows.map(rowToCard)
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
    importance: Number(row.importance ?? 0.5),
    accessCount: Number(row.access_count || 0),
    lastAccessAt: Number(row.last_access_at || 0),
    emotion: Number(row.emotion || 0),
    kind: row.kind || 'atomic',
    sourceIds: safeParse(row.source_ids, []),
    status: row.status || 'active',
  }
}

function safeParse(text, fallback) {
  try {
    const value = JSON.parse(text)
    return value ?? fallback
  } catch (e) {
    return fallback
  }
}

function clamp01(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}
