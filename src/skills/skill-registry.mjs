import fs from 'node:fs'
import path from 'node:path'

/** Lightweight skill system, modeled on Claude Code / workbuddy skills but
 * scoped to declarative directories, with per-user isolation.
 *
 * Two sources, physically separated (same sandboxing idea as file-tools):
 *   - global skills   : <globalDir>/<name>/SKILL.md               (shared, admin-maintained)
 *   - private skills  : <userSkillsRoot>/<userId>/<name>/SKILL.md (owned by one user)
 *
 * A user's *visible* skill set = their enabled global skills (see
 * `resolveEnabled`) + ALL of their own private skills. Private skills are
 * looked up under that user's own directory only — another user's userId
 * physically cannot resolve into them, mirroring the file-tools sandbox.
 *
 * "Enabled global skills" defaults to `DEFAULT_SKILLS` (comma-separated env,
 * admin-configurable) when a profile hasn't set its own `enabledSkills`; if
 * `DEFAULT_SKILLS` is unset, all global skills are enabled by default.
 */
export class SkillRegistry {
  #globalDir
  #userSkillsRoot
  #defaultEnabled // Set<string> | null (null = all global skills)

  constructor({
    dir = process.env.SKILLS_DIR || path.resolve('skills'),
    userSkillsRoot = process.env.USER_SKILLS_ROOT || path.resolve('data/user-skills'),
    defaultEnabled = parseDefaultEnabled(process.env.DEFAULT_SKILLS),
  } = {}) {
    this.#globalDir = dir
    this.#userSkillsRoot = userSkillsRoot
    this.#defaultEnabled = defaultEnabled
  }

  /** All global (shared) skills, regardless of any user's enablement. */
  listGlobal() {
    return listSkillDir(this.#globalDir)
  }

  /** One user's private skills. Physically isolated: reading another user's
   * skills requires their exact userId, which is a server-assigned stable key
   * the caller never sees or controls. */
  listUser(userId) {
    if (!userId) return []
    return listSkillDir(path.join(this.#userSkillsRoot, safeSeg(userId))).map((s) => ({ ...s, private: true }))
  }

  /** Resolve a profile's `enabledSkills` setting to the effective enabled-global
   * set. `undefined` (profile hasn't customized it) falls back to the server
   * default (`DEFAULT_SKILLS` env, or "all" when unset). An explicit `[]` means
   * the user disabled all global skills (still gets their private ones). */
  resolveEnabled(profileEnabledSkills) {
    if (Array.isArray(profileEnabledSkills)) return new Set(profileEnabledSkills)
    return this.#defaultEnabled
  }

  /** Skills visible to `userId`: enabled global skills + all their private ones. */
  list(userId, enabledGlobal = this.#defaultEnabled) {
    const global = this.listGlobal().filter((s) => enabledGlobal == null || enabledGlobal.has(s.name))
    return [...global, ...this.listUser(userId)]
  }

  /** Load one skill's full instructions. Private skills take precedence over a
   * same-named global one. A global skill the user hasn't enabled cannot be
   * loaded even by exact name. */
  get(userId, name, enabledGlobal = this.#defaultEnabled) {
    const own = userId ? findSkill(path.join(this.#userSkillsRoot, safeSeg(userId)), name) : null
    if (own) return { ...own, private: true }
    if (enabledGlobal != null && !enabledGlobal.has(name)) return null
    return findSkill(this.#globalDir, name)
  }

  /** Prompt fragment listing this user's visible skills. */
  catalogText(userId, enabledGlobal = this.#defaultEnabled) {
    const list = this.list(userId, enabledGlobal)
    if (!list.length) return ''
    return '可用技能（用户提到相关需求时可调用 skill 工具加载）：\n' + list.map((s) => `- ${s.name}: ${s.description}`).join('\n')
  }
}

function parseDefaultEnabled(raw) {
  if (!raw) return null // null = all global skills enabled by default
  return new Set(String(raw).split(',').map((s) => s.trim()).filter(Boolean))
}

/** Defend the path join against traversal even though userId is normally a
 * server-assigned stable key (providerUserId), not user-controlled input. */
function safeSeg(userId) {
  return String(userId).replace(/[/\\]/g, '_')
}

function listSkillDir(dir) {
  let names = []
  try { names = fs.readdirSync(dir) } catch (e) { return [] }
  const out = []
  for (const name of names) {
    const f = path.join(dir, name, 'SKILL.md')
    if (!fs.existsSync(f)) continue
    const meta = parseSkill(f)
    if (meta) out.push({ name, ...meta })
  }
  return out
}

function findSkill(dir, name) {
  const f = path.join(dir, String(name), 'SKILL.md')
  if (!fs.existsSync(f)) return null
  const meta = parseSkill(f)
  return meta ? { name, ...meta } : null
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
