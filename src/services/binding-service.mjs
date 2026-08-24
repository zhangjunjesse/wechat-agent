import { BindingStatus, assertBotProfile } from '../contracts/bot-provider.mjs'

export class BindingService {
  #bindings = new Map()
  #provider
  #clock
  #store
  #onBound

  constructor({ provider, clock = () => Date.now(), store = null, onBound = null }) {
    if (!provider) throw new TypeError('provider is required')
    this.#provider = provider
    this.#clock = clock
    this.#store = store
    this.#onBound = onBound
  }

  async restore() {
    if (!this.#store?.list) return []
    const records = await this.#store.list()
    for (const record of records) this.#bindings.set(record.id, record)
    return records.map(publicBinding)
  }

  async start(userId) {
    assertUserId(userId)
    const qr = await this.#provider.createBindingQr({ userId })
    const binding = { id: cryptoRandomId(), userId, providerRef: qr.bindingRef, status: BindingStatus.PENDING, qrPayload: qr.qrPayload, expiresAt: qr.expiresAt, providerBotId: '', profile: null }
    this.#bindings.set(binding.id, binding)
    await this.#store?.put(binding)
    return publicBinding(binding)
  }

  async refresh(userId, bindingId) {
    const binding = this.#getOwned(userId, bindingId)
    if (binding.status === BindingStatus.BOUND) return publicBinding(binding)
    if (binding.expiresAt <= this.#clock()) {
      binding.status = BindingStatus.EXPIRED
      await this.#store?.put(binding)
      return publicBinding(binding)
    }
    const result = await this.#provider.getBindingStatus({ bindingRef: binding.providerRef })
    binding.status = result.status
    if (result.providerBotId) binding.providerBotId = result.providerBotId
    if (result.profile) binding.profile = assertBotProfile(result.profile)
    if (result.providerSession) binding.providerSession = result.providerSession
    await this.#store?.put(binding)
    if (binding.status === BindingStatus.BOUND) await this.#onBound?.(publicBinding(binding))
    return publicBinding(binding)
  }

  async restoreAndStart() {
    const records = await this.restore()
    for (const record of records) if (record.status === BindingStatus.BOUND) await this.#onBound?.(record)
    return records
  }

  get(userId, bindingId) { return publicBinding(this.#getOwned(userId, bindingId)) }
  list() { return [...this.#bindings.values()].map(publicBinding) }
  #getOwned(userId, bindingId) { assertUserId(userId); const b = this.#bindings.get(bindingId); if (!b || b.userId !== userId) throw new Error('binding not found'); return b }
}
function assertUserId(value) { if (typeof value !== 'string' || !value.trim()) throw new TypeError('userId is required') }
function publicBinding(binding) { return structuredClone(binding) }
function cryptoRandomId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}` }
