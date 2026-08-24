import fs from 'node:fs/promises'
import path from 'node:path'

export class ProfileStore {
  #file
  #records = new Map()
  #ready
  constructor({ file = path.resolve('data/profiles.json') } = {}) { this.#file = file; this.#ready = this.#load() }
  async #load() { try { const rows = JSON.parse(await fs.readFile(this.#file, 'utf8')); for (const row of Array.isArray(rows) ? rows : []) this.#records.set(row.userId, row) } catch (e) { if (e.code !== 'ENOENT') throw e } }
  async put(userId, profile) { await this.#ready; const row = { userId, ...structuredClone(profile), verifiedAt: new Date().toISOString() }; this.#records.set(userId, row); await fs.mkdir(path.dirname(this.#file), { recursive: true }); await fs.writeFile(this.#file, JSON.stringify([...this.#records.values()], null, 2), 'utf8'); return structuredClone(row) }
  async get(userId) { await this.#ready; return structuredClone(this.#records.get(userId) || null) }
}
