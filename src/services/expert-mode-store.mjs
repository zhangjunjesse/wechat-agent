import fs from 'node:fs'
import path from 'node:path'

/** 专家模式状态存储（ADR-0033）。
 *
 * 语义极小：一张 `userId -> expiresAt(epoch ms)` 的表。开启 = 写入
 * `now + ttlMs`；是否处于专家模式 = **读的时候**比较 `now < expiresAt`。
 *
 * 为什么是惰性过期而不是定时器：本服务的进程会因部署/重启/崩溃随时换一个，
 * 挂在 `setTimeout` 上的"到点恢复默认模型"会随进程一起消失，重启后用户会
 * **永久**停在专家模式上（且没有任何记录说明为什么）。惰性判定把"过期"变成
 * 数据上的事实而不是进程里的承诺：状态落盘的是一个绝对时刻，任何进程在任何
 * 时候读它都会得到同一个答案。代价是过期不会主动通知用户——这是有意的（见
 * ADR-0033「静默恢复」）。
 *
 * `clock` 可注入：过期语义是本模块的全部内容，不可注入就等于不可测。
 *
 * 持久化与仓库其他小状态（`context-tokens.json`）同构：内存 Map 即权威，写入
 * 时同步落盘 JSON。数据量是"当前正处于专家模式的用户数"，天然极小（过期条目
 * 在每次落盘时顺手清掉）。 */
export class ExpertModeStore {
  #map = new Map() // userId -> expiresAt (epoch ms)
  #file
  #clock

  constructor({ file = 'data/expert-mode.json', clock = () => Date.now() } = {}) {
    this.#file = file
    this.#clock = clock
    try {
      const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (rows && typeof rows === 'object') {
        for (const [k, v] of Object.entries(rows)) {
          const at = Number(v)
          if (Number.isFinite(at) && at > 0) this.#map.set(String(k), at)
        }
      }
    } catch { /* 没有存档（首次启动/被清理）= 所有人都是默认模式，不是错误 */ }
  }

  /** 开启（或**刷新**）该用户的专家模式，返回新的到期时刻（epoch ms）。
   * 重复开启是刷新而不是叠加：从当前时刻重新算 ttlMs（ADR-0033）。 */
  enable(userId, ttlMs) {
    const key = String(userId || '')
    if (!key) return 0
    const expiresAt = this.#clock() + Number(ttlMs)
    this.#map.set(key, expiresAt)
    this.#flush()
    return expiresAt
  }

  /** 关闭该用户的专家模式；返回它本来是否处于开启状态（用于措辞区分
   * "已退出" vs "你本来就不在专家模式"）。 */
  disable(userId) {
    const key = String(userId || '')
    const was = this.isActive(key)
    if (this.#map.delete(key)) this.#flush()
    return was
  }

  /** 该用户此刻是否处于专家模式（惰性过期：到点即为 false，无需任何定时器）。 */
  isActive(userId) {
    const at = this.#map.get(String(userId || ''))
    return typeof at === 'number' && this.#clock() < at
  }

  /** 到期时刻（epoch ms）；未开启或已过期返回 0。 */
  expiresAt(userId) {
    return this.isActive(userId) ? this.#map.get(String(userId)) : 0
  }

  #flush() {
    const now = this.#clock()
    const data = {}
    for (const [k, v] of this.#map.entries()) {
      if (v > now) data[k] = v
      else this.#map.delete(k) // 顺手清理过期条目，文件不会无限长大
    }
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true })
      fs.writeFileSync(this.#file, JSON.stringify(data), 'utf8')
    } catch { /* 落盘失败不致命：内存里仍是对的，重启后用户重开一次即可 */ }
  }
}
