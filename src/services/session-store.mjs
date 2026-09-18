import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { estimateMessagesTokens } from './tokenizer.mjs'

/** Persistent per-user agent session store backed by SQLite (node:sqlite).
 *
 * Follows Claude Code's context-engineering model:
 *   - `transcript` keeps the FULL raw history (never dropped);
 *   - `summary` holds an LLM-generated fold of already-compacted early turns;
 *   - a cheap token estimate drives WHEN to fold (by ratio, not turn count).
 *
 * The store itself only persists. The decision to fold, and the LLM call that
 * produces the summary, live in the agent layer so this class stays dependency-free.
 */
export class SessionStore {
  #db

  constructor({ file = path.resolve('data/sessions.db') } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.#db = new DatabaseSync(file)
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        user_id         TEXT PRIMARY KEY,
        transcript      TEXT NOT NULL DEFAULT '[]',
        summary         TEXT NOT NULL DEFAULT '',
        token_estimate  INTEGER NOT NULL DEFAULT 0,
        updated_at      INTEGER NOT NULL DEFAULT 0
      );
    `)
  }

  get(userId) {
    const row = this.#db.prepare('SELECT transcript, summary, token_estimate, updated_at FROM sessions WHERE user_id = ?').get(String(userId))
    if (!row) return { transcript: [], summary: '', tokenEstimate: 0, updatedAt: 0 }
    return { transcript: safeJson(row.transcript, []), summary: row.summary || '', tokenEstimate: Number(row.token_estimate || 0), updatedAt: Number(row.updated_at || 0) }
  }

  /** Append one user+assistant turn to the full transcript. Never drops. */
  append(userId, userText, assistantText, attachments = []) {
    const cur = this.get(userId)
    const userMessage = { role: 'user', content: userText }
    if (attachments.length) userMessage.attachments = structuredClone(attachments)
    const transcript = [...cur.transcript, userMessage, { role: 'assistant', content: assistantText }]
    this.#write(userId, cur.summary, transcript)
    return { transcript: [...transcript], summary: cur.summary, tokenEstimate: estimateMessagesTokens(transcript) }
  }

  /** Append one assistant-only message（DESIGN-turn-pipeline：后台任务的受理回执
   * 之外，子任务完成/失败通知也是"用户看到的对话事实"，必须进 transcript，否则
   * 用户回一句"这个摘要不错"时主 agent 不知道指什么。纯同步（与 append 相同）：
   * node:sqlite 同步 API + 无 await，单线程下与其他写入不可能交错。 */
  appendAssistant(userId, assistantText) {
    const cur = this.get(userId)
    const transcript = [...cur.transcript, { role: 'assistant', content: String(assistantText || '') }]
    this.#write(userId, cur.summary, transcript)
    return { transcript: [...transcript], summary: cur.summary, tokenEstimate: estimateMessagesTokens(transcript) }
  }

  /** Fold: keep `keptTranscript` (recent turns) and replace the summary with
   * a fresh LLM-generated one. The pre-fold history is dropped from the active
   * transcript only — archived retention is intentionally out of scope. */
  fold(userId, summary, keptTranscript) {
    this.#write(userId, summary, keptTranscript || [])
    return { transcript: [...(keptTranscript || [])], summary }
  }

  #write(userId, summary, transcript) {
    const tokenEstimate = estimateMessagesTokens(transcript)
    this.#db.prepare(`
      INSERT INTO sessions (user_id, transcript, summary, token_estimate, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        transcript = excluded.transcript,
        summary = excluded.summary,
        token_estimate = excluded.token_estimate,
        updated_at = excluded.updated_at
    `).run(String(userId), JSON.stringify(transcript), summary, tokenEstimate, Date.now())
  }

  /** 释放底层 SQLite 句柄。与 `WechatLogStore.close()` / `MemoryStore.close()`
   * 同一个理由：进程内还持有句柄时 Windows 拒绝 unlink（EBUSY），"临时 db 文件
   * 用完即删"的调用方必须能显式关闭。生产常驻进程不需要调用。可重复调用。 */
  close() {
    try { this.#db.close() } catch { /* already closed */ }
  }
}

function safeJson(text, fallback) {
  try { const v = JSON.parse(text); return Array.isArray(v) ? v : fallback } catch (e) { return fallback }
}
