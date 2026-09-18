import {
  DEFAULT_TAG,
  MAX_CHATS_PER_USER,
  MAX_MESSAGES_PER_CHAT,
  TAG_SAMPLE_MESSAGES,
  buildDigestMapPrompt,
  buildDigestReducePrompt,
  buildGroupTagPrompt,
  digestItemsOf,
  digestWindowDays,
  parseDigestCandidates,
  parseDigestJson,
  parseGroupTagJson,
  renderDigestPoster,
  renderMessageLines,
} from './wechat-digest.mjs'
import { JSON_RETRY_HINT } from './failure-messaging.mjs'

/** 微信日报/周报的 per-user 生成管道（DESIGN-wechat-digest.md）。
 *
 * 与每日资讯（kind='report'）最本质的区别：那份是**一次生成、全员扇出**的公共
 * 新闻，这份是**每人一份**的私人简报——内容完全来自该用户自己的群，没有任何
 * 可共享的部分。所以这里是 per-user 管道，逐用户串行（防堵塞，同 ADR-0028 的
 * 取舍），单用户失败不影响其他用户（由调用方 task-scheduler 按单元跟踪重试）。
 *
 *   ① 打标   accessibleChats 里还没画像的群 → 一次批量 agent 调用 → group_profiles
 *   ② map    每个活跃群（周期内有消息、tag≠dead）→ 一次 agent 调用 → 候选条目
 *   ③ reduce 全部候选 + 用户画像 + preference 记忆 → 三节 JSON
 *   ④ 入库   ReportStore（kind='wechat-digest'）+ 海报渲染
 *
 * **权限边界**：取数**只**经 `wechatLogStore.accessibleChats(identity)` 和
 * `searchChat(..., identity)`——两者都在 WechatLogStore 内部做租户校验
 * （ADR-0007：只返回用户所在的群 + 他自己的 1:1）。本模块不持有任何绕过该
 * 边界的查询路径，也不接受调用方传入 chat 列表。
 *
 * LLM 调用一律走注入的 `agent`（生产是调度器专属实例，ADR-0028）且
 * `ephemeral: true` + 合成 userId——不污染用户真实 session/记忆。 */
export class WechatDigestRunner {
  #agent
  #wechatLogStore
  #groupProfiles
  #memoryStore
  #reportStore
  #posterRender
  #maxChats
  #unparsableRetries
  #onError

  constructor({ agent, wechatLogStore, groupProfiles, memoryStore = null, reportStore, posterRender = null, maxChats = MAX_CHATS_PER_USER, unparsableRetries = 2, onError = null }) {
    this.#agent = agent
    this.#wechatLogStore = wechatLogStore
    this.#groupProfiles = groupProfiles
    this.#memoryStore = memoryStore
    this.#reportStore = reportStore
    this.#posterRender = posterRender
    this.#maxChats = maxChats
    this.#unparsableRetries = unparsableRetries
    this.#onError = onError
  }

  /** 为一个用户生成一期 digest。
   * @returns `{ ok:true, report, empty }` | `{ ok:false, error }`
   *   - `empty:true`：三节全空（"今天各群平静"）。这是**正常结果**，不是失败——
   *     调用方据此走静默/一句话短文本，绝不能当成生成失败去重试。
   *   - `ok:false`：真失败（LLM 异常、输出无法解析），值得重试。 */
  async generate({ task, userId, profile, now = Date.now() }) {
    const windowDays = digestWindowDays(task.schedule)
    const sinceMs = now - windowDays * 86_400_000
    const identity = { wxid: profile?.wxid || '', nickname: profile?.nickname || '' }
    if (!identity.wxid && !identity.nickname) return { ok: false, error: 'no_identity' }

    try {
      // ① 权限边界：只看 accessibleChats 返回的会话，且只要群（1:1 与助手的
      // 对话不是"读不完的群"，纳进来只会自己跟自己复读）。
      const groups = this.#wechatLogStore.accessibleChats(identity).filter((c) => c.isGroup)
      if (!groups.length) return { ok: true, empty: true, report: null }

      // 周期内有消息的群才值得花一次 LLM 调用。顺便拿到消息供 map 复用，
      // 不重复查库。
      const active = []
      for (const chat of groups) {
        const r = this.#wechatLogStore.searchChat({ chat: chat.chatWxid, sinceMs, untilMs: now, limit: MAX_MESSAGES_PER_CHAT }, identity)
        if (r?.error || !r?.messages?.length) continue
        active.push({ ...chat, messages: r.messages })
      }
      if (!active.length) return { ok: true, empty: true, report: null }
      // 截断护栏：群特别多时按消息量取前 N，并**如实记进 rawText**（静默截断会
      // 让"我的群怎么没被读"变成查无实据的投诉）。
      active.sort((a, b) => b.messages.length - a.messages.length)
      const dropped = Math.max(0, active.length - this.#maxChats)
      const scanned = active.slice(0, this.#maxChats)

      // ② 自动打标（只对还没有画像的群；user 来源的画像在 store 层受保护）
      await this.#ensureTags({ userId, chats: scanned, identity, now })

      // ③ map：逐群抽候选
      const candidates = []
      for (const chat of scanned) {
        const tag = this.#groupProfiles?.get(userId, chat.chatWxid)?.tag || DEFAULT_TAG
        if (tag === 'dead') continue
        const prompt = buildDigestMapPrompt({ chatName: chat.name, tag, nickname: identity.nickname, messages: chat.messages, windowDays })
        let text
        try {
          text = await this.#ask(task, userId, `map-${chat.chatWxid}`, prompt)
        } catch (error) {
          // 单群失败不该毁掉整期——记下来继续下一个群。
          this.#onError?.(error, { stage: 'map', userId, chat: chat.name })
          continue
        }
        const parsed = parseDigestCandidates(text, { chatName: chat.name })
        candidates.push(...parsed.candidates)
      }

      // ④ reduce：合成三节。没有候选时**不调 LLM**，直接判空——空结果是确定的，
      // 花一次调用让模型再确认一遍空只是浪费钱和时间。
      if (!candidates.length) return { ok: true, empty: true, report: null }
      const reducePrompt = buildDigestReducePrompt({
        taskName: task.name,
        instruction: task.instruction,
        candidates,
        profileContent: this.#memoryStore?.getProfile?.(userId)?.content || '',
        preferences: this.#preferences(userId),
        previousTitles: windowDays >= 7 ? this.#reportStore.recentTitles(task.id, 14, 30, { userId, topic: '', now }) : [],
        nickname: identity.nickname,
        windowDays,
        now,
      })
      // 解析失败当场重生成（2026-09-18 事故第 1 件整改，同 task-scheduler
      // #generateAndStore 的策略）：多问模型一次通常比等 retryIntervalMs 更快
      // 自愈，只对"解析失败"生效，次数由 unparsableRetries 封顶。
      let rawText = ''
      let digest = { ok: false }
      for (let attempt = 1; attempt <= this.#unparsableRetries + 1; attempt++) {
        const promptText = attempt === 1 ? reducePrompt : `${reducePrompt}\n\n${JSON_RETRY_HINT}`
        rawText = await this.#ask(task, userId, 'reduce', promptText)
        digest = parseDigestJson(rawText)
        if (digest.ok) break
      }
      if (!digest.ok) return { ok: false, error: 'digest_unparsable', rawText }
      if (digest.empty) return { ok: true, empty: true, report: null }

      // ⑤ 入库 + 海报（复用 ReportStore / poster-render；kind 决定模板与 H5 页）
      const notes = dropped > 0 ? `\n[扫描了 ${scanned.length} 个活跃群，另有 ${dropped} 个因数量上限未扫描]` : ''
      let report = this.#reportStore.saveReport({
        taskId: task.id,
        name: task.name,
        runAt: now,
        focus: digest.focus,
        rawText: rawText + notes,
        items: digestItemsOf(digest.sections),
        userId,
        topic: '',
        kind: 'wechat-digest',
      })
      if (this.#posterRender) {
        try {
          const posterPath = await this.#posterRender(report, renderDigestPoster(report))
          if (posterPath) report = this.#reportStore.saveReport({ ...report, posterPath })
        } catch { /* 海报失败 → 纯文本降级，同日报路径 */ }
      }
      return { ok: true, empty: false, report }
    } catch (error) {
      return { ok: false, error: error.message || String(error), rawText: '' }
    }
  }

