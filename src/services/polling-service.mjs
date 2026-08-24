export class PollingService {
  #provider
  #router
  #intervalMs
  #timers = new Map()
  #seen = new Map()

  constructor({ provider, router, intervalMs = 1_000, onError = null, onEvent = null }) {
    this.#provider = provider; this.#router = router; this.#intervalMs = intervalMs
    this.onError = onError; this.onEvent = onEvent
  }

  start(providerBotId) {
    if (this.#timers.has(providerBotId)) return
    const tick = async () => {
      try {
        const result = await this.#provider.pollEvents({ providerBotId })
        const seen = this.#seen.get(providerBotId) || new Set()
        for (const event of result.events || []) {
          const id = event.providerMessageId
          if (id && seen.has(id)) continue
          if (id) { seen.add(id); if (seen.size > 1000) seen.delete(seen.values().next().value) }
          await this.onEvent?.(event)
          await this.#router.handleInbound(event)
        }
        this.#seen.set(providerBotId, seen)
      } catch (error) { this.onError?.(error, providerBotId) }
    }
    const timer = setInterval(tick, this.#intervalMs); timer.unref?.()
    this.#timers.set(providerBotId, timer); void tick()
  }

  stop(providerBotId) {
    const timer = this.#timers.get(providerBotId)
    if (!timer) return false
    clearInterval(timer); this.#timers.delete(providerBotId); this.#seen.delete(providerBotId); return true
  }

  stopAll() { for (const id of this.#timers.keys()) this.stop(id) }
}
