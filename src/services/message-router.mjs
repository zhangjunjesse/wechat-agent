import { assertInboundEvent } from '../contracts/bot-provider.mjs'

export class MessageRouter {
  #bindings
  #conversations = new Map()
  #provider
  #agent

  constructor({ bindings, provider, agent }) {
    this.#bindings = bindings
    this.#provider = provider
    this.#agent = agent
  }

  async handleInbound(event) {
    const normalized = assertInboundEvent(event)
    const binding = this.#bindings.find((b) => b.providerBotId === normalized.providerBotId)
    if (!binding) return { accepted: false, reason: 'unknown_bot' }
    if (binding.profile?.providerUserId !== normalized.providerUserId) {
      return { accepted: false, reason: 'user_mismatch' }
    }
    const key = `${binding.userId}:${normalized.providerUserId}`
    const history = this.#conversations.get(key) || []
    if (history.some((m) => m.providerMessageId === normalized.providerMessageId)) {
      return { accepted: true, duplicate: true }
    }
    history.push({ role: 'user', ...normalized })
    const reply = await this.#agent.respond({ userId: binding.userId, history, text: normalized.text })
    history.push({ role: 'assistant', text: reply.text })
    this.#conversations.set(key, history)
    const sent = await this.#provider.sendText({ providerBotId: normalized.providerBotId, toProviderUserId: normalized.providerUserId, text: reply.text, contextToken: normalized.contextToken })
    return { accepted: true, duplicate: false, providerMessageId: sent.providerMessageId, text: reply.text }
  }
}
