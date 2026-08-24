import { BindingStatus, assertBotProfile } from '../contracts/bot-provider.mjs'

export class BindingService {
  #bindings = new Map()
  #provider
  #clock
  #store

  constructor({ provider, clock = () => Date.now(), store = null }) {
    if (!provider) throw new TypeError('provider is required')
    this.#provider = provider
    this.#clock = clock
    this.#store = store
  }

  async start(userId) {
    assertUserId(userId)
    const qr = await this.#provider.createBindingQr({ userId })
    const binding = {
      id: cryptoRandomId(), userId, providerRef: qr.bindingRef,
      status: BindingStatus.PENDING, qrPayload: qr.qrPayload,
      expiresAt: qr.expiresAt, providerBotId: '', profile: null,
    }
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
    await this.#store?.put(binding)
    return publicBinding(binding)
  }

  applyCallback({ bindingRef, status, providerBotId, profile }) {
    const binding = [...this.#bindings.values()].find((x) => x.providerRef === bindingRef)
    if (!binding) throw new Error('binding not found')
    if (status === BindingStatus.BOUND) {
      if (!providerBotId || !profile) throw new TypeError('bound callback requires bot and profile')
      binding.providerBotId = providerBotId
      binding.profile = assertBotProfile(profile)
    }
    binding.status = status
    this.#store?.put(binding)
    return publicBinding(binding)
  }

  get(userId, bindingId) { return publicBinding(this.#getOwned(userId, bindingId)) }

  #getOwned(userId, bindingId) {
    assertUserId(userId)
    const b = this.#bindings.get(bindingId)
    if (!b || b.userId !== userId) throw new Error('binding not found')
    return b
  }
}

function assertUserId(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('userId is required')
}
function publicBinding(binding) {
  return structuredClone(binding)
}
function cryptoRandomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}
