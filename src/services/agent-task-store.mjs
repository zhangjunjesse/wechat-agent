import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

/** Agent 任务板（DESIGN-agent-task-board.md）——承诺层存储。
 *
 * 与 `task_runs`（执行层）的分工：板上一行 = 一个**承诺**（给某用户做成某件事，
 * 有依赖/认领/生命周期）；`task_runs` 一行 = 兑现承诺的**一次尝试**（attempts/
 * 超时/notified 防重推）。一个任务对应 0..N 次执行——agent 顺手在对话里做完的
 * 任务没有执行行。两层各自保留状态机，互不妥协。
 *
 * 板状态机：pending → in_progress → completed，旁路 deleted（两个终态不可迁出）。
 * **blocked 不是状态**，是派生条件（存在未完成的 blocker），避免双写不同步。
 * 可认领 = pending ∧ owner='' ∧ 无未完成 blocker ∧ auto_attempts 未超上限。
 *
 * 并发：认领用一条 CAS UPDATE（`WHERE status='pending' AND owner=''`），与
 * task-run-store 的 markNotified 同一手法——SQLite 串行写保证恰一个赢家。
 * 板默认与 task_runs 同一个 DB 文件（同一事务域，部署零新增文件）。 */
const BOARD_TERMINAL = new Set(['completed', 'deleted'])
const BOARD_STATUSES = new Set(['pending', 'in_progress', 'completed', 'deleted'])

export class AgentTaskStore {
  #db

