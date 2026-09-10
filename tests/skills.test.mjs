import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { SkillRegistry, validateSkillContent, parseSkillText } from '../src/skills/skill-registry.mjs'

function writeSkill(dir, name, description, body) {
  fs.mkdirSync(path.join(dir, name), { recursive: true })
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`)
}

function makeDirs() {
  const base = path.join(os.tmpdir(), `sk-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const dir = path.join(base, 'global')
  const userSkillsRoot = path.join(base, 'user-skills')
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(userSkillsRoot, { recursive: true })
  return { base, dir, userSkillsRoot }
}

test('global skills are discovered, listed and loaded without a userId', () => {
  const { base, dir, userSkillsRoot } = makeDirs()
  writeSkill(dir, 'demo', '演示技能', '步骤：做演示')
  try {
    const reg = new SkillRegistry({ dir, userSkillsRoot })
    assert.equal(reg.list().length, 1)
    assert.equal(reg.list()[0].name, 'demo')
    assert.match(reg.get(undefined, 'demo').instructions, /做演示/)
    assert.match(reg.catalogText(), /demo/)
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }) } catch (e) {}
  }
})

test('private skills are isolated per user: owner sees and loads it, another user does not', () => {
  const { base, dir, userSkillsRoot } = makeDirs()
  writeSkill(path.join(userSkillsRoot, 'userA'), 'my-thing', '用户A的私有技能', '只有A能用')
  try {
    const reg = new SkillRegistry({ dir, userSkillsRoot })
    const aList = reg.list('userA')
    assert.equal(aList.length, 1)
    assert.equal(aList[0].name, 'my-thing')
    assert.equal(aList[0].private, true)
    assert.match(reg.get('userA', 'my-thing').instructions, /只有A能用/)

    // another user's view: cannot see or load userA's private skill
    assert.equal(reg.list('userB').length, 0)
    assert.equal(reg.get('userB', 'my-thing'), null)
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }) } catch (e) {}
  }
})

test('a user sees global (enabled) skills plus their own private skills', () => {
  const { base, dir, userSkillsRoot } = makeDirs()
  writeSkill(dir, 'word-report', '生成 Word 文档', 'global steps')
  writeSkill(path.join(userSkillsRoot, 'userA'), 'my-thing', '私有技能', 'private steps')
  try {
    const reg = new SkillRegistry({ dir, userSkillsRoot })
    const names = reg.list('userA').map((s) => s.name).sort()
    assert.deepEqual(names, ['my-thing', 'word-report'])
    assert.match(reg.catalogText('userA'), /word-report/)
    assert.match(reg.catalogText('userA'), /my-thing/)
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }) } catch (e) {}
  }
})

test('resolveEnabled: profile enabledSkills overrides server default; explicit [] disables all global but keeps private', () => {
  const { base, dir, userSkillsRoot } = makeDirs()
  writeSkill(dir, 'a', 'skill a', 'a')
  writeSkill(dir, 'b', 'skill b', 'b')
  writeSkill(path.join(userSkillsRoot, 'userA'), 'mine', '私有', 'mine')
  try {
    const reg = new SkillRegistry({ dir, userSkillsRoot, defaultEnabled: new Set(['a']) })
    // undefined -> server default (only 'a')
    assert.deepEqual(reg.list('userA', reg.resolveEnabled(undefined)).map((s) => s.name).sort(), ['a', 'mine'])
    // explicit list overrides default
    assert.deepEqual(reg.list('userA', reg.resolveEnabled(['b'])).map((s) => s.name).sort(), ['b', 'mine'])
    // explicit [] disables all global, private still visible
    assert.deepEqual(reg.list('userA', reg.resolveEnabled([])).map((s) => s.name), ['mine'])
    // disabled global skill cannot be loaded by name either
    assert.equal(reg.get('userA', 'b', reg.resolveEnabled(['a'])), null)
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }) } catch (e) {}
  }
})

test('DEFAULT_SKILLS-style constructor default: unset (null) enables all global skills', () => {
  const { base, dir, userSkillsRoot } = makeDirs()
  writeSkill(dir, 'a', 'skill a', 'a')
  writeSkill(dir, 'b', 'skill b', 'b')
  try {
    const reg = new SkillRegistry({ dir, userSkillsRoot })
    assert.deepEqual(reg.list('anyone').map((s) => s.name).sort(), ['a', 'b'])
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }) } catch (e) {}
  }
})

