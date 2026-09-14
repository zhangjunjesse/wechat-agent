import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGapLine, GAP_THRESHOLD_MS, PACE_RULES } from '../src/llm/conversation-pace.mjs'
import { humanizeGap } from '../src/services/time.mjs'

const NOW = Date.parse('2026-09-11T06:00:00Z')

test('GAP_THRESHOLD_MS defaults to 2 hours', () => {
  assert.equal(GAP_THRESHOLD_MS, 2 * 3600 * 1000)
})

test('buildGapLine: first chat (updatedAt=0) injects nothing', () => {
  assert.equal(buildGapLine(0, NOW), '')
})

test('buildGapLine: gap within or at threshold injects nothing', () => {
  assert.equal(buildGapLine(NOW - 30 * 60 * 1000, NOW), '')            // 30 min
  assert.equal(buildGapLine(NOW - 2 * 3600 * 1000, NOW), '')           // exactly 2h (not beyond)
  assert.equal(buildGapLine(NOW - (2 * 3600 * 1000 - 1000), NOW), '')  // 1h59m59s
})

test('buildGapLine: gap beyond threshold injects 距上次对话 line', () => {
  assert.equal(buildGapLine(NOW - (4 * 86400000 + 3 * 3600000), NOW), '距上次对话：4 天 3 小时。')
  assert.equal(buildGapLine(NOW - 3 * 3600 * 1000, NOW), '距上次对话：3 小时。')
})

test('humanizeGap: minute/hour/day boundaries', () => {
  assert.equal(humanizeGap(0), '0 分钟')
  assert.equal(humanizeGap(25 * 60000), '25 分钟')
  assert.equal(humanizeGap(3 * 3600 * 1000), '3 小时')
  assert.equal(humanizeGap(3 * 3600 * 1000 + 25 * 60000), '3 小时 25 分钟')
  assert.equal(humanizeGap(4 * 86400000 + 3 * 3600000), '4 天 3 小时')
  assert.equal(humanizeGap(4 * 86400000), '4 天')
  assert.equal(humanizeGap(32 * 86400000 + 5 * 3600000), '32 天')
})

test('PACE_RULES: pace rules exist and carry the 对话节奏 header', () => {
  assert.ok(Array.isArray(PACE_RULES) && PACE_RULES.length >= 4)
  assert.equal(PACE_RULES[0], '【对话节奏】')
  const text = PACE_RULES.join('\n')
  assert.match(text, /不主动硬接旧话题/)
  assert.match(text, /数小时内.*正常连续对话/)
})
