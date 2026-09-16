import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { parseSchedule } from './schedule.mjs'

/** 单用户对单任务的最大主题订阅数（ADR-0027）。每个主题当天各自出一份独立
 * 海报+推送，这个数就是用户每天收到的推送条数上限，务必与
 * `update_report_topics` 工具描述里的"1-5 个"保持一致。 */
export const MAX_REPORT_TOPICS = 5

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
        kind          TEXT NOT NULL DEFAULT 'plain',
        cover         INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL DEFAULT 0,
        last_run_at   INTEGER NOT NULL DEFAULT 0,
        last_error    TEXT NOT NULL DEFAULT '',
        UNIQUE(scope, name)
      );
    `)
    // 迁移：线上旧库没有 kind/cover 列（DESIGN-daily-report.md）——补列后再用。
    const cols = this.#db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name)
    if (!cols.includes('kind')) this.#db.exec("ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'plain'")
    if (!cols.includes('cover')) this.#db.exec('ALTER TABLE tasks ADD COLUMN cover INTEGER NOT NULL DEFAULT 0')
    // 迁移：失败重试状态（ADR-0026）。`last_run_at` 语义收窄为"最后一次**结算**
    // 时间"（成功，或重试耗尽后放弃）；`attempt_count`/`last_attempt_at` 记录
    // 本结算周期内已尝试次数与时间，供调度器节流重试、判断何时放弃。
    if (!cols.includes('attempt_count')) this.#db.exec('ALTER TABLE tasks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0')
    if (!cols.includes('last_attempt_at')) this.#db.exec('ALTER TABLE tasks ADD COLUMN last_attempt_at INTEGER NOT NULL DEFAULT 0')
    // 用户主题订阅（ADR-0019）：per-user，按 user_id 隔离；只对已订阅任务生效。
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS report_topics (
        user_id    TEXT NOT NULL,
        task_name  TEXT NOT NULL,
        topics     TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, task_name)
      );
      CREATE TABLE IF NOT EXISTS guide_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    TEXT NOT NULL,
        event      TEXT NOT NULL,
        entry      TEXT NOT NULL DEFAULT '',
        task_name  TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
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
   * Existing subscribers are preserved; schedule/instruction/kind/cover update.
   * A record may carry `createdAt` (test/backfill) — defaults to now. */
  loadGlobalTasks(records = []) {
    const now = Date.now()
    for (const r of records) {
      parseSchedule(r.schedule) // validate
      const id = `global-${r.name}`
      this.#db.prepare(`
        INSERT INTO tasks (id, scope, name, schedule, instruction, enabled, kind, cover, created_at)
        VALUES (?, 'global', ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          schedule = excluded.schedule,
          instruction = excluded.instruction,
          enabled = excluded.enabled,
          kind = excluded.kind,
          cover = excluded.cover
      `).run(id, String(r.name), r.schedule, String(r.instruction || ''), r.enabled !== false ? 1 : 0, r.kind === 'report' ? 'report' : 'plain', r.cover ? 1 : 0, Math.floor(r.createdAt || now))
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

  // ---- per-user report topics（ADR-0019：主题订阅，严格按用户隔离）----

  /** 设置用户对某任务的关注主题（替代式：传空数组 = 清除个性化，回到公共版）。
   * 上限 5 个（MAX_REPORT_TOPICS）：ADR-0027 起每个主题当天各自出一份独立的
   * 海报+推送，主题数直接等于用户每天收到的推送条数——上限如果还是老的 10，
   * 用户设满就是每天 10 张图轰炸，体验和成本都不可接受；5 与 `update_report_topics`
   * 工具描述早就承诺的"1-5 个"对齐（此前代码上限 10 与文案不符，顺手订正）。 */
  setReportTopics({ globalName, userId, topics = [] }) {
    const task = this.#db.prepare('SELECT scope FROM tasks WHERE scope = ? AND name = ?').get('global', String(globalName))
    if (!task) throw new Error(`公共任务「${globalName}」不存在`)
    if (!this.isSubscribed(globalName, userId)) throw new Error(`你未订阅「${globalName}」，请先订阅再设置主题`)
    const cleaned = topics.map((t) => String(t).trim()).filter(Boolean).slice(0, MAX_REPORT_TOPICS)
    const uid = String(userId)
    this.#db.prepare(`
      INSERT INTO report_topics (user_id, task_name, topics, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, task_name) DO UPDATE SET topics = excluded.topics, updated_at = excluded.updated_at
    `).run(uid, String(globalName), JSON.stringify(cleaned), Date.now())
    return cleaned
  }

  /** 读取用户对某任务的关注主题（未设置返回 []）。 */
  getReportTopics(globalName, userId) {
    const row = this.#db.prepare('SELECT topics FROM report_topics WHERE user_id = ? AND task_name = ?').get(String(userId), String(globalName))
    return row ? safeJson(row.topics, []) : []
  }

  /** 该任务下所有设了主题的订阅者（userId → topics），供调度器分组生成。 */
  reportTopicsByTask(globalName) {
    const rows = this.#db.prepare('SELECT user_id, topics FROM report_topics WHERE task_name = ?').all(String(globalName))
    const map = {}
    for (const r of rows) {
      const t = safeJson(r.topics, [])
      if (t.length) map[r.user_id] = t
    }
    return map
  }

  listReportTopics(userId) {
    const rows = this.#db.prepare('SELECT task_name, topics FROM report_topics WHERE user_id = ?').all(String(userId))
    return rows.map((r) => ({ taskName: r.task_name, topics: safeJson(r.topics, []) }))
  }

  // ---- 引导效果度量（ADR-0020：guide_events 埋点）----

  /** 记录一次引导曝光/转化事件。
   * event: 'guide_shown'（引导展示）| 'guide_converted'（用户据此设置了主题）
   * entry: 'subscribe'（订阅回执）| 'push'（海报/短描述推送）| 'chat'（对话中设置主题） */
  recordGuideEvent({ userId, event, entry = '', taskName = '' }) {
    if (!userId) return
    this.#db.prepare('INSERT INTO guide_events (user_id, event, entry, task_name, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(String(userId), String(event), String(entry), String(taskName || ''), Date.now())
  }

  /** 引导效果统计：漏斗 + 入口分布 + 平均转化耗时（毫秒）。
   * 返回 { subscribed, shown, converted, byEntry, convertHours } */
  guideStats() {
    const subRows = this.#db.prepare("SELECT subscribers FROM tasks WHERE scope = 'global'").all()
    const subscribed = new Set()
    for (const r of subRows) for (const u of safeJson(r.subscribers, [])) subscribed.add(String(u))
    const shownRows = this.#db.prepare("SELECT user_id, entry, created_at FROM guide_events WHERE event = 'guide_shown'").all()
    const convRows = this.#db.prepare("SELECT user_id, created_at FROM guide_events WHERE event = 'guide_converted'").all()
    const shownUsers = new Set(shownRows.map((r) => String(r.user_id)))
    const byEntry = {}
    for (const r of shownRows) byEntry[r.entry] = (byEntry[r.entry] || 0) + 1
    // 转化耗时：同用户最近一次 shown 到第一次 converted 的间隔
    const convertMs = []
    const firstConvByUser = new Map()
    for (const r of convRows) {
      if (!firstConvByUser.has(String(r.user_id))) firstConvByUser.set(String(r.user_id), Number(r.created_at))
    }
    const lastShownByUser = new Map()
    for (const r of shownRows) lastShownByUser.set(String(r.user_id), Number(r.created_at))
    for (const [u, convAt] of firstConvByUser) {
      const shownAt = lastShownByUser.get(u)
      if (shownAt && convAt >= shownAt) convertMs.push(convAt - shownAt)
    }
    const avgMs = convertMs.length ? Math.round(convertMs.reduce((a, b) => a + b, 0) / convertMs.length) : null
    return {
      subscribed: subscribed.size,
      shown: shownUsers.size,
      converted: firstConvByUser.size,
      byEntry,
      convertHours: avgMs == null ? null : Math.round((avgMs / 3600_000) * 10) / 10,
    }
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

  /** 结算本周期（成功，或重试耗尽放弃）：推进 `last_run_at`（下次调度的锚点）
   * 并把 `attempt_count` 归零，为下一个周期做准备。 */
  markRun(id, atMs, error = '') {
    this.#db.prepare('UPDATE tasks SET last_run_at = ?, last_error = ?, attempt_count = 0 WHERE id = ?').run(Math.floor(atMs), String(error || ''), id)
  }

  /** 记一次失败尝试但**不**结算（ADR-0026）：`last_run_at` 保持不变，任务仍会
   * 被判定为"到期"，调度器据此按 `retryIntervalMs` 节流重试，而不是静默
   * 等到下一个自然周期（第二天）。 */
  markAttemptFailed(id, atMs, error = '') {
    this.#db.prepare('UPDATE tasks SET attempt_count = attempt_count + 1, last_attempt_at = ?, last_error = ? WHERE id = ?').run(Math.floor(atMs), String(error || ''), id)
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
      kind: row.kind || 'plain',
      cover: Boolean(row.cover),
      createdAt: Number(row.created_at),
      lastRunAt: Number(row.last_run_at),
      lastError: row.last_error || '',
      attemptCount: Number(row.attempt_count || 0),
      lastAttemptAt: Number(row.last_attempt_at || 0),
    }
  }
}

function safeJson(text, fallback) {
  try { const v = JSON.parse(text); return Array.isArray(v) ? v : fallback } catch (e) { return fallback }
}
