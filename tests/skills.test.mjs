import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { SkillRegistry } from '../src/skills/skill-registry.mjs'

test('skill registry discovers, lists and loads skills', () => {
  const dir = path.join(os.tmpdir(), `sk-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(path.join(dir, 'demo'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: 演示技能\n---\n步骤：做演示')
  try {
    const reg = new SkillRegistry({ dir })
    assert.equal(reg.list().length, 1)
    assert.equal(reg.list()[0].name, 'demo')
    assert.match(reg.get('demo').instructions, /做演示/)
    assert.match(reg.catalogText(), /demo/)
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {}
  }
})