  constructor({ file = path.resolve('data/task-runs.db') } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.#db = new DatabaseSync(file)
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       TEXT NOT NULL,
        subject       TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        active_form   TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'pending',
        owner         TEXT NOT NULL DEFAULT '',
        result        TEXT NOT NULL DEFAULT '',
        result_files  TEXT NOT NULL DEFAULT '[]',
        last_error    TEXT NOT NULL DEFAULT '',
        metadata      TEXT NOT NULL DEFAULT '{}',
        auto_attempts INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        completed_at  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_agent_tasks_user ON agent_tasks (user_id, status, id);
      CREATE TABLE IF NOT EXISTS task_deps (
        task_id       INTEGER NOT NULL,
        blocked_by_id INTEGER NOT NULL,
        UNIQUE(task_id, blocked_by_id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_deps_blocker ON task_deps (blocked_by_id);
    `)
  }

  /** 建任务。blockedBy 为板上已存在的同用户任务 id 列表（写入时校验 + 防环）。 */
  create({ userId, subject, description = '', activeForm = '', owner = '', metadata = null, blockedBy = [], now = Date.now() }) {
    const uid = String(userId || '')
    const subj = String(subject || '').trim()
    if (!uid) throw new Error('userId 不能为空')
    if (!subj) throw new Error('subject 不能为空')
    this.#db.exec('BEGIN')
    try {
      const info = this.#db.prepare(`
        INSERT INTO agent_tasks (user_id, subject, description, active_form, owner, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uid, subj, String(description || ''), String(activeForm || ''), String(owner || ''),
        JSON.stringify(metadata || {}), Math.floor(now), Math.floor(now))
      const id = Number(info.lastInsertRowid)
      for (const dep of blockedBy || []) this.#addEdge(id, Number(dep), uid)
      this.#db.exec('COMMIT')
      return this.get(id, uid)
    } catch (e) {
      this.#db.exec('ROLLBACK')
      throw e
    }
  }

  /** 加一条依赖边 taskId blockedBy blockerId（同用户 + 存在 + 防环；blocker 已是
   * 终态则边立即"非阻塞"，允许——它只是历史事实）。deleted 的 blocker 不许引用。 */
  #addEdge(taskId, blockerId, userId) {
    if (!Number.isInteger(blockerId)) throw new Error(`依赖 id 非法：${blockerId}`)
    if (blockerId === taskId) throw new Error('任务不能阻塞自己')
    const blocker = this.get(blockerId, userId)
    if (!blocker) throw new Error(`依赖的任务 #${blockerId} 不存在（或不属于当前用户）`)
    if (blocker.status === 'deleted') throw new Error(`任务 #${blockerId} 已删除，不能作为依赖`)
    // 防环：从 blocker 出发沿"它的 blocker"链走，能到 taskId 即成环
    const seen = new Set()
    const queue = [blockerId]
    while (queue.length) {
      const cur = queue.shift()
      if (cur === taskId) throw new Error(`依赖成环：#${taskId} 与 #${blockerId} 互相等待`)
      if (seen.has(cur) || seen.size > 500) continue
      seen.add(cur)
      for (const row of this.#db.prepare('SELECT blocked_by_id b FROM task_deps WHERE task_id = ?').all(cur)) queue.push(Number(row.b))
    }
    this.#db.prepare('INSERT OR IGNORE INTO task_deps (task_id, blocked_by_id) VALUES (?, ?)').run(taskId, blockerId)
  }

  /** 未完成的 blocker id 列表（blocked 的派生定义）。 */
  openBlockers(id) {
    return this.#db.prepare(`
      SELECT b.id FROM task_deps d JOIN agent_tasks b ON b.id = d.blocked_by_id
      WHERE d.task_id = ? AND b.status NOT IN ('completed','deleted') ORDER BY b.id
    `).all(Number(id)).map((r) => Number(r.id))
  }

  get(id, userId = null) {
    const row = this.#db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(Number(id))
    if (!row) return null
    if (userId != null && row.user_id !== String(userId)) return null
    return this.#map(row)
  }

  /** 详情：本体 + 两向依赖（含各自状态）+ open blocker。 */
  getDetail(id, userId) {
    const task = this.get(id, userId)
    if (!task) return null
    const dep = (sql, key) => this.#db.prepare(sql).all(Number(id)).map((r) => ({ id: Number(r.id), status: r.status, subject: r.subject }))
    return {
      ...task,
      blockedBy: dep('SELECT b.id, b.status, b.subject FROM task_deps d JOIN agent_tasks b ON b.id = d.blocked_by_id WHERE d.task_id = ? ORDER BY b.id'),
      blocks: dep('SELECT t.id, t.status, t.subject FROM task_deps d JOIN agent_tasks t ON t.id = d.task_id WHERE d.blocked_by_id = ? ORDER BY t.id'),
      openBlockerIds: this.openBlockers(id),
    }
  }

  /** 列表：默认活跃（pending/in_progress）按 id 升序；includeCompleted 追加已完成
   * （新→旧）。deleted 永不出现（语义即"永久移除"）。每行带 openBlockerIds。 */
  list(userId, { includeCompleted = false, limit = 50 } = {}) {
    const uid = String(userId || '')
    const active = this.#db.prepare("SELECT * FROM agent_tasks WHERE user_id = ? AND status IN ('pending','in_progress') ORDER BY id LIMIT ?").all(uid, Math.floor(limit))
    const finished = includeCompleted
      ? this.#db.prepare("SELECT * FROM agent_tasks WHERE user_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT ?").all(uid, Math.floor(limit))
      : []
    return [...active, ...finished].map((r) => ({ ...this.#map(r), openBlockerIds: this.openBlockers(r.id) }))
  }

  /** 认领（CAS）：抢到返回任务，否则 null。 */
  claim(id, owner, now = Date.now()) {
    const info = this.#db.prepare(`
      UPDATE agent_tasks SET owner = ?, status = 'in_progress', updated_at = ?
      WHERE id = ? AND status = 'pending' AND owner = ''
    `).run(String(owner), Math.floor(now), Number(id))
    return Number(info.changes || 0) > 0 ? this.get(id) : null
  }

  /** 下一个可认领任务（最小 id 优先）。
   *  - maxAutoAttempts：系统性失败退避**次数**上限，达到后不再自动重挑
   *    （人工 task_update 回 pending 会清零）；
   *  - retryBackoffMs：失败后的**时间**退避——auto_attempts>0 的任务要等
   *    updated_at 距今超过该值才重新可认领。没有它，执行器释放并发位后的
   *    立即 re-drain 会把同一个任务连珠炮式重试，限流/网关抖动类错误
   *    （ADR-0035 的"可重试"类）根本等不到自愈。 */
  nextClaimable(userId, { maxAutoAttempts = 3, retryBackoffMs = 0, now = Date.now() } = {}) {
    const row = this.#db.prepare(`
      SELECT t.* FROM agent_tasks t
      WHERE t.user_id = ? AND t.status = 'pending' AND t.owner = '' AND t.auto_attempts < ?
        AND (t.auto_attempts = 0 OR t.updated_at <= ?)
        AND NOT EXISTS (
          SELECT 1 FROM task_deps d JOIN agent_tasks b ON b.id = d.blocked_by_id
          WHERE d.task_id = t.id AND b.status NOT IN ('completed','deleted')
        )
      ORDER BY t.id LIMIT 1
    `).get(String(userId), Math.floor(maxAutoAttempts), Math.floor(now - retryBackoffMs))
    return row ? this.#map(row) : null
  }

  /** 有可认领任务的用户列表（drain 定时扫描入口；同 nextClaimable 的判定）。 */
  usersWithClaimable({ maxAutoAttempts = 3, retryBackoffMs = 0, now = Date.now() } = {}) {
    return this.#db.prepare(`
      SELECT DISTINCT t.user_id u FROM agent_tasks t
      WHERE t.status = 'pending' AND t.owner = '' AND t.auto_attempts < ?
        AND (t.auto_attempts = 0 OR t.updated_at <= ?)
        AND NOT EXISTS (
          SELECT 1 FROM task_deps d JOIN agent_tasks b ON b.id = d.blocked_by_id
          WHERE d.task_id = t.id AND b.status NOT IN ('completed','deleted')
        )
    `).all(Math.floor(maxAutoAttempts), Math.floor(now - retryBackoffMs)).map((r) => String(r.u))
  }

  /** agent/工具面的字段与状态更新（服务端硬校验，不靠模型自觉）：
   *  - 终态（completed/deleted）不可迁出；
   *  - → completed 要求无未完成 blocker（讨"没做完不许标完成"的结构性那一半）；
   *  - → pending = 人工重试语义：清 owner/last_error/auto_attempts；
   *  - metadata 浅合并，值为 null 删键；addBlocks/addBlockedBy 建边（防环）。 */
  update(id, userId, { subject, description, activeForm, status, owner, result, metadata, addBlocks, addBlockedBy } = {}, now = Date.now()) {
    const cur = this.get(id, userId)
    if (!cur) return null
    if (BOARD_TERMINAL.has(cur.status) && status !== undefined && status !== cur.status) {
      throw new Error(`任务 #${id} 已是终态「${cur.status}」，不可再变更状态`)
    }
    if (status !== undefined && !BOARD_STATUSES.has(status)) throw new Error(`非法状态：${status}`)
    this.#db.exec('BEGIN')
    try {
      for (const dep of addBlockedBy || []) this.#addEdge(Number(id), Number(dep), String(userId))
      for (const t of addBlocks || []) this.#addEdge(Number(t), Number(id), String(userId))
      const sets = ['updated_at = ?']
      const params = [Math.floor(now)]
      const push = (col, v) => { sets.push(`${col} = ?`); params.push(v) }
      if (subject !== undefined) push('subject', String(subject))
      if (description !== undefined) push('description', String(description))
      if (activeForm !== undefined) push('active_form', String(activeForm))
      if (result !== undefined) push('result', String(result))
      if (owner !== undefined) push('owner', String(owner))
      if (metadata !== undefined && metadata !== null) {
        const merged = { ...cur.metadata }
        for (const [k, v] of Object.entries(metadata)) { if (v === null) delete merged[k]; else merged[k] = v }
        push('metadata', JSON.stringify(merged))
      }
      if (status === 'pending') {
        // 人工重试语义，且**幂等**：任务放弃自动重挑后本来就停在 pending
        // （auto_attempts 顶满），"重试"必须照样清退避——不能因为状态没变就跳过。
        push('status', 'pending'); push('owner', ''); push('last_error', ''); push('auto_attempts', 0)
      } else if (status !== undefined && status !== cur.status) {
        if (status === 'completed') {
          const open = this.openBlockers(id)
          if (open.length) throw new Error(`任务 #${id} 还有未完成的前置任务（#${open.join('、#')}），不能标记完成`)
          push('status', 'completed'); push('completed_at', Math.floor(now))
        } else if (status === 'in_progress') {
          push('status', 'in_progress')
          if (owner === undefined && !cur.owner) push('owner', 'main')
        } else if (status === 'deleted') {
          push('status', 'deleted'); push('completed_at', Math.floor(now))
        }
      }
      params.push(Number(id))
      this.#db.prepare(`UPDATE agent_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params)
      this.#db.exec('COMMIT')
    } catch (e) {
      this.#db.exec('ROLLBACK')
      throw e
    }
    return this.get(id)
  }

