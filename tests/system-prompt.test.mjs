import test from 'node:test'
import assert from 'node:assert/strict'
import { SAFETY_RULES, TOOL_USAGE_RULES, buildBaseInstructions, buildDynamicSystem } from '../src/llm/system-prompt.mjs'

test('base instructions carry safety rules, tool-usage rules, role behavior and a one-line skill pointer', () => {
  const base = buildBaseInstructions()
  assert.match(base, /安全规则/)
  assert.match(base, /不泄露其他用户的数据/)
  assert.match(base, /简洁但信息完整/)
  assert.match(base, /工具使用规则/)
  assert.match(base, /run_code/)
  assert.match(base, /send_file/)
  assert.match(base, /已经发给你/)
  // The skill catalog itself lives in the use_skill tool description (ADR-0013):
  // the prompt only carries a one-line pointer, never per-skill content.
  assert.match(base, /可用技能的名称与简介见 use_skill 工具描述/)
  assert.doesNotMatch(base, /^可用技能（/m)
})

test('tool usage rules are a non-empty list of 3', () => {
  assert.equal(TOOL_USAGE_RULES.length, 3)
})

test('dynamic system layers role name, identity, time, memory and summary in order', () => {
  const sys = buildDynamicSystem({
    nickname: '张三',
    assistantName: '小新',
    memories: '[用户长期记忆]\n【身份】\n- 会员号12345',
    summary: '此前要点',
    nowMs: Date.parse('2026-08-24T00:00:00Z'),
  })
  const pos = (s) => sys.indexOf(s)
  assert.ok(pos('你的名字是小新') >= 0)
  assert.ok(pos('用户昵称：张三') >= 0)
  assert.match(sys, /今天是 2026-08-24/)
  assert.ok(pos('[用户长期记忆]') >= 0)
  assert.ok(pos('此前对话要点') >= 0)
  // layering order: role → identity → time → memory → summary
  assert.ok(pos('你的名字是小新') < pos('用户昵称：张三'))
  assert.ok(pos('用户昵称：张三') < pos('今天是'))
  assert.ok(pos('今天是') < pos('[用户长期记忆]'))
  assert.ok(pos('[用户长期记忆]') < pos('此前对话要点'))
})

test('dynamic system marks unverified user and defaults assistant name to 助手', () => {
  const sys = buildDynamicSystem({ nowMs: Date.parse('2026-08-24T00:00:00Z') })
  assert.match(sys, /你的名字是助手/)
  assert.match(sys, /尚未完成身份验证/)
  assert.doesNotMatch(sys, /用户昵称：/)
})

test('safety rules are a non-empty list of 4', () => {
  assert.equal(SAFETY_RULES.length, 4)
})
