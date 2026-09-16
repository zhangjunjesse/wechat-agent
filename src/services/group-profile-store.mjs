import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

/** 群画像存储（DESIGN-wechat-digest.md）。
 *
 * 微信日报/周报要对不同的群用不同的"捞法"——工作群捞 @我/决策/deadline，家人群
 * 捞就医出行生日，通知群把结构化通知转成待办候选，死群直接跳过。这张表就是
 * "哪个群该用哪种捞法"的记忆，**按用户隔离**：同一个群对不同人可以是不同性质
 * （某人的"工作群"是另一个人的"通知群"）。
 *
 *   group_profiles(user_id, chat_wxid, chat_name, tag, confidence, source, updated_at)
 *   PRIMARY KEY (user_id, chat_wxid)
 *
 * `source` 是这张表唯一的硬规矩：
 *   - `'auto'`：agent 自动打标（首次为某用户跑 digest 前批量跑一次）；
 *   - `'user'`：用户在对话里纠正过（set_group_tag 工具）。
 * **auto 永不覆盖 user**。用户纠正一次就该一直算数——否则下次自动打标又把它改
 * 回去，用户会以为"说了也没用"，这是这类功能最快失去信任的方式。反过来
 * user 覆盖 auto、user 覆盖 user 都允许（用户改主意是正常的）。
 *
 * 独立文件 `data/digest.db`（而不是塞进 tasks.db）：与 ReportStore 用独立
 * reports.db 是同一个惯例——按功能域分库，各自建表迁移互不牵连。 */

/** 群性质标签。digest 的提取侧重完全由它驱动（见 wechat-digest.mjs 的 TAG_FOCUS）。 */
export const GROUP_TAGS = ['work', 'family', 'friends', 'hobby', 'notice', 'deal', 'dead']

/** 标签的人类可读名（工具回复/海报/日志用）。 */
export const GROUP_TAG_LABELS = {
  work: '工作',
  family: '家人',
  friends: '朋友',
  hobby: '兴趣',
  notice: '通知',
  deal: '交易/服务',
  dead: '死群（跳过）',
}

export class GroupProfileStore {
  #db

  constructor({ file = path.resolve('data/digest.db') } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.#db = new DatabaseSync(file)
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS group_profiles (
        user_id    TEXT NOT NULL,
        chat_wxid  TEXT NOT NULL,
        chat_name  TEXT NOT NULL DEFAULT '',
        tag        TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0,
        source     TEXT NOT NULL DEFAULT 'auto',
        updated_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, chat_wxid)
      );
    `)
  }

  /** 写入/更新一条群画像。
   * `source='auto'` 且已存在 `source='user'` 的行时**整条跳过**（返回已有行），
   * 这是本模块的核心不变量；`chat_name` 也不更新——用户纠正过的那行整体不动，
   * 免得"只改了个名字"变成部分覆盖的灰色地带（群名变化下次 user 写入时自然跟上）。
   * @returns 当前生效的那一行（可能是被保护下来的旧行）。 */
  put({ userId, chatWxid, chatName = '', tag, confidence = 0, source = 'auto', at = Date.now() }) {
    const uid = String(userId || '')
    const cid = String(chatWxid || '')
    if (!uid || !cid) throw new Error('userId 与 chatWxid 必填')
    if (!GROUP_TAGS.includes(tag)) throw new Error(`未知群标签「${tag}」（可选：${GROUP_TAGS.join('/')}）`)
    const src = source === 'user' ? 'user' : 'auto'
    const existing = this.get(uid, cid)
    if (src === 'auto' && existing?.source === 'user') return existing // 用户说了算
    this.#db.prepare(`
      INSERT INTO group_profiles (user_id, chat_wxid, chat_name, tag, confidence, source, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, chat_wxid) DO UPDATE SET
        chat_name = excluded.chat_name,
        tag = excluded.tag,
        confidence = excluded.confidence,
        source = excluded.source,
        updated_at = excluded.updated_at
    `).run(uid, cid, String(chatName || ''), tag, Number(confidence) || 0, src, Math.floor(at))
    return this.get(uid, cid)
  }

  get(userId, chatWxid) {
    const row = this.#db.prepare('SELECT * FROM group_profiles WHERE user_id = ? AND chat_wxid = ?').get(String(userId || ''), String(chatWxid || ''))
    return row ? map(row) : null
  }

  list(userId) {
    return this.#db.prepare('SELECT * FROM group_profiles WHERE user_id = ? ORDER BY tag, chat_name').all(String(userId || '')).map(map)
  }

  /** 该用户已打标的 chat_wxid 集合（判断"哪些群还没打过标"用）。 */
  taggedIds(userId) {
    return new Set(this.list(userId).map((r) => r.chatWxid))
  }

  /** `chats`（accessibleChats 的返回形状）里还没有画像的那些。
   * 这是"首次为某用户跑 digest 前自动分类"的输入。 */
  untagged(userId, chats = []) {
    const known = this.taggedIds(userId)
    return chats.filter((c) => !known.has(c.chatWxid))
  }

  close() {
    try { this.#db.close() } catch { /* already closed */ }
  }
}

function map(row) {
  return {
    userId: row.user_id,
    chatWxid: row.chat_wxid,
    chatName: row.chat_name || '',
    tag: row.tag,
    confidence: Number(row.confidence) || 0,
    source: row.source || 'auto',
    updatedAt: Number(row.updated_at) || 0,
  }
}
