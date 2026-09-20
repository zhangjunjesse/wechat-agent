import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createProgressNotifier } from './progress-notifier.mjs'
import { parseAttachment } from './wechat-log-store.mjs'
import { beijingDateTimeStr } from './time.mjs'
import { friendlyChatErrorText, logServerError } from './failure-messaging.mjs'

/** 私聊消息巡检器（私聊入口：收走 wechat-sync，发走 iLink 私聊）。
 *
 * 背景（ADR-0043，2026-09-20）：用户微信里的「助手」联系人**不是** iLink 绑定的
 * bot 账号，用户发给它的消息不会进 iLink 事件流——但公网 wechat-sync 会把这段私聊
 * 采进 sync_inbox.db（`chat_wxid = 用户 wxid`、`chat_display = 用户昵称`、用户发出的
 * 行 `sender='them'`）。所以照 GroupCommandWatcher（ADR-0022，群 @助手 入口）的骨架，
 * 加一个定时器轮询**私聊**消息，当作"用户给 agent 发消息"处理，回复走 iLink 私聊。
 *
 * 与群版的三处差异（防错杀/防循环）：
 *  1. 检索面：`is_group = 0 AND sender = 'them'`（只处理用户发出的，跳过 agent
 *     自己发的 `sender='me'`——否则 agent 的回复会被再扫到、无限循环）；
 *  2. 排除自身落库：`account != 'agent'`——ConversationLog（ADR-0042）写的行
 *     （iLink 已处理过的用户消息）不算新消息；
 *  3. 双通道去重：同一用户消息可能 iLink 收过（已回复）又被同步库扫到，处理前查
 *     `account='agent'` 同 chat+同内容+±60s 的行，命中即跳过，避免重复回复。
 *
 * 其余（游标落盘、msg_id 内存去重、身份分级匹配 ADR-0032、进度反馈、失败收口）
 * 与 GroupCommandWatcher 完全一致。 */
export class PrivateChatWatcher {
  #db
  #agent
  #provider
  #profileStore
  #contextTokens
  #cursorFile
  #cursor = 0
  #seen = new Set()
  #intervalMs
  #onError
  #progress
  #timer = null
  #running = false
  #dedupStmt

