import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { beijingParts } from './time.mjs'

/** 报告归档库（DESIGN-daily-report.md）。
 *
 * 报告类公共任务（kind='report'）的产出归档：每次生成的结构化报告（items +
 * focus + 原始文本 + 封面路径）落盘 SQLite，支撑三件事：
 *   - 跨天去重：近 N 天已报道条目的标题指纹（recentFingerprints/recentTitles），
 *     下次生成时注入 prompt 并要求回避，生成后再机械过滤；
 *   - 公网发布：同一任务同一天（同一用户+主题维度）的报告 id 稳定
 *     （rp-<hash>-<yyyymmdd>），`/reports/<id>` 可回看、可分享；
 *   - 追问详情：get_daily_report 工具取最近报告，agent 据此展开。
 *
 * 维度隔离演进：ADR-0019 引入 userId（公共版 vs 个性化版互不串）；ADR-0027
 * 再引入 topic（同一用户订阅多个主题时，每个主题独立一条线——独立生成、独立
 * 去重窗口、独立报告 id），因为"每天一份合并报告"曾让用户产生"订阅了却看不出
 * 区别"的错觉，实际是多个主题的新闻被塞进同一份报告里由模型自行权衡分配。 */
export class ReportStore {
  #db

  constructor({ file = path.resolve('data/reports.db') } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.#db = new DatabaseSync(file)
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        id          TEXT PRIMARY KEY,
        task_id     TEXT NOT NULL,
        user_id     TEXT NOT NULL DEFAULT '',
        name        TEXT NOT NULL,
        run_at      INTEGER NOT NULL,
        focus       TEXT NOT NULL DEFAULT '',
        raw_text    TEXT NOT NULL DEFAULT '',
        cover_path  TEXT NOT NULL DEFAULT '',
        poster_path TEXT NOT NULL DEFAULT '',
        items_count INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS report_items (
        report_id   TEXT NOT NULL,
        idx         INTEGER NOT NULL,
        title       TEXT NOT NULL,
        summary     TEXT NOT NULL DEFAULT '',
        source      TEXT NOT NULL DEFAULT '',
        url         TEXT NOT NULL DEFAULT '',
        fingerprint TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (report_id, idx)
      );
    `)
    // 迁移：老库无 poster_path / user_id / topic 列（ADR-0018 海报化 + ADR-0019 主题
    // 个性化 + ADR-0027 每主题独立成篇）
    const cols = this.#db.prepare('PRAGMA table_info(reports)').all().map((c) => c.name)
    if (!cols.includes('poster_path')) this.#db.exec("ALTER TABLE reports ADD COLUMN poster_path TEXT NOT NULL DEFAULT ''")
    if (!cols.includes('user_id')) this.#db.exec("ALTER TABLE reports ADD COLUMN user_id TEXT NOT NULL DEFAULT ''")
    if (!cols.includes('topic')) this.#db.exec("ALTER TABLE reports ADD COLUMN topic TEXT NOT NULL DEFAULT ''")
  }

  /** 持久化一份报告（同一任务同一天同一用户同一主题幂等：覆盖旧内容，id 不变）。
   * `userId` 缺省 = 公共版（所有未设主题的订阅者共享）；传了 = 该用户个性化版
   * （ADR-0019）。`topic` 缺省 = 无主题；传了 = 该用户该主题独立一份（ADR-0027：
   * 订阅多个主题时每个主题各自生成、各自去重、各自海报，不再合并成一份），
   * id 与其他主题/公共版都不同、去重窗口独立。 @returns 已入库的完整报告。 */
  saveReport({ taskId, name, runAt, focus = '', rawText = '', coverPath = '', posterPath = '', items = [], userId = '', topic = '' }) {
    const id = reportIdOf(taskId, runAt, userId, topic)
    const created = Date.now()
    this.#db.prepare('DELETE FROM report_items WHERE report_id = ?').run(id)
    this.#db.prepare('DELETE FROM reports WHERE id = ?').run(id)
    this.#db.prepare(`
      INSERT INTO reports (id, task_id, user_id, topic, name, run_at, focus, raw_text, cover_path, poster_path, items_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, String(taskId), String(userId || ''), String(topic || ''), String(name), Math.floor(runAt), String(focus || ''), String(rawText || ''), String(coverPath || ''), String(posterPath || ''), items.length, Math.floor(created))
    const ins = this.#db.prepare(`
      INSERT INTO report_items (report_id, idx, title, summary, source, url, fingerprint)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    items.forEach((it, idx) => {
      ins.run(id, idx, String(it.title || ''), String(it.summary || ''), String(it.source || ''), String(it.url || ''), fingerprintOf(it.title))
    })
    return this.getReport(id)
  }

