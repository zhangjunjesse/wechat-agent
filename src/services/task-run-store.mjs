import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

/** 委派任务存储（DESIGN-task-delegation.md / ADR-0024）。
 *
 * 与 DSH 的差异（有意）：DSH 的 JobSnapshot 是**纯内存** Map（进程死即丢），
 * 因为 DSH 的会话与任务同进程、用户在同一 UI 里看得到。微信场景不同——用户会
 * 跨会话问"我派的任务怎么样了"，服务重启也不能丢，需要审计与重试 → 落 SQLite。
 *
 * 状态机（首次结果优先，终态不可变）：
 *   pending → running → done | failed | timeout | cancelled
 * `notified` 位照搬 DSH 的 `JobSnapshot.reported`：结算通知只投递一次。 */
const TERMINAL = new Set(['done', 'failed', 'timeout', 'cancelled'])

export class TaskRunStore {
  #db
  #seq = 0

  constructor({ file = path.resolve('data/task-runs.db') } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.#db = new DatabaseSync(file)
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS task_runs (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        origin       TEXT NOT NULL DEFAULT '',
        goal         TEXT NOT NULL,
        context      TEXT NOT NULL DEFAULT '',
        status       TEXT NOT NULL DEFAULT 'pending',
        result       TEXT NOT NULL DEFAULT '',
        result_files TEXT NOT NULL DEFAULT '[]',
        error        TEXT NOT NULL DEFAULT '',
        notified     INTEGER NOT NULL DEFAULT 0,
        attempts     INTEGER NOT NULL DEFAULT 1,
        created_at   INTEGER NOT NULL,
        started_at   INTEGER NOT NULL DEFAULT 0,
        finished_at  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_task_runs_user ON task_runs (user_id, created_at DESC);
    `)
    // 迁移（DESIGN-agent-task-board）：执行行关联到板任务。旧库无此列 → 补上；
    // 已有则 ALTER 报 duplicate column，吞掉即可（幂等）。
    try { this.#db.exec("ALTER TABLE task_runs ADD COLUMN board_task_id TEXT NOT NULL DEFAULT ''") } catch { /* 已迁移 */ }
    // 序号从现有最大值续（id 形如 task-12）
    const row = this.#db.prepare("SELECT id FROM task_runs WHERE id LIKE 'task-%' ORDER BY CAST(SUBSTR(id, 6) AS INTEGER) DESC LIMIT 1").get()
    this.#seq = row ? Number(String(row.id).slice(5)) || 0 : 0
  }

  /** 建执行行（pending）。goal 由主 agent/板任务写成自包含描述；
   * boardTaskId 非空 = 这次执行隶属于板上某个承诺（DESIGN-agent-task-board）。 */
  create({ userId, goal, context = '', origin = '', boardTaskId = '', createdAt = Date.now() }) {
    this.#seq += 1
    const id = `task-${this.#seq}`
    this.#db.prepare(`
      INSERT INTO task_runs (id, user_id, origin, goal, context, status, board_task_id, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, String(userId), String(origin || ''), String(goal), String(context || ''), String(boardTaskId || ''), Math.floor(createdAt))
    return this.get(id)
  }

  /** 某个板任务的最近一次执行（task_output 的默认取数路径）。 */
  latestForBoard(boardTaskId) {
    const row = this.#db.prepare('SELECT * FROM task_runs WHERE board_task_id = ? ORDER BY created_at DESC LIMIT 1').get(String(boardTaskId))
    return row ? this.#map(row) : null
  }

  /** 启动期孤儿清理（DESIGN-agent-task-board §3.5）：执行队列是内存的，进程
   * 重启后所有 pending/running 行都不再有人执行——如实标 failed（可重试），
   * 终结"task_status 显示已用 N 秒且永远涨"的假象。必须在 runner 启动前调用。 */
  failOrphans({ now = Date.now() } = {}) {
    const info = this.#db.prepare(`
      UPDATE task_runs SET status = 'failed', error = '进程重启中断，可重试', finished_at = ?
      WHERE status IN ('pending','running')
    `).run(Math.floor(now))
    return Number(info.changes || 0)
  }

  markRunning(id, atMs = Date.now()) {
    this.#db.prepare("UPDATE task_runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'").run(Math.floor(atMs), String(id))
    return this.get(id)
  }

  /** 结算（首次结果优先：已是终态则忽略）。 */
  settle(id, { status, result = '', error = '', resultFiles = [], atMs = Date.now() }) {
    const cur = this.get(id)
    if (!cur) return null
    if (TERMINAL.has(cur.status)) return cur
    const next = TERMINAL.has(status) ? status : 'failed'
    this.#db.prepare(`
      UPDATE task_runs SET status = ?, result = ?, error = ?, result_files = ?, finished_at = ?
      WHERE id = ?
    `).run(next, String(result || ''), String(error || ''), JSON.stringify(resultFiles || []), Math.floor(atMs), String(id))
    return this.get(id)
  }

  /** 标记已通知（结算通知只发一次；返回 true 表示本次抢到通知权）。 */
  markNotified(id) {
    const info = this.#db.prepare('UPDATE task_runs SET notified = 1 WHERE id = ? AND notified = 0').run(String(id))
    return Number(info.changes || 0) > 0
  }

  markRetry(id, atMs = Date.now()) {
    const cur = this.get(id)
    if (!cur || !TERMINAL.has(cur.status)) return null
    this.#db.prepare(`
      UPDATE task_runs SET status = 'pending', error = '', finished_at = 0, notified = 0, attempts = attempts + 1, created_at = ?
      WHERE id = ?
    `).run(Math.floor(atMs), String(id))
    return this.get(id)
  }

  get(id) {
    const row = this.#db.prepare('SELECT * FROM task_runs WHERE id = ?').get(String(id))
    return row ? this.#map(row) : null
  }

  /** 某用户的任务列表（新→旧）。 */
  listByUser(userId, { limit = 10, statuses = null } = {}) {
    const rows = this.#db.prepare('SELECT * FROM task_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(String(userId), Math.floor(limit))
    const list = rows.map((r) => this.#map(r))
    return statuses ? list.filter((t) => statuses.includes(t.status)) : list
  }

  /** 该用户当前进行中的任务数（并发控制用）。 */
  runningCount(userId) {
    const row = this.#db.prepare("SELECT COUNT(*) c FROM task_runs WHERE user_id = ? AND status IN ('pending','running')").get(String(userId))
    return Number(row?.c || 0)
  }

  /** 校准统计（Layer 3）：短任务派发率 / 失败率 / 平均耗时。 */
  stats({ userId = null, sinceMs = null } = {}) {
    const clauses = []
    const params = []
    if (userId) { clauses.push('user_id = ?'); params.push(String(userId)) }
    if (sinceMs) { clauses.push('created_at >= ?'); params.push(Math.floor(sinceMs)) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.#db.prepare(`SELECT * FROM task_runs ${where}`).all(...params).map((r) => this.#map(r))
    const finished = rows.filter((t) => TERMINAL.has(t.status) && t.finishedAt > t.startedAt && t.startedAt > 0)
    const durations = finished.map((t) => (t.finishedAt - t.startedAt) / 1000)
    const short = durations.filter((d) => d < 30).length
    const failed = rows.filter((t) => ['failed', 'timeout'].includes(t.status)).length
    const avg = durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : null
    return {
      total: rows.length,
      done: rows.filter((t) => t.status === 'done').length,
      failed,
      running: rows.filter((t) => ['pending', 'running'].includes(t.status)).length,
      shortTaskRate: durations.length ? Math.round((short / durations.length) * 1000) / 10 : null, // %（判据过松的信号）
      failureRate: rows.length ? Math.round((failed / rows.length) * 1000) / 10 : null,
      avgSeconds: avg,
    }
  }

  /** 归档：终态且超过 days 天的记录删除（表不膨胀）。 */
  pruneFinished({ days = 7, now = Date.now() } = {}) {
    const cutoff = now - days * 86_400_000
    const info = this.#db.prepare("DELETE FROM task_runs WHERE status IN ('done','failed','timeout','cancelled') AND finished_at > 0 AND finished_at < ?").run(Math.floor(cutoff))
    return Number(info.changes || 0)
  }

  close() {
    try { this.#db.close() } catch { /* already closed */ }
  }

  #map(row) {
    return {
      id: row.id,
      userId: row.user_id,
      origin: row.origin || '',
      boardTaskId: row.board_task_id || '',
      goal: row.goal,
      context: row.context || '',
      status: row.status,
      result: row.result || '',
      resultFiles: safeJson(row.result_files, []),
      error: row.error || '',
      notified: Boolean(row.notified),
      attempts: Number(row.attempts || 1),
      createdAt: Number(row.created_at),
      startedAt: Number(row.started_at),
      finishedAt: Number(row.finished_at),
    }
  }
}

function safeJson(text, fallback) {
  try { const v = JSON.parse(text); return Array.isArray(v) ? v : fallback } catch { return fallback }
}
