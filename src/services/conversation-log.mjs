import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'

/** 助手自己的对话落库（ADR-0042，2026-09-19）。
 *
 * 要解决的问题：用户问"我跟助手说过什么"时，`wechat_*` 工具只能读到
 * wechat-sync 从 PC 微信客户端同步上来的那部分私聊——而采集账号是**副设备登录**，
 * 微信不给副设备回补历史文字。生产实测（Z.俊）：助手侧会话记录里用户说了 191 条，
 * 同步库只拿到 71 条，**差 120 条读不到**。
 *
 * 结论：这段对话的唯一可靠来源是助手自己（它逐条处理过）。所以由它把自己的
 * 往来写进同步库，与 wechat-sync 的行同库同表——读侧（`WechatLogStore`）不用改，
 * `wechat_search_chat` 自然就读得到全量。
 *
 * 纪律（与 ADR-0025 的"工具失败不能破坏主流程"一致）：
 *  - **绝不因为落库失败而影响用户回复**——每处调用都吞异常，只记日志；库不可写
 *    （例如挂载仍标 `:ro`）时整体退化为 no-op，功能自动消失而不是报错。
 *  - 行用 `account = 'agent'` 与 wechat-sync 的行区分，便于单独统计/清理。
 *  - `msg_id` 由内容+时间戳派生：重复投递的同一条消息不会写两遍。
 *
 * 已知的、有意接受的局限：这只覆盖**今后**的对话；历史那 120 条补不回来（微信侧
 * 没有）。历史补录是另一件事，见 ADR-0042 的"未覆盖"一节。 */
const ACCOUNT = 'agent'
const SENDER_USER = 'them'
const SENDER_ASSISTANT = 'me'

export class ConversationLog {
  #db
  #insert = null
  #chatWxid
  #chatDisplay
  #ownerDisplay
  #warned = false
  #onWarn

  /** `dbFile` 指向 wechat-sync 的 sync_inbox.db（需可写挂载）。
   * `chatWxid`/`chatDisplay` = 该用户私聊线程的标识与显示名（=用户 wxid/昵称），
   * 与 `WechatLogStore.accessibleChats` 对私聊的判定保持一致（ADR-0007）。 */
  constructor({ dbFile, chatWxid, chatDisplay, ownerDisplay = '', onWarn = defaultWarn } = {}) {
    this.#chatWxid = String(chatWxid || '').trim()
    this.#chatDisplay = String(chatDisplay || '').trim()
    this.#ownerDisplay = String(ownerDisplay || '').trim()
    this.#onWarn = onWarn
    if (!dbFile || !this.#chatWxid) { this.#db = null; return }
    try {
      this.#db = new DatabaseSync(dbFile)
      this.#db.exec('PRAGMA busy_timeout = 4000')
      this.#insert = this.#db.prepare(
        `INSERT OR IGNORE INTO messages
         (msg_id, account, chat_wxid, chat_display, is_group, ts, datetime, sender,
          sender_wxid, sender_display, msg_type, content, attachment, device, received_at)
         VALUES (?,?,?,?,0,?,?,?,?,?,1,?,NULL,'agent',?)`
      )
    } catch (e) {
      this.#db = null
      this.#warn(`打开会话库失败（落库停用）：${e.message}`)
    }
  }

  get enabled() { return Boolean(this.#db && this.#insert) }

  #warn(msg) {
    if (this.#warned) return
    this.#warned = true
    this.#onWarn(msg)
  }

  #write(sender, senderDisplay, senderWxid, text, tsMs) {
    if (!this.enabled) return false
    const content = String(text ?? '').trim()
    if (!content) return false
    const ts = Math.floor((Number(tsMs) || Date.now()) / 1000)
    const msgId = createHash('sha1')
      .update(`${ACCOUNT}|${this.#chatWxid}|${sender}|${ts}|${content}`)
      .digest('hex').slice(0, 32)
    try {
      this.#insert.run(
        msgId, ACCOUNT, this.#chatWxid, this.#chatDisplay, ts,
        new Date(ts * 1000).toISOString(), sender, senderWxid, senderDisplay,
        content, Date.now()
      )
      return true
    } catch (e) {
      // 单条写失败（锁冲突、磁盘满、库被换掉……）不抛给调用方
      this.#warn(`写入会话记录失败：${e.message}`)
      return false
    }
  }

  /** 用户发来的一条消息。`wxid`/`nickname` 来自已验证档案。 */
  recordInbound({ text, wxid = '', nickname = '', tsMs } = {}) {
    return this.#write(SENDER_USER, nickname || this.#chatDisplay, wxid || this.#chatWxid, text, tsMs)
  }

  /** 助手回出去的一条消息（只在真的发出去之后调用）。 */
  recordOutbound({ text, tsMs } = {}) {
    return this.#write(SENDER_ASSISTANT, this.#ownerDisplay || '助手', '', text, tsMs)
  }

  close() {
    try { this.#db?.close() } catch { /* 关闭失败无意义 */ }
    this.#db = null
  }
}

function defaultWarn(msg) {
  console.error(`[conversation-log] ${msg}`)
}