  getReport(id) {
    const row = this.#db.prepare('SELECT * FROM reports WHERE id = ?').get(String(id))
    if (!row) return null
    const itemRows = this.#db.prepare('SELECT idx, title, summary, source, url, fingerprint FROM report_items WHERE report_id = ? ORDER BY idx').all(String(id))
    return {
      id: row.id,
      taskId: row.task_id,
      userId: row.user_id || '',
      topic: row.topic || '',
      name: row.name,
      runAt: Number(row.run_at),
      focus: row.focus || '',
      rawText: row.raw_text || '',
      coverPath: row.cover_path || '',
      posterPath: row.poster_path || '',
      items: itemRows.map((r) => ({ title: r.title, summary: r.summary, source: r.source, url: r.url, fingerprint: r.fingerprint })),
    }
  }

  /** 近 `days` 天内该任务（某用户+主题维度）已报道条目的标题指纹集合。
   * userId 缺省 = 公共版；传了 = 该用户个性化版（ADR-0019，互不串）。
   * topic 缺省 = 无主题；传了 = 该用户该主题独立去重窗口（ADR-0027：同一用户的
   * 不同主题互不影响彼此的"近 7 天已报道"判断，各自独立演化）。
   * `now` 可注入（默认真实 `Date.now()`，生产不变）：2026-09-16 发现调用方
   * `TaskScheduler` 自己的 `#now()` 可注入却没传下来，测试固定日期跑够 7 天后
   * 窗口对不上而假失败——这里补上，调用方（task-scheduler.mjs）需把同一个
   * `now` 传进来，否则本参数形同虚设。 */
  recentFingerprints(taskId, days = 7, { userId = '', topic = '', now = Date.now() } = {}) {
    const since = now - days * 86_400_000
    const rows = this.#db.prepare(`
      SELECT i.fingerprint FROM report_items i JOIN reports r ON r.id = i.report_id
      WHERE r.task_id = ? AND r.user_id = ? AND r.topic = ? AND r.run_at >= ? AND i.fingerprint != ''
    `).all(String(taskId), String(userId || ''), String(topic || ''), Math.floor(since))
    return new Set(rows.map((r) => r.fingerprint))
  }

  /** 近 `days` 天内该任务（某用户+主题维度）已报道条目的标题（新→旧，注入 prompt 用）。
   * `topic`/`now` 语义同 `recentFingerprints`。 */
  recentTitles(taskId, days = 7, limit = 20, { userId = '', topic = '', now = Date.now() } = {}) {
    const since = now - days * 86_400_000
    const rows = this.#db.prepare(`
      SELECT i.title FROM report_items i JOIN reports r ON r.id = i.report_id
      WHERE r.task_id = ? AND r.user_id = ? AND r.topic = ? AND r.run_at >= ?
      ORDER BY r.run_at DESC, i.idx ASC LIMIT ?
    `).all(String(taskId), String(userId || ''), String(topic || ''), Math.floor(since), Math.floor(limit))
    return rows.map((r) => r.title)
  }

  /** 该任务（某用户+主题维度）的最近报告概览（新→旧）。`topic` 缺省 `''`
   * 匹配公共版/无主题个性化版；指定主题只看该主题那条线（ADR-0027）。 */
  listReports(taskId, limit = 5, { userId = '', topic = '' } = {}) {
    const rows = this.#db.prepare(`
      SELECT id, name, run_at, focus, items_count, topic FROM reports
      WHERE task_id = ? AND user_id = ? AND topic = ? ORDER BY run_at DESC LIMIT ?
    `).all(String(taskId), String(userId || ''), String(topic || ''), Math.floor(limit))
    return rows.map((r) => ({ id: r.id, name: r.name, runAt: Number(r.run_at), focus: r.focus || '', itemsCount: Number(r.items_count), topic: r.topic || '' }))
  }

  close() {
    try { this.#db.close() } catch { /* already closed */ }
  }
}

/** 报告 id：任务（+用户+主题维度）+ 北京时间日期，同一任务同一天同一维度稳定
 * （幂等 upsert 的依据）。userId/topic 都缺省为公共版；个性化版 id 与公共版不同
 * （ADR-0019）；同一用户的不同主题 id 也互不相同（ADR-0027，互不覆盖）。
 * 不传 topic 时哈希输入与 ADR-0019 时代完全一致，老数据 id 不变。 */
export function reportIdOf(taskId, runAt = Date.now(), userId = '', topic = '') {
  const p = beijingParts(runAt)
  const ymd = `${p.year}${String(p.month).padStart(2, '0')}${String(p.day).padStart(2, '0')}`
  const parts = [String(taskId)]
  if (userId) parts.push(String(userId))
  if (topic) parts.push(String(topic))
  const key = parts.length > 1 ? parts.join('|') : parts[0]
  return `rp-${createHash('sha1').update(key).digest('hex').slice(0, 8)}-${ymd}`
}

/** 标题指纹：小写 + 去空白与中英文标点，保留字母/数字/汉字。
 * 「OpenAI 发布新模型！」与「openai发布新模型」视为同一条。 */
export function fingerprintOf(title) {
  const normalized = String(title || '')
    .toLowerCase()
    .replace(/[\s，。！？、；：""''（）·…—,.;:!?'"()\[\]{}|/\\`~@#$%^&*+=<>《》〈〉「」『』【】]/g, '')
  return createHash('sha1').update(normalized).digest('hex')
}
