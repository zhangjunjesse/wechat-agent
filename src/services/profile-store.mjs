import fs from 'node:fs/promises'
import path from 'node:path'

export class ProfileStore {
  #file
  #records = new Map()       // userId -> profile row
  #byIlink = new Map()       // ilinkUserId -> userId
  #ready
  constructor({ file = path.resolve('data/profiles.json') } = {}) { this.#file = file; this.#ready = this.#load() }
  async #load() {
    try {
      const rows = JSON.parse(await fs.readFile(this.#file, 'utf8'))
      for (const row of Array.isArray(rows) ? rows : []) {
        this.#records.set(row.userId, row)
        if (row.ilinkUserId) this.#byIlink.set(String(row.ilinkUserId), row.userId)
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e }
  }
  async put(userId, profile) {
    await this.#ready
    const row = { userId, ...structuredClone(profile), verifiedAt: new Date().toISOString() }
    this.#records.set(userId, row)
    if (row.ilinkUserId) this.#byIlink.set(String(row.ilinkUserId), userId)
    await fs.mkdir(path.dirname(this.#file), { recursive: true })
    await fs.writeFile(this.#file, JSON.stringify([...this.#records.values()], null, 2), 'utf8')
    return structuredClone(row)
  }
  async get(userId) {
    await this.#ready
    // First try exact userId (browser id or stable id), then by ilinkUserId.
    return structuredClone(this.#records.get(String(userId)) || (this.#byIlink.has(String(userId)) ? this.#records.get(this.#byIlink.get(String(userId))) : null) || null)
  }
  async getByIlink(ilinkUserId) {
    await this.#ready
    const userId = this.#byIlink.get(String(ilinkUserId))
    return userId ? structuredClone(this.#records.get(userId) || null) : null
  }
  /** Resolve any key (browser id or providerUserId) to the stable tenant key
   * (providerUserId). Falls back to the input when no ilinkUserId is known
   * (e.g. unverified user). */
  async stableKey(userId) {
    const profile = await this.get(userId)
    return profile?.ilinkUserId || String(userId)
  }
}
