import fs from 'node:fs'
import path from 'node:path'

/** Lightweight skill system, modeled on Claude Code / workbuddy skills but
 * scoped to a declarative directory. A skill is a folder:
 *   skills/<name>/SKILL.md   (frontmatter name+description, then instructions)
 *
 * `listSkills()` returns available skills for the agent prompt; `loadSkill(name)`
 * returns its instructions to inject on demand. This makes adding a skill a
 * matter of dropping a folder — no code change. */
export class SkillRegistry {
  #dir
  constructor({ dir = process.env.SKILLS_DIR || path.resolve('skills') } = {}) {
    this.#dir = dir
  }
  list() {
    let names = []
    try { names = fs.readdirSync(this.#dir) } catch (e) { return [] }
    const out = []
    for (const name of names) {
      const f = path.join(this.#dir, name, 'SKILL.md')
      if (!fs.existsSync(f)) continue
      const meta = parseSkill(f)
      if (meta) out.push({ name, ...meta })
    }
    return out
  }
  get(name) {
    const f = path.join(this.#dir, name, 'SKILL.md')
    if (!fs.existsSync(f)) return null
    const meta = parseSkill(f)
    return meta ? { name, ...meta } : null
  }
  /** Prompt fragment listing available skills. */
  catalogText() {
    const list = this.list()
    if (!list.length) return ''
    return '可用技能（用户提到相关需求时可调用 skill 工具加载）：\n' + list.map((s) => `- ${s.name}: ${s.description}`).join('\n')
  }
}

function parseSkill(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
    if (!m) return { description: '', instructions: raw.trim() }
    const meta = {}
    for (const line of m[1].split('\n')) {
      const mm = line.match(/^([a-zA-Z_]+):\s*(.*)$/)
      if (mm) meta[mm[1].toLowerCase()] = mm[2].trim()
    }
    return { description: meta.description || '', instructions: m[2].trim() }
  } catch (e) {
    return { description: '', instructions: '' }
  }
}