test('a private skill takes precedence over a same-named global skill for its owner', () => {
  const { base, dir, userSkillsRoot } = makeDirs()
  writeSkill(dir, 'demo', '全局版本', 'global body')
  writeSkill(path.join(userSkillsRoot, 'userA'), 'demo', '私有版本', 'private body')
  try {
    const reg = new SkillRegistry({ dir, userSkillsRoot })
    assert.match(reg.get('userA', 'demo').instructions, /private body/)
    assert.equal(reg.get('userA', 'demo').private, true)
    // another (unrelated) user still gets the global version
    assert.match(reg.get('userB', 'demo').instructions, /global body/)
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }) } catch (e) {}
  }
})

test('frontmatter version/author/updated_at are parsed and surfaced', () => {
  const { base, dir, userSkillsRoot } = makeDirs()
  const name = 'vskill'
  fs.mkdirSync(path.join(dir, name), { recursive: true })
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), '---\nname: vskill\ndescription: 带版本\nversion: 2.1.0\nauthor: alice\nupdated_at: 2026-09-01\n---\nbody')
  try {
    const reg = new SkillRegistry({ dir, userSkillsRoot })
    const s = reg.get(undefined, name)
    assert.equal(s.version, '2.1.0')
    assert.equal(s.author, 'alice')
    assert.equal(s.updatedAt, '2026-09-01')
    assert.match(reg.catalogForTool(), /vskill v2\.1\.0/)
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }) } catch (e) {}
  }
})

test('catalogForTool lists name + one-liner, marks private skills, and caps with an overflow hint', () => {
  const { base, dir, userSkillsRoot } = makeDirs()
  for (let i = 0; i < 30; i++) writeSkill(dir, `s${i}`, `技能 ${i} 说明`, `body ${i}`)
  writeSkill(path.join(userSkillsRoot, 'userA'), 'mine', '我的私有', 'mine body')
  try {
    const reg = new SkillRegistry({ dir, userSkillsRoot })
    const cat = reg.catalogForTool('userA')
    assert.match(cat, /可用技能（31）/)
    assert.match(cat, /- mine（私有）/)
    assert.match(cat, /- s0: 技能 0 说明/)
    assert.match(cat, /另外 6 个/)
    assert.match(cat, /name=list/)
    // full catalog via cap 0
    const full = reg.catalogForTool('userA', undefined, 0)
    assert.match(full, /- s29: 技能 29 说明/)
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }) } catch (e) {}
  }
})

test('validateSkillContent rejects bad names, missing frontmatter and oversized content', () => {
  assert.equal(validateSkillContent({ name: 'bad name!', content: '---\nname: bad name!\ndescription: x\n---\nb' }).ok, false)
  assert.equal(validateSkillContent({ name: '../evil', content: '---\nname: ../evil\ndescription: x\n---\nb' }).ok, false)
  assert.equal(validateSkillContent({ name: 'ok', content: 'no frontmatter' }).ok, false)
  assert.equal(validateSkillContent({ name: 'ok', content: '---\ndescription: 缺 name\n---\nb' }).ok, false)
  assert.equal(validateSkillContent({ name: 'ok', content: '---\nname: other\ndescription: x\n---\nb' }).ok, false) // name mismatch
  assert.equal(validateSkillContent({ name: 'ok', content: '---\nname: ok\ndescription: x\n---\nb' }).ok, true)
  assert.equal(validateSkillContent({ name: 'ok', content: '---\nname: ok\n---\nb' }).ok, false) // missing description
  const big = 'x'.repeat(64 * 1024 + 1)
  assert.equal(validateSkillContent({ name: 'ok', content: `---\nname: ok\ndescription: x\n---\n${big}` }).ok, false)
})

test('parseSkillText splits frontmatter meta from body', () => {
  const { meta, instructions } = parseSkillText('---\nname: a\ndescription: b\n---\nbody text')
  assert.deepEqual(meta, { name: 'a', description: 'b' })
  assert.equal(instructions, 'body text')
})

test('addSkill writes a hot-effective global skill; removeSkill deletes it', () => {
  const { base, dir, userSkillsRoot } = makeDirs()
  try {
    const reg = new SkillRegistry({ dir, userSkillsRoot })
    const content = '---\nname: newskill\ndescription: 新增技能\nversion: 0.1.0\n---\n新技能步骤'
    const r = reg.addSkill({ name: 'newskill', content })
    assert.equal(r.ok, true)
    assert.match(reg.get(undefined, 'newskill').instructions, /新技能步骤/)
    assert.equal(reg.get(undefined, 'newskill').version, '0.1.0')
    assert.equal(reg.addSkill({ name: 'bad name', content }).ok, false) // rejected, nothing written
    const rm = reg.removeSkill({ name: 'newskill' })
    assert.equal(rm.ok, true)
    assert.equal(reg.get(undefined, 'newskill'), null)
    assert.equal(reg.removeSkill({ name: '../escape' }).ok, false)
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }) } catch (e) {}
  }
})
