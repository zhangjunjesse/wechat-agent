import fs from 'node:fs/promises'
import path from 'node:path'

export class BindingStore {
  #file
  #records = new Map()
  #ready

  constructor({ file = path.resolve('data/bindings.json') } = {}) {
    this.#file = file
    this.#ready = this.#load()
  }

  async #load() {
    try {
      const items = JSON.parse(await fs.readFile(this.#file, 'utf8'))
      for (const item of Array.isArray(items) ? items : []) this.#records.set(item.id, item)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  async list() { await this.#ready; return structuredClone([...this.#records.values()]) }
  async get(id) { await this.#ready; return structuredClone(this.#records.get(id) || null) }
  async put(record) {
    await this.#ready
    this.#records.set(record.id, structuredClone(record))
    await fs.mkdir(path.dirname(this.#file), { recursive: true })
    await fs.writeFile(this.#file, JSON.stringify([...this.#records.values()], null, 2), 'utf8')
    return structuredClone(record)
  }
}