  /** 执行成功回填（runner 路径）：工作已实际完成，不再检查 blocker——
   * 认领时已保证无 open blocker，执行期间被人加了前置也不改变"活干完了"的事实
   * （工具面的 update() 才承担纪律校验）。deleted 的任务不回填（cancel 语义）。 */
  complete(id, { result = '', resultFiles = [], now = Date.now() } = {}) {
    const cur = this.get(id)
    if (!cur || BOARD_TERMINAL.has(cur.status)) return null
    this.#db.prepare(`
      UPDATE agent_tasks SET status = 'completed', result = ?, result_files = ?, last_error = '', updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(String(result || ''), JSON.stringify(resultFiles || []), Math.floor(now), Math.floor(now), Number(id))
    return this.get(id)
  }

  /** 系统性失败释放认领：回 pending 等下轮重挑。countAttempt=false 用于重启恢复
   * （不是任务的错，不占退避预算）；setAutoAttempts 用于不可重试错误（直接顶到
   * 上限，停止自动重挑——ADR-0035 的错误分类落到板上）。 */
  release(id, { error = '', countAttempt = true, setAutoAttempts = null, now = Date.now() } = {}) {
    const cur = this.get(id)
    if (!cur || cur.status !== 'in_progress') return null
    const attempts = setAutoAttempts != null ? Math.floor(setAutoAttempts) : cur.autoAttempts + (countAttempt ? 1 : 0)
    this.#db.prepare(`
      UPDATE agent_tasks SET status = 'pending', owner = '', last_error = ?, auto_attempts = ?, updated_at = ?
      WHERE id = ? AND status = 'in_progress'
    `).run(String(error || ''), attempts, Math.floor(now), Number(id))
    return this.get(id)
  }

  /** 恢复扫描：对每个 in_progress 且有 owner 的任务问 shouldRelease(row)，
   * true 即释放（不占退避预算——进程重启不是任务的错）。返回释放的任务列表。 */
  recoverStale({ shouldRelease, now = Date.now() } = {}) {
    if (typeof shouldRelease !== 'function') throw new TypeError('shouldRelease is required')
    const rows = this.#db.prepare("SELECT * FROM agent_tasks WHERE status = 'in_progress' AND owner != ''").all()
    const released = []
    for (const row of rows) {
      const task = this.#map(row)
      if (!shouldRelease(task)) continue
      const r = this.release(task.id, { error: task.lastError || '进程重启，任务自动恢复排队', countAttempt: false, now })
      if (r) released.push(r)
    }
    return released
  }

  /** 同一批次（分诊一次落板的 plan）的全部任务（DESIGN-turn-pipeline：批次收尾
   * 汇总的判定依据）。batchId 存在 metadata JSON 里，不动表结构。 */
  listByBatch(userId, batchId) {
    return this.#db.prepare(`
      SELECT * FROM agent_tasks
      WHERE user_id = ? AND json_extract(metadata, '$.batchId') = ?
      ORDER BY id
    `).all(String(userId), String(batchId)).map((r) => this.#map(r))
  }

  /** 进行中任务的 activeForm（心跳文案内容化用）。 */
  activeForms(userId) {
    return this.#db.prepare("SELECT id, subject, active_form FROM agent_tasks WHERE user_id = ? AND status = 'in_progress' ORDER BY id").all(String(userId))
      .map((r) => ({ id: Number(r.id), text: String(r.active_form || r.subject || '') }))
  }

  /** 校准统计（DESIGN-agent-task-board §5）：过度建任务信号 = 创建后 <30s 即完成占比。 */
  stats({ userId = null } = {}) {
    const where = userId ? 'WHERE user_id = ?' : ''
    const params = userId ? [String(userId)] : []
    const rows = this.#db.prepare(`SELECT status, created_at, completed_at FROM agent_tasks ${where}`).all(...params)
    const completed = rows.filter((r) => r.status === 'completed' && r.completed_at > 0)
    const under30 = completed.filter((r) => r.completed_at - r.created_at < 30_000).length
    return {
      total: rows.length,
      active: rows.filter((r) => ['pending', 'in_progress'].includes(r.status)).length,
      completed: completed.length,
      under30sRate: completed.length ? Math.round((under30 / completed.length) * 1000) / 10 : null,
    }
  }

  /** 归档：终态超过 days 天删除（含孤儿依赖边）。 */
  pruneFinished({ days = 30, now = Date.now() } = {}) {
    const cutoff = now - days * 86_400_000
    const info = this.#db.prepare("DELETE FROM agent_tasks WHERE status IN ('completed','deleted') AND completed_at > 0 AND completed_at < ?").run(Math.floor(cutoff))
    this.#db.exec('DELETE FROM task_deps WHERE task_id NOT IN (SELECT id FROM agent_tasks) OR blocked_by_id NOT IN (SELECT id FROM agent_tasks)')
    return Number(info.changes || 0)
  }

  close() {
    try { this.#db.close() } catch { /* already closed */ }
  }

  #map(row) {
    return {
      id: Number(row.id),
      userId: row.user_id,
      subject: row.subject,
      description: row.description || '',
      activeForm: row.active_form || '',
      status: row.status,
      owner: row.owner || '',
      result: row.result || '',
      resultFiles: safeArr(row.result_files),
      lastError: row.last_error || '',
      metadata: safeObj(row.metadata),
      autoAttempts: Number(row.auto_attempts || 0),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      completedAt: Number(row.completed_at || 0),
    }
  }
}

function safeArr(text) { try { const v = JSON.parse(text); return Array.isArray(v) ? v : [] } catch { return [] } }
function safeObj(text) { try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} } catch { return {} } }
