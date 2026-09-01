import { assertInboundEvent } from '../contracts/bot-provider.mjs'

export class MessageRouter {
  #bindings
  #conversations = new Map()
  #provider
  #agent
  #allowPeerUsers
  #contextProvider
  #requireVerified

  constructor({ bindings, provider, agent, allowPeerUsers = false, contextProvider = null, requireVerified = true }) {
    this.#bindings = bindings
    this.#provider = provider
    this.#agent = agent
    this.#allowPeerUsers = allowPeerUsers
    this.#contextProvider = contextProvider
    this.#requireVerified = requireVerified
  }

  async handleInbound(event) {
    const normalized = assertInboundEvent(event)
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
    const reply = await this.#agent.respond({ userId: tenantKey, history, text: normalized.text || '用户发送了附件。', profile, channel, attachments: normalized.attachments || [] })
    history.push({ role: 'assistant', text: reply.text })
    this.#conversations.set(key, history)
    const sent = await this.#provider.sendText({ providerBotId: normalized.providerBotId, toProviderUserId: normalized.providerUserId, text: reply.text, contextToken: normalized.contextToken })
    return { accepted: true, duplicate: false, providerMessageId: sent.providerMessageId, text: reply.text }
  }
}