  constructor({ dbFile, agent, provider, profileStore, contextTokens, cursorFile = 'data/private-chat-watcher-cursor.json', intervalMs = 5000, onError = null, initialCursor = null, progress = {} }) {
    this.#db = new DatabaseSync(dbFile, { readOnly: true })
    this.#agent = agent
    this.#provider = provider
    this.#profileStore = profileStore
    this.#contextTokens = contextTokens
    this.#cursorFile = cursorFile
    this.#intervalMs = intervalMs
    this.#onError = onError
    this.#progress = progress
    this.#dedupStmt = this.#db.prepare(
      "SELECT 1 FROM messages WHERE account = 'agent' AND chat_wxid = ? AND content = ? AND ts BETWEEN ? - 60 AND ? + 60 LIMIT 1"
    )
    try {
      const saved = JSON.parse(fs.readFileSync(cursorFile, 'utf8'))
      this.#cursor = Number(saved?.ts || 0)
    } catch {
      // 无游标（首次启动）：不追溯历史，只处理启动之后的新消息（测试可传 initialCursor=0 追溯）
      this.#cursor = initialCursor != null ? Number(initialCursor) : Math.floor(Date.now() / 1000)
    }
  }

  start() {
    if (this.#timer) return
    this.#timer = setInterval(() => { void this.#tick() }, this.#intervalMs)
    this.#timer.unref?.()
    void this.#tick()
  }

  stop() {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = null }
    this.#flushCursor()
  }

  /** 释放只读 DB 句柄（Windows 上不关就删不掉测试临时库）。 */
  close() {
    try { this.#db.close() } catch { /* 关闭失败无意义 */ }
  }

  /** 跑一轮（测试/手动触发）。 */
  sweep() {
    return this.#tick()
  }

  async #tick() {
    if (this.#running) return
    this.#running = true
    try {
      const rows = this.#db.prepare(`
        SELECT msg_id, chat_wxid, chat_display, ts, sender_wxid, sender_display, content, attachment
        FROM messages
        WHERE is_group = 0 AND sender = 'them' AND (account IS NULL OR account != 'agent') AND ts > ?
        ORDER BY ts ASC LIMIT 20
      `).all(this.#cursor)
      if (!rows.length) return
      for (const row of rows) {
        const id = String(row.msg_id || `${row.chat_wxid}:${row.ts}`)
        if (this.#seen.has(id)) continue
        this.#seen.add(id)
        if (this.#seen.size > 1000) this.#seen.delete(this.#seen.values().next().value)
        try {
          await this.#handle(row)
        } catch (e) {
          this.#onError?.(e, row)
        }
        if (Number(row.ts) > this.#cursor) this.#cursor = Number(row.ts)
      }
      this.#flushCursor()
    } finally {
      this.#running = false
    }
  }

  async #handle(row) {
    // 0) 双通道去重：这条用户消息若已被 iLink 收过（ConversationLog 落过 agent 行），
    //    就不再处理——否则 bot 活着时用户消息会收到两遍回复。
    const dup = this.#dedupStmt.get(row.chat_wxid, row.content, Number(row.ts), Number(row.ts))
    if (dup) return

    // 1) 身份匹配：私聊的 chat_wxid/sender_wxid 就是用户 wxid，wxid 优先、昵称降级
    //    （ADR-0032 分级；昵称降级撞同名多个 wxid 时宁可不响应）。
    const senderWxid = String(row.sender_wxid || row.chat_wxid || '').trim()
    const sender = String(row.sender_display || row.chat_display || '').trim()
    const profiles = await this.#profileStore.list()
    const byWxid = senderWxid ? profiles.filter((p) => p?.wxid && p.wxid === senderWxid) : []
    let matched
    if (byWxid.length) {
      matched = byWxid
    } else if (sender) {
      const byNickname = profiles.filter((p) => p?.nickname && p.nickname === sender)
      const distinctWxids = new Set(byNickname.map((p) => String(p?.wxid || '')).filter(Boolean))
      matched = distinctWxids.size > 1 ? [] : byNickname
    } else {
      matched = []
    }
    // 同名档案可能有多个（含无 token 的测试/历史残留）：选第一个有有效私聊通道的
    let user = null
    for (const p of matched) {
      const ilinkId = p?.ilinkUserId || p?.userId
      if (this.#contextTokens.get(ilinkId)?.contextToken) { user = p; break }
    }
    if (!user) return // 陌生私聊 / 无有效回复通道：跳过（只推进游标，不打扰）

    // 2) 私聊推送通道：该用户的 iLink contextToken（与群命令/日报推送同源）。
    //    会话键统一用 ilinkUserId，保证与 iLink 私聊/群命令共用同一会话记忆。
    const profile = await this.#profileStore.get(user.userId)
    const userId = profile?.ilinkUserId || user.userId
    const ilinkId = userId
    const cached = this.#contextTokens.get(ilinkId)
    if (!cached?.contextToken) return

    // 3) 附件描述（与群版一致）：quote/图片/文件/链接如实描述，取文件由 agent 决定
    const attach = parseAttachment(row.attachment)
    let quoted = ''
    let attachmentNote = ''
    if (attach?.kind === 'quote') {
      quoted = String(attach.quotedText || '')
    } else if (attach && ['image', 'file', 'video', 'voice', 'sticker'].includes(attach.kind)) {
      const label = { image: '图片', file: '文件', video: '视频', voice: '语音', sticker: '表情' }[attach.kind]
      attachmentNote = attach.available === false
        ? `📎 这条消息带了一个${label}附件${attach.filename ? `「${attach.filename}」` : ''}，但还没同步完成，暂时取不到${attach.reason ? `（${attach.reason}）` : ''}。`
        : `📎 这条消息带了一个${label}附件${attach.filename ? `「${attach.filename}」` : ''}，如需查看/处理可用 wechat_fetch_chat_file 取回（chat=「${row.chat_display || row.chat_wxid}」，time=${beijingDateTimeStr(Number(row.ts) * 1000)}）。`
    } else if (attach?.kind === 'link') {
      attachmentNote = `🔗 这条消息带了一个分享链接：${[attach.title, attach.url].filter(Boolean).join(' ')}`
    }
    const instruction = String(row.content || '').trim()

    // 4) 构造入站提示（场景 + 内容 + 出处 + 能力提示），与群版同一语气
    const text = [
      `【微信私聊消息】用户 ${sender} 给你发来一条私聊，请处理：`,
      quoted ? `📌 引用的消息内容：\n${quoted}` : '',
      attachmentNote,
      instruction ? `🗣 用户的话：${instruction}` : '（这条消息只有附件，没有文字）',
      `📍 发送时间：${new Date(Number(row.ts) * 1000).toISOString()}`,
      '处理完成后请把结果私聊推送给用户。',
      '如需上下文，可用 wechat_search_chat 查询与该用户的私聊记录（控制条数）；能力类问题简洁回答。',
    ].filter(Boolean).join('\n')

    // 5) 长任务体验：统一进度反馈器 + agent 处理 + 结果推送
    const push = (msg) => this.#provider.sendText({ providerBotId: cached.providerBotId, toProviderUserId: ilinkId, contextToken: cached.contextToken, text: msg })
    const notifier = createProgressNotifier({ provider: this.#provider, channel: { providerBotId: cached.providerBotId, toProviderUserId: ilinkId, contextToken: cached.contextToken }, ...this.#progress })
    notifier.start()
    let reply
    try {
      reply = await this.#agent.respond({
        userId,
        text,
        profile,
        channel: { type: 'ilink', providerBotId: cached.providerBotId, toProviderUserId: ilinkId, contextToken: cached.contextToken },
      })
    } catch (error) {
      notifier.stop()
      logServerError('private-chat-watcher', error, { userId })
      await push(friendlyChatErrorText(error))
      throw error
    }
    notifier.stop()
    const out = typeof reply?.text === 'string' ? reply.text : String(reply ?? '')
    if (out) await push(out)
  }

  #flushCursor() {
    try {
      const dir = path.dirname(path.resolve(this.#cursorFile))
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(this.#cursorFile, JSON.stringify({ ts: this.#cursor }), 'utf8')
    } catch { /* cursor 落盘失败不致命 */ }
  }
}