  /** 给还没有画像的群批量打标（source='auto'）。已有画像的群一律不碰——尤其
   * `source='user'` 的，GroupProfileStore.put 会直接拒绝覆盖（那是本功能的信任
   * 底线：用户纠正过一次就该一直算数）。
   * 失败不抛：打标只是让提取更准，失败时 map 阶段走 DEFAULT_TAG 照样能出结果。 */
  async #ensureTags({ userId, chats, identity, now }) {
    if (!this.#groupProfiles) return
    const untagged = this.#groupProfiles.untagged(userId, chats)
    if (!untagged.length) return
    const sinceMs = now - 7 * 86_400_000 // 判性质固定看 7 天，与本期窗口无关
    const samples = untagged.map((c) => {
      const r = this.#wechatLogStore.searchChat({ chat: c.chatWxid, sinceMs, untilMs: now, limit: TAG_SAMPLE_MESSAGES }, identity)
      return { chatWxid: c.chatWxid, chatName: c.name, lines: renderMessageLines(r?.messages || []).slice(-TAG_SAMPLE_MESSAGES) }
    })
    try {
      const text = await this.#ask({ id: 'group-tag', name: '群画像' }, userId, 'tag', buildGroupTagPrompt(samples))
      const parsed = parseGroupTagJson(text)
      const nameOf = new Map(untagged.map((c) => [c.chatWxid, c.name]))
      for (const g of parsed.groups) {
        if (!nameOf.has(g.chatWxid)) continue // 模型编了个不在本次样本里的 id → 丢弃
        this.#groupProfiles.put({ userId, chatWxid: g.chatWxid, chatName: nameOf.get(g.chatWxid), tag: g.tag, confidence: g.confidence, source: 'auto', at: now })
      }
    } catch (error) {
      this.#onError?.(error, { stage: 'tag', userId })
    }
  }

  /** preference 类记忆（reduce 阶段的硬约束：用户说过"别给我推 X"就必须生效）。
   * preference/identity 永不自动归档（memory-importance.mjs），所以这里读到的
   * 就是用户表达过的全部有效偏好。 */
  #preferences(userId, limit = 20) {
    try {
      return (this.#memoryStore?.listCategory?.(userId, 'preference') || []).slice(0, limit).map((c) => c.content).filter(Boolean)
    } catch { return [] }
  }

  /** 一次 agent 调用。合成 userId（`task-<id>-<user>-<stage>`，无冒号、Windows
   * 目录名安全）+ `ephemeral: true`：不读写真实用户的 session/记忆，也不让某个
   * 群的 map 上下文串进另一个群（每个 stage 各自独立一轮）。 */
  #ask(task, userId, stage, text) {
    const runUserId = `task-${task.id}-${userId}-${stage}`
    return this.#agent.respond({
      userId: runUserId,
      text,
      profile: { nickname: task.name, wxid: runUserId },
      channel: null,
      ephemeral: true,
    }).then((reply) => (typeof reply?.text === 'string' ? reply.text : String(reply ?? '')))
  }
}
