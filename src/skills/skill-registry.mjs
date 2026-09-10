import fs from 'node:fs'
import path from 'node:path'

// Catalog cap for the use_skill tool description (ADR-0013): the description
// lists name+one-liner only, keeping per-turn context small; beyond the cap
// the model is told to call use_skill with name=list for the full catalog.
const SKILL_CATALOG_CAP = 25
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_SKILL_BYTES = 64 * 1024

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
    return '可用技能（下面只是名字+一句话描述；一旦用户需求匹配某一项，必须先调用 use_skill 工具加载该技能完整指令再执行，不得凭猜测直接执行，也不得只是提到技能名却不实际调用）：\n' + list.map((s) => `- ${s.name}: ${s.description}`).join('\n')
  }

  /** Compact catalog for the use_skill tool description (ADR-0013): name +
   * one-liner + version, private marker, capped at SKILL_CATALOG_CAP entries.
   * Full instructions stay out of the prompt until use_skill loads them. */
  catalogForTool(userId, enabledGlobal = this.#defaultEnabled, cap = SKILL_CATALOG_CAP) {
    const list = [...this.list(userId, enabledGlobal)].sort((a, b) => Number(b.private) - Number(a.private) || String(a.name).localeCompare(String(b.name)))
    if (!list.length) return '当前没有可用技能。'
    const shown = cap > 0 ? list.slice(0, cap) : list
    const lines = shown.map((s) => `- ${s.name}${s.private ? '（私有）' : ''}${s.version ? ` v${s.version}` : ''}: ${s.description}`)
    if (list.length > shown.length) lines.push(`- …以及另外 ${list.length - shown.length} 个（调用 use_skill 传 name=list 查看完整目录）`)
    return `可用技能（${list.length}）：\n${lines.join('\n')}`
  }

  /** Add/update a global skill by writing its SKILL.md. Validates the name
   * (safe segment, no traversal), the frontmatter (must carry name+description,
   * name must match) and the size. Hot-effective: next catalog/load sees it. */
  addSkill({ name, content }) {
    const v = validateSkillContent({ name, content })
    if (!v.ok) return v
    const dir = path.join(this.#globalDir, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8')
    return { ok: true, name }
  }

  /** Remove a global skill directory (validated name only — cannot escape the
   * skills root). */
  removeSkill({ name }) {
    if (!SKILL_NAME_RE.test(String(name))) return { ok: false, error: `技能名不合法：${name}` }
    const dir = path.join(this.#globalDir, String(name))
    if (!dir.startsWith(path.resolve(this.#globalDir) + path.sep)) return { ok: false, error: '路径不安全' }
    fs.rmSync(dir, { recursive: true, force: true })
    return { ok: true, name }
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
    const { meta, instructions } = parseSkillText(fs.readFileSync(file, 'utf8'))
    return {
      description: meta.description || '',
      version: meta.version || '',
      author: meta.author || '',
      updatedAt: meta.updated_at || '',
      instructions,
    }
  } catch (e) {
    return { description: '', version: '', author: '', updatedAt: '', instructions: '' }
  }
}

/** Split a SKILL.md into frontmatter meta (lowercased keys) + body. */
export function parseSkillText(raw) {
  const m = String(raw).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return { meta: {}, instructions: String(raw).trim() }
  const meta = {}
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([a-zA-Z_]+):\s*(.*)$/)
    if (mm) meta[mm[1].toLowerCase()] = mm[2].trim()
  }
  return { meta, instructions: m[2].trim() }
}

/** Validate a skill payload before it is written by manage_skill (ADR-0013):
 * name must be a safe segment, content must parse with a name+description
 * frontmatter whose name matches, and must stay under the size cap. */
export function validateSkillContent({ name, content, maxBytes = MAX_SKILL_BYTES }) {
  const n = String(name || '')
  if (!SKILL_NAME_RE.test(n)) return { ok: false, error: `技能名不合法：${JSON.stringify(name)}（只允许小写字母/数字/连字符，1-64 字符）` }
  if (typeof content !== 'string' || !content.trim()) return { ok: false, error: '技能内容为空' }
  if (Buffer.byteLength(content, 'utf8') > maxBytes) return { ok: false, error: `技能内容超过 ${maxBytes / 1024}KB 上限` }
  const { meta } = parseSkillText(content)
  if (!meta.name) return { ok: false, error: '缺少 frontmatter 的 name 字段' }
  if (String(meta.name) !== n) return { ok: false, error: `frontmatter 的 name（${meta.name}）与目录名不一致` }
  if (!meta.description) return { ok: false, error: '缺少 frontmatter 的 description 字段' }
  return { ok: true }
}
