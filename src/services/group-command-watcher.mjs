import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 群命令监听器（群聊入口：收走 wechat-sync，发走 iLink 私聊）。
 *
 * iLink bot 收不到群消息（实测），但公网 wechat-sync 服务实时收集用户所在群的
 * 聊天记录（sync_inbox.db，只读挂载）。本监听器轮询其中「已验证用户所在群、
 * 且 @助手 的新消息」：
 *
 *   - 解析引用：`messages.attachment` 为 JSON `{kind:'quote', quoted_text,...}`，
 *     被引用的完整文本（如飞书文档链接）在 quoted_text 里；
 *   - 身份匹配：sender_display/sender_wxid 命中已验证用户（profileStore.list）；
 *   - 构造入站提示（场景 + 引用内容 + 指令 + 出处 + 能力提示），交给 agent：
 *     agent 可用 wechat_search_chat 自取群历史、lark_* 处理文档，按需调用；
 *   - 结果经 iLink 私聊 sendText 推送给该用户（bot 私聊通道，日报已验证）。
 *
 * 防重：msg_id 内存去重 + ts 游标落盘（data/group-watcher-cursor.json），
 * 重启后从游标继续，不重复处理。 */
export class GroupCommandWatcher {
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
  #timer = null
  #running = false

  constructor({ dbFile, agent, provider, profileStore, contextTokens, cursorFile = 'data/group-watcher-cursor.json', intervalMs = 5000, onError = null, initialCursor = null }) {
    this.#db = new DatabaseSync(dbFile, { readOnly: true })
    this.#agent = agent
    this.#provider = provider
    this.#profileStore = profileStore
    this.#contextTokens = contextTokens
    this.#cursorFile = cursorFile
    this.#intervalMs = intervalMs
    this.#onError = onError
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
        WHERE is_group = 1 AND content LIKE ? AND ts > ?
        ORDER BY ts ASC LIMIT 20
      `).all('%@助手%', this.#cursor)
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
    // 1) 身份匹配：sender 命中哪些已验证用户（别人 @助手 不响应）
    const sender = String(row.sender_display || '').trim()
    const senderWxid = String(row.sender_wxid || '').trim()
    const profiles = await this.#profileStore.list()
    const matched = profiles.filter((p) => (p?.nickname && sender && p.nickname === sender) || (p?.wxid && senderWxid && p.wxid === senderWxid))
    // 同名档案可能有多个（含无 token 的测试/历史残留）：选第一个有有效私聊通道的
    let user = null
    for (const p of matched) {
      const ilinkId = p?.ilinkUserId || p?.userId
      if (this.#contextTokens.get(ilinkId)?.contextToken) { user = p; break }
    }
    if (!user) return // 陌生人/无有效通道：跳过

    // 2) 私聊推送通道：该用户的 iLink contextToken（日报推送同源）
    // 会话键统一用 ilinkUserId（= 私聊的 providerUserId），保证群消息与私聊
    // 共用同一会话历史/记忆，不分裂成两套上下文。
    const profile = await this.#profileStore.get(user.userId)
    const userId = profile?.ilinkUserId || user.userId
    const ilinkId = userId
    const cached = this.#contextTokens.get(ilinkId)
    if (!cached?.contextToken) return

    // 3) 引用解析（attachment.kind=quote → quoted_text）
    let quoted = ''
    try {
      const a = JSON.parse(String(row.attachment || ''))
      if (a?.kind === 'quote') quoted = String(a.quoted_text || '')
    } catch { /* 非 JSON 引用 */ }
    const instruction = String(row.content || '').replace(/@助手/g, '').replace(/\u2005/g, '').trim()
    const chatName = row.chat_display || row.chat_wxid

    // 4) 构造入站提示（场景 + 引用 + 指令 + 出处 + 能力提示）
    const text = [
      `【微信群消息】用户 ${sender} 在群「${chatName}」里 @ 了你${quoted ? '，引用了一条消息' : ''}，请处理：`,
      quoted ? `📌 引用的消息内容：\n${quoted}` : '',
      instruction ? `🗣 用户的指令：${instruction}` : '',
      `📍 发送时间：${new Date(Number(row.ts) * 1000).toISOString()}`,
      '处理完成后请把结果私聊推送给用户。',
      `如需更多上下文，可用 wechat_search_chat 查询群「${chatName}」最近的聊天记录；引用内容若是飞书链接用 lark_read_doc 读取；若是文件/图片，如实说明能做什么。`,
    ].filter(Boolean).join('\n')

    // 5) agent 处理 → iLink 私聊推送
    const reply = await this.#agent.respond({
      userId,
      text,
      profile,
      channel: { type: 'ilink', providerBotId: cached.providerBotId, toProviderUserId: ilinkId, contextToken: cached.contextToken },
    })
    const out = typeof reply?.text === 'string' ? reply.text : String(reply ?? '')
    if (out) {
      await this.#provider.sendText({ providerBotId: cached.providerBotId, toProviderUserId: ilinkId, contextToken: cached.contextToken, text: out })
    }
  }

  #flushCursor() {
    try {
      const dir = path.dirname(path.resolve(this.#cursorFile))
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(this.#cursorFile, JSON.stringify({ ts: this.#cursor }), 'utf8')
    } catch { /* cursor 落盘失败不致命 */ }
  }
}
