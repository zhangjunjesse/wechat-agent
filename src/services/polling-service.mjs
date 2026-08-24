export class PollingService {
  #provider
  #router
  #intervalMs
  #timers = new Map()

  constructor({ provider, router, intervalMs = 1_000, onError = null, onEvent = null }) {
    this.#provider = provider
    this.#router = router
    this.#intervalMs = intervalMs
    this.onError = onError
    this.onEvent = onEvent
  }

  start(providerBotId) {
    if (this.#timers.has(providerBotId)) return
    const tick = async () => {
      try {
        const result = await this.#provider.pollEvents({ providerBotId })
        for (const event of result.events || []) {
          await this.onEvent?.(event)
          await this.#router.handleInbound(event)
        }
      } catch (error) { this.onError?.(error, providerBotId) }
    }
    const timer = setInterval(tick, this.#intervalMs)
    timer.unref?.()
    this.#timers.set(providerBotId, timer)
    void tick()
  }

  stop(providerBotId) {
    const timer = this.#timers.get(providerBotId)
    if (!timer) return false
    clearInterval(timer); this.#timers.delete(providerBotId); return true
  }

  stopAll() { for (const id of this.#timers.keys()) this.stop(id) }
}
