import test from 'node:test'
import assert from 'node:assert/strict'
import { beijingParse } from '../src/services/time.mjs'

test('beijingParse: minute precision (YYYY-MM-DD HH:mm)', () => {
  const ms = beijingParse('2026-08-24 18:30')
  assert.equal(ms, Date.parse('2026-08-24T18:30:00+08:00'))
})

test('beijingParse: date-only defaults to 00:00, or 23:59 with endOfDay', () => {
  assert.equal(beijingParse('2026-08-24'), Date.parse('2026-08-24T00:00:00+08:00'))
  assert.equal(beijingParse('2026-08-24', { endOfDay: true }), Date.parse('2026-08-24T23:59:00+08:00'))
})

test('beijingParse: invalid/empty input returns null, not a guess', () => {
  assert.equal(beijingParse(''), null)
  assert.equal(beijingParse('明天'), null)
  assert.equal(beijingParse('2026/08/24'), null)
  assert.equal(beijingParse(undefined), null)
})
