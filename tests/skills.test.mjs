import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { SkillRegistry } from '../src/skills/skill-registry.mjs'

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
