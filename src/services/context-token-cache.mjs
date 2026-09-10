import fs from 'node:fs'
import path from 'node:path'

/** iLink contextToken 缓存（定时任务主动推送的前置，见 DESIGN-timed-tasks.md）。
 *
 * iLink 的 `sendText` 强制要求 context_token，而 token 只能从用户最近的入站
 * 消息里拿到——定时任务到点主动推送时没有新入站消息，必须用缓存值。
 * MessageRouter 在每次入站时 update()；TaskScheduler 推送时 get()。
 * 内存 Map + 落盘 JSON（重启恢复，避免服务重启后推送全挂）。
 * 缓存按 iLink 用户 id（toProviderUserId）索引。 */
export class ContextTokenCache {
  #map = new Map() // toProviderUserId -> { contextToken, providerBotId, at }
  #file
  #dirty = false
  #flushTimer = null
  #flushDelayMs

  constructor({ file = path.resolve('data/context-tokens.json'), flushDelayMs = 2000 } = {}) {
    this.#file = file
    this.#flushDelayMs = flushDelayMs
    try {
      const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (rows && typeof rows === 'object') {
        for (const [k, v] of Object.entries(rows)) {
          if (v?.contextToken) this.#map.set(k, v)
        }
      }
    } catch { /* no cache yet */ }
  }

  update(toProviderUserId, { contextToken, providerBotId, at = Date.now() }) {
    if (!toProviderUserId || !contextToken) return
    this.#map.set(String(toProviderUserId), { contextToken, providerBotId, at })
    this.#scheduleFlush()
  }

  get(toProviderUserId) {
    return this.#map.get(String(toProviderUserId)) || null
  }

  /** Flush pending writes and stop the debounce timer. */
  close() {
    if (this.#flushTimer) { clearTimeout(this.#flushTimer); this.#flushTimer = null }
    this.flush()
  }

  /** 落盘（启动/退出时调用；平时防抖自动写）。 */
  flush() {
    const data = {}
    for (const [k, v] of this.#map.entries()) data[k] = v
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true })
      fs.writeFileSync(this.#file, JSON.stringify(data), 'utf8')
      this.#dirty = false
    } catch { /* keep in memory */ }
  }

  #scheduleFlush() {
    this.#dirty = true
    if (this.#flushTimer) return
    this.#flushTimer = setTimeout(() => { this.#flushTimer = null; if (this.#dirty) this.flush() }, this.#flushDelayMs)
    this.#flushTimer.unref?.()
  }
}
