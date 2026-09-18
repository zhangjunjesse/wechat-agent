import { assertInboundEvent } from '../contracts/bot-provider.mjs'
import { createProgressNotifier } from './progress-notifier.mjs'
import { friendlyChatErrorText, logServerError } from './failure-messaging.mjs'

export class MessageRouter {
  #bindings
  #conversations = new Map()
  #provider
  #agent
  #allowPeerUsers
  #contextProvider
  #requireVerified
  #contextTokens
  #progress
  #boardStore

  /** `progress` 默认**关闭** ack/心跳（ADR-0037）：实测基线延迟（生产 "你好" 8.8s、
   * "现在几点" 7.6s）本就压在原 8 秒阈值上，结果每句闲聊都先收一条"收到，正在处理"
   * 再收答案——一问两条。长活的反馈通道现在是任务板（ADR-0036：建单即确认、
   * activeForm 心跳、完成通知），这一层不再承担它。需要回来时用
   * `CHAT_PROGRESS_ACK_MS` 设一个**远高于基线**的值（如 45000）而不是恢复 8000。 */
  constructor({ bindings, provider, agent, allowPeerUsers = false, contextProvider = null, requireVerified = true, contextTokens = null, progress = { ackDelayMs: Number(process.env.CHAT_PROGRESS_ACK_MS ?? 0) }, boardStore = null }) {
    this.#bindings = bindings
    this.#provider = provider
    this.#agent = agent
    this.#allowPeerUsers = allowPeerUsers
    this.#contextProvider = contextProvider
    this.#requireVerified = requireVerified
    this.#contextTokens = contextTokens
    this.#progress = progress
    this.#boardStore = boardStore
  }

  async handleInbound(event) {
    const normalized = assertInboundEvent(event)
    // Keep the freshest contextToken per iLink user — the scheduler's
    // proactive push depends on it (see DESIGN-timed-tasks.md).
    this.#contextTokens?.update(normalized.providerUserId, { contextToken: normalized.contextToken, providerBotId: normalized.providerBotId })
    const binding = this.#bindings.find((b) => b.providerBotId === normalized.providerBotId)
    if (!binding) return { accepted: false, reason: 'unknown_bot' }
    if (!this.#allowPeerUsers && binding.profile?.providerUserId !== normalized.providerUserId) {
      return { accepted: false, reason: 'user_mismatch' }
    }
    // Stable tenant key: the iLink user id (providerUserId) is stable across
    // browser sessions; the browser-generated binding.userId is not. Fall back
    // to binding.userId only when no provider id is available (e.g. tests).
    const tenantKey = normalized.providerUserId || binding.profile?.providerUserId || binding.userId
    const key = `${tenantKey}`
    const history = this.#conversations.get(key) || []
    if (history.some((m) => m.providerMessageId === normalized.providerMessageId)) {
      return { accepted: true, duplicate: true }
    }
    history.push({ role: 'user', ...normalized })
    const profile = await this.#contextProvider?.(tenantKey)
    if (this.#requireVerified && !profile?.nickname && !profile?.wxid) {
      const reply = { text: '请先完成身份验证。请在网页中添加微信“助手”，并向助手发送页面显示的验证码。验证通过后，我才能为你提供服务。' }
      await this.#provider.sendText({ providerBotId: normalized.providerBotId, toProviderUserId: normalized.providerUserId, text: reply.text, contextToken: normalized.contextToken })
      return { accepted: true, gated: true }
    }
    // Channel context lets tools (e.g. send_file, ADR-0009) act back through
    // THIS specific WeChat session — providerBotId/contextToken are per-
    // conversation and only known here at the routing layer, never inside
    // the agent itself. Web chat calls agent.respond() with no channel at
    // all, so tools that need it degrade gracefully (see wechat-send-tools.mjs).
    const channel = { type: 'ilink', providerBotId: normalized.providerBotId, toProviderUserId: normalized.providerUserId, contextToken: normalized.contextToken }
    // 长任务体验：8 秒未完成先 ack，之后每 40 秒心跳（避免用户干等无感知）。
    // 发送用最新 token（长任务期间可能刷新）。
    // 心跳内容化（DESIGN-agent-task-board §3.6）：板上有进行中任务时，心跳带
    // 它们的 activeForm（"正在导出季度总结"）而不只是"仍在处理中"。
    const heartbeatText = this.#boardStore
      ? (n, minutes) => {
          const forms = safeActiveForms(this.#boardStore, tenantKey)
          return forms.length
            ? `⏳ 仍在处理中（已约 ${minutes} 分钟）：${forms.slice(0, 2).join('；')}…`
            : `⏳ 仍在处理中（已约 ${minutes} 分钟），请稍候…`
        }
      : undefined
    const notifier = createProgressNotifier({
      provider: this.#provider,
      channel: { ...channel, contextToken: this.#contextTokens?.get(normalized.providerUserId)?.contextToken || normalized.contextToken },
      ...(heartbeatText ? { heartbeatText } : {}),
      ...this.#progress,
    })
    notifier.start()
    let reply
    try {
      reply = await this.#agent.respond({ userId: tenantKey, history, text: normalized.text || '用户发送了附件。', profile, channel, attachments: normalized.attachments || [] })
    } catch (error) {
      // 失败必告知（不再静默——用户至少知道出了问题），但**不再把异常原文发给
      // 用户**（2026-09-18 事故：402 网关报错原文被当回复发出去）——完整错误
      // 先落日志（排查用），用户只看到口语化的一句话（failure-messaging.mjs
      // 统一收口，message-router/group-command-watcher 共用同一份判定与文案）。
      notifier.stop()
      logServerError('message-router', error, { userId: tenantKey })
      const msg = friendlyChatErrorText(error)
      try { await this.#provider.sendText({ providerBotId: normalized.providerBotId, toProviderUserId: normalized.providerUserId, text: msg, contextToken: normalized.contextToken }) } catch { /* 连错误都发不出则只能记日志 */ }
      throw error
    }
    notifier.stop()
    history.push({ role: 'assistant', text: reply.text })
    this.#conversations.set(key, history)
    // Long tool-heavy turns (image gen, research) can take a minute+; the
    // inbound contextToken may expire by then. Prefer the freshest cached
    // token (refreshed by any newer inbound message) and fall back to the
    // inbound one. (See DESIGN-timed-tasks.md for the cache.)
    const fresh = this.#contextTokens?.get(normalized.providerUserId)
    const sendToken = fresh?.contextToken || normalized.contextToken
    const sent = await this.#provider.sendText({ providerBotId: normalized.providerBotId, toProviderUserId: normalized.providerUserId, text: reply.text, contextToken: sendToken })
    return { accepted: true, duplicate: false, providerMessageId: sent.providerMessageId, text: reply.text }
  }
}

/** 板查询失败不能连累心跳（心跳本身已是"失败不影响主流程"的层）。 */
function safeActiveForms(boardStore, userId) {
  try { return (boardStore.activeForms(userId) || []).map((f) => f.text).filter(Boolean) } catch { return [] }
}
