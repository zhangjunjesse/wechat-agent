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
 *   - 公网发布：同一任务同一天的报告 id 稳定（rp-<hash>-<yyyymmdd>），
 *     `/reports/<id>` 可回看、可分享；
 *   - 追问详情：get_daily_report 工具取最近报告，agent 据此展开。 */
export class ReportStore {
  #db

  constructor({ file = path.resolve('data/reports.db') } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.#db = new DatabaseSync(file)
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        id          TEXT PRIMARY KEY,
        task_id     TEXT NOT NULL,
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
    // 迁移：老库无 poster_path 列（ADR-0018 海报化）
    const cols = this.#db.prepare('PRAGMA table_info(reports)').all().map((c) => c.name)
    if (!cols.includes('poster_path')) this.#db.exec("ALTER TABLE reports ADD COLUMN poster_path TEXT NOT NULL DEFAULT ''")
  }

  /** 持久化一份报告（同一任务同一天幂等：覆盖旧内容，id 不变）。
   * @returns 已入库的完整报告（含 items）。 */
  saveReport({ taskId, name, runAt, focus = '', rawText = '', coverPath = '', posterPath = '', items = [] }) {
    const id = reportIdOf(taskId, runAt)
    const created = Date.now()
    this.#db.prepare('DELETE FROM report_items WHERE report_id = ?').run(id)
    this.#db.prepare('DELETE FROM reports WHERE id = ?').run(id)
    this.#db.prepare(`
      INSERT INTO reports (id, task_id, name, run_at, focus, raw_text, cover_path, poster_path, items_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, String(taskId), String(name), Math.floor(runAt), String(focus || ''), String(rawText || ''), String(coverPath || ''), String(posterPath || ''), items.length, Math.floor(created))
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
      name: row.name,
      runAt: Number(row.run_at),
      focus: row.focus || '',
      rawText: row.raw_text || '',
      coverPath: row.cover_path || '',
      posterPath: row.poster_path || '',
      items: itemRows.map((r) => ({ title: r.title, summary: r.summary, source: r.source, url: r.url, fingerprint: r.fingerprint })),
    }
  }

  /** 近 `days` 天内该任务已报道条目的标题指纹集合（用于机械去重）。 */
  recentFingerprints(taskId, days = 7) {
    const since = Date.now() - days * 86_400_000
    const rows = this.#db.prepare(`
      SELECT i.fingerprint FROM report_items i JOIN reports r ON r.id = i.report_id
      WHERE r.task_id = ? AND r.run_at >= ? AND i.fingerprint != ''
    `).all(String(taskId), Math.floor(since))
    return new Set(rows.map((r) => r.fingerprint))
  }

  /** 近 `days` 天内该任务已报道条目的标题（新→旧，注入 prompt 用）。 */
  recentTitles(taskId, days = 7, limit = 20) {
    const since = Date.now() - days * 86_400_000
    const rows = this.#db.prepare(`
      SELECT i.title FROM report_items i JOIN reports r ON r.id = i.report_id
      WHERE r.task_id = ? AND r.run_at >= ?
      ORDER BY r.run_at DESC, i.idx ASC LIMIT ?
    `).all(String(taskId), Math.floor(since), Math.floor(limit))
    return rows.map((r) => r.title)
  }

  /** 该任务的最近报告概览（新→旧）。 */
  listReports(taskId, limit = 5) {
    const rows = this.#db.prepare(`
      SELECT id, name, run_at, focus, items_count FROM reports
      WHERE task_id = ? ORDER BY run_at DESC LIMIT ?
    `).all(String(taskId), Math.floor(limit))
    return rows.map((r) => ({ id: r.id, name: r.name, runAt: Number(r.run_at), focus: r.focus || '', itemsCount: Number(r.items_count) }))
  }

  close() {
    try { this.#db.close() } catch { /* already closed */ }
  }
}

/** 报告 id：任务 + 北京时间日期，同一任务同一天稳定（幂等 upsert 的依据）。 */
export function reportIdOf(taskId, runAt = Date.now()) {
  const p = beijingParts(runAt)
  const ymd = `${p.year}${String(p.month).padStart(2, '0')}${String(p.day).padStart(2, '0')}`
  return `rp-${createHash('sha1').update(String(taskId)).digest('hex').slice(0, 8)}-${ymd}`
}

/** 标题指纹：小写 + 去空白与中英文标点，保留字母/数字/汉字。
 * 「OpenAI 发布新模型！」与「openai发布新模型」视为同一条。 */
export function fingerprintOf(title) {
  const normalized = String(title || '')
    .toLowerCase()
    .replace(/[\s，。！？、；：""''（）·…—,.;:!?'"()\[\]{}|/\\`~@#$%^&*+=<>《》〈〉「」『』【】]/g, '')
  return createHash('sha1').update(normalized).digest('hex')
}
