import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

/** 飞书用户 OAuth token 存储（ADR-0021）。
 *
 * 每个用户授权自己的飞书（user_access_token），agent 代表该用户操作其文档。
 * per-user 隔离（user_id 主键）；存 access/refresh token 与过期时间，
 * lark-client 调用前检查过期并自动刷新。SQLite（与 tasks/sessions 一致），
 * 比 JSON 文件更抗多租户并发写。 */
export class LarkTokenStore {
  #db

  constructor({ file = path.resolve('data/larks.db') } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.#db = new DatabaseSync(file)
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS lark_tokens (
        user_id       TEXT PRIMARY KEY,
        access_token  TEXT NOT NULL,
        refresh_token TEXT NOT NULL DEFAULT '',
        expires_at    INTEGER NOT NULL DEFAULT 0,
        refresh_expires_at INTEGER NOT NULL DEFAULT 0,
        open_id       TEXT NOT NULL DEFAULT '',
        updated_at    INTEGER NOT NULL DEFAULT 0
      );
    `)
  }

  /** 保存/更新用户 token（OAuth code 换得或刷新后）。 */
  set({ userId, accessToken, refreshToken = '', expiresIn = 0, refreshExpiresIn = 0, openId = '' }) {
    const now = Date.now()
    this.#db.prepare(`
      INSERT INTO lark_tokens (user_id, access_token, refresh_token, expires_at, refresh_expires_at, open_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        refresh_expires_at = excluded.refresh_expires_at,
        open_id = excluded.open_id,
        updated_at = excluded.updated_at
    `).run(String(userId), String(accessToken), String(refreshToken || ''), now + Number(expiresIn || 0) * 1000, now + Number(refreshExpiresIn || 0) * 1000, String(openId || ''), now)
  }

  get(userId) {
    const row = this.#db.prepare('SELECT * FROM lark_tokens WHERE user_id = ?').get(String(userId))
    if (!row) return null
    return {
      userId: row.user_id,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: Number(row.expires_at),
      refreshExpiresAt: Number(row.refresh_expires_at),
      openId: row.open_id,
      updatedAt: Number(row.updated_at),
    }
  }

  /** 用户是否已授权且（access 或 refresh）未过期。 */
  isAuthorized(userId) {
    const t = this.get(userId)
    return !!t?.accessToken && Date.now() < t.refreshExpiresAt
  }

  clear(userId) {
    this.#db.prepare('DELETE FROM lark_tokens WHERE user_id = ?').run(String(userId))
  }

  close() {
    try { this.#db.close() } catch { /* already closed */ }
  }
}
