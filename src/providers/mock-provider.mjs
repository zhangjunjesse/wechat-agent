export class MockBotProvider {
  #counter = 0
  constructor() { this.bindings = new Map(); this.sent = [] }
  async createBindingQr({ userId }) {
    const bindingRef = `mock-${userId}-${++this.#counter}`
    this.bindings.set(bindingRef, { status: 'pending', userId })
    return { bindingRef, qrPayload: `mock://bind/${bindingRef}`, expiresAt: Date.now() + 60_000 }
  }
  async getBindingStatus({ bindingRef }) {
    const b = this.bindings.get(bindingRef)
    if (!b) throw new Error('unknown mock binding')
    return { status: b.status, providerBotId: b.botId, profile: b.profile }
  }
  bind(bindingRef, { botId, profile }) {
    const b = this.bindings.get(bindingRef)
    if (!b) throw new Error('unknown mock binding')
    b.status = 'bound'; b.botId = botId; b.profile = profile
  }
  async sendText(input) {
    this.sent.push(input)
    return { providerMessageId: `out-${this.sent.length}` }
  }
}
