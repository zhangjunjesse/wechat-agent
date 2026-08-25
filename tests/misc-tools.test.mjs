import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { miscTools } from '../src/tools/misc-tools.mjs'
import { SkillRegistry } from '../src/skills/skill-registry.mjs'

function call(toolFn, input, ctx) {
  return toolFn.invoke(ctx, JSON.stringify(input))
}

function makeRegistry() {
  const base = path.join(os.tmpdir(), `mt-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const dir = path.join(base, 'global')
  fs.mkdirSync(path.join(dir, 'demo'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: 演示技能\n---\n做演示的步骤')
  return { base, registry: new SkillRegistry({ dir, userSkillsRoot: path.join(base, 'user-skills') }) }
}

test('use_skill tool description carries the blocking/forced-invocation language', () => {
  const { base, registry } = makeRegistry()
  try {
    const { useSkill } = miscTools({ skillRegistry: registry })
    assert.match(useSkill.description, /必须先调用/)
    assert.match(useSkill.description, /不得凭猜测|不要凭猜测/)
  } finally { try { fs.rmSync(base, { recursive: true, force: true }) } catch (e) {} }
})

test('use_skill loads a skill\'s full instructions on first call', async () => {
  const { base, registry } = makeRegistry()
  try {
    const { useSkill } = miscTools({ skillRegistry: registry })
    const ctx = { context: { userId: 'u1', loadedSkills: new Set() } }
    const out = await call(useSkill, { name: 'demo' }, ctx)
    assert.match(out, /【技能 demo】/)
    assert.match(out, /做演示的步骤/)
  } finally { try { fs.rmSync(base, { recursive: true, force: true }) } catch (e) {} }
})

test('use_skill avoids re-returning full instructions for a skill already loaded this turn', async () => {
  const { base, registry } = makeRegistry()
  try {
    const { useSkill } = miscTools({ skillRegistry: registry })
    const ctx = { context: { userId: 'u1', loadedSkills: new Set() } }
    const first = await call(useSkill, { name: 'demo' }, ctx)
    assert.match(first, /做演示的步骤/)
    const second = await call(useSkill, { name: 'demo' }, ctx)
    assert.doesNotMatch(second, /做演示的步骤/)
    assert.match(second, /本轮已加载过/)
  } finally { try { fs.rmSync(base, { recursive: true, force: true }) } catch (e) {} }
})

test('use_skill dedupe is scoped per turn (fresh loadedSkills = full instructions again)', async () => {
  const { base, registry } = makeRegistry()
  try {
    const { useSkill } = miscTools({ skillRegistry: registry })
    const turn1 = { context: { userId: 'u1', loadedSkills: new Set() } }
    await call(useSkill, { name: 'demo' }, turn1)
    const turn2 = { context: { userId: 'u1', loadedSkills: new Set() } } // new turn, fresh set
    const out = await call(useSkill, { name: 'demo' }, turn2)
    assert.match(out, /做演示的步骤/)
  } finally { try { fs.rmSync(base, { recursive: true, force: true }) } catch (e) {} }
})

test('use_skill reports available skills when the name does not match, without touching dedupe state', async () => {
  const { base, registry } = makeRegistry()
  try {
    const { useSkill } = miscTools({ skillRegistry: registry })
    const ctx = { context: { userId: 'u1', loadedSkills: new Set() } }
    const out = await call(useSkill, { name: 'nope' }, ctx)
    assert.match(out, /不存在/)
    assert.match(out, /demo/)
  } finally { try { fs.rmSync(base, { recursive: true, force: true }) } catch (e) {} }
})

test('use_skill works without a loadedSkills context (defensive default)', async () => {
  const { base, registry } = makeRegistry()
  try {
    const { useSkill } = miscTools({ skillRegistry: registry })
    const out = await call(useSkill, { name: 'demo' }, { context: { userId: 'u1' } })
    assert.match(out, /做演示的步骤/)
  } finally { try { fs.rmSync(base, { recursive: true, force: true }) } catch (e) {} }
})
