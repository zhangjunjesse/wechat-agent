import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { parseSchedule } from './schedule.mjs'

/** 定时任务存储（SQLite，见 DESIGN-timed-tasks.md）。
 *
 * 两类任务：
 *   - scope='user'  私有任务：ownerUserId 独享，用户通过 agent 创建/删除。
 *   - scope='global' 公共任务：管理员预置（loadGlobalTasks 从配置 upsert），
 *     subscribers 列表驱动执行；用户通过 subscribe/unsubscribe 管理自己的订阅。
 *
 * 调度表达式合法性在写入时校验（parseSchedule）。 */
export class TaskStore {
  #db

  constructor({ file = path.resolve('data/tasks.db') } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.#db = new DatabaseSync(file)
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id            TEXT PRIMARY KEY,
        scope         TEXT NOT NULL,
        name          TEXT NOT NULL,
        schedule      TEXT NOT NULL,
        instruction   TEXT NOT NULL DEFAULT '',
        owner_user_id TEXT,
        subscribers   TEXT NOT NULL DEFAULT '[]',
        enabled       INTEGER NOT NULL DEFAULT 1,
        created_at    INTEGER NOT NULL DEFAULT 0,
        last_run_at   INTEGER NOT NULL DEFAULT 0,
        last_error    TEXT NOT NULL DEFAULT '',
        UNIQUE(scope, name)
      );
    `)
  }

  // ---- user (private) tasks ----

  createUserTask({ name, schedule, instruction, ownerUserId, createdAt = Date.now() }) {
    parseSchedule(schedule) // validate before persist
    const id = `user-${ownerUserId}-${name}`
    try {
      this.#db.prepare('INSERT INTO tasks (id, scope, name, schedule, instruction, owner_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, 'user', String(name), schedule, String(instruction || ''), String(ownerUserId), Math.floor(createdAt))
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new Error(`任务「${name}」已存在`)
      throw e
    }
    return this.getTask(id)
  }

  listUserTasks(ownerUserId) {
    return this.#query('SELECT * FROM tasks WHERE scope = ? AND owner_user_id = ?', ['user', String(ownerUserId)])
  }

  deleteUserTask({ ownerUserId, name }) {
    const row = this.#db.prepare('SELECT id FROM tasks WHERE scope = ? AND owner_user_id = ? AND name = ?').get('user', String(ownerUserId), String(name))
    if (!row) return false
    this.#db.prepare('DELETE FROM tasks WHERE id = ?').run(row.id)
    return true
  }

  // ---- global tasks ----

  listGlobalTasks() {
    return this.#query('SELECT * FROM tasks WHERE scope = ?', ['global'])
  }

  /** Upsert global tasks from a config array (deploy/global-tasks.json).
   * Existing subscribers are preserved; schedule/instruction/enabled update.
   * A record may carry `createdAt` (test/backfill) — defaults to now. */
  loadGlobalTasks(records = []) {
    const now = Date.now()
    for (const r of records) {
      parseSchedule(r.schedule) // validate
      const id = `global-${r.name}`
      this.#db.prepare(`
        INSERT INTO tasks (id, scope, name, schedule, instruction, enabled, created_at)
        VALUES (?, 'global', ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          schedule = excluded.schedule,
          instruction = excluded.instruction,
          enabled = excluded.enabled
      `).run(id, String(r.name), r.schedule, String(r.instruction || ''), r.enabled !== false ? 1 : 0, Math.floor(r.createdAt || now))
    }
    return this.listGlobalTasks()
  }

  subscribe(globalName, userId) {
    const task = this.#db.prepare('SELECT id, subscribers FROM tasks WHERE scope = ? AND name = ?').get('global', String(globalName))
    if (!task) throw new Error(`公共任务「${globalName}」不存在`)
    const subs = safeJson(task.subscribers, [])
    if (!subs.includes(String(userId))) {
      subs.push(String(userId))
      this.#db.prepare('UPDATE tasks SET subscribers = ? WHERE id = ?').run(JSON.stringify(subs), task.id)
    }
    return true
  }

  unsubscribe(globalName, userId) {
    const task = this.#db.prepare('SELECT id, subscribers FROM tasks WHERE scope = ? AND name = ?').get('global', String(globalName))
    if (!task) throw new Error(`公共任务「${globalName}」不存在`)
    const subs = safeJson(task.subscribers, [])
    const next = subs.filter((u) => u !== String(userId))
    this.#db.prepare('UPDATE tasks SET subscribers = ? WHERE id = ?').run(JSON.stringify(next), task.id)
    return subs.includes(String(userId))
  }

  isSubscribed(globalName, userId) {
    const task = this.#db.prepare('SELECT subscribers FROM tasks WHERE scope = ? AND name = ?').get('global', String(globalName))
    if (!task) return false
    return safeJson(task.subscribers, []).includes(String(userId))
  }

  // ---- shared ----

  getTask(id) {
    const row = this.#db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    return row ? this.#map(row) : null
  }

  getAllEnabled() {
    return this.#query('SELECT * FROM tasks WHERE enabled = 1')
  }

  /** Close the underlying DB (needed on Windows before deleting the file). */
  close() {
    try { this.#db.close() } catch { /* already closed */ }
  }

  markRun(id, atMs, error = '') {
    this.#db.prepare('UPDATE tasks SET last_run_at = ?, last_error = ? WHERE id = ?').run(Math.floor(atMs), String(error || ''), id)
  }

  #query(sql, params = []) {
    const rows = this.#db.prepare(sql).all(...params)
    return rows.map((r) => this.#map(r))
  }

  #map(row) {
    return {
      id: row.id,
      scope: row.scope,
      name: row.name,
      schedule: row.schedule,
      instruction: row.instruction,
      ownerUserId: row.owner_user_id,
      subscribers: safeJson(row.subscribers, []),
      enabled: Boolean(row.enabled),
      createdAt: Number(row.created_at),
      lastRunAt: Number(row.last_run_at),
      lastError: row.last_error || '',
    }
  }
}

function safeJson(text, fallback) {
  try { const v = JSON.parse(text); return Array.isArray(v) ? v : fallback } catch (e) { return fallback }
}
