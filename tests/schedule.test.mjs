import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSchedule, nextRunAt, previousRunAt, describeSchedule } from '../src/services/schedule.mjs'
import { beijingParts } from '../src/services/time.mjs'

const DAY = 24 * 3600 * 1000
// NOW = Beijing 2026-09-10 08:05 = UTC 2026-09-10 00:05 (absolute instant).
const NOW = Date.UTC(2026, 8, 10, 0, 5)

test('parseSchedule validates formats', () => {
  assert.deepEqual(parseSchedule('daily@08:00'), { type: 'daily', hour: 8, minute: 0 })
  assert.deepEqual(parseSchedule('weekly@1@09:30'), { type: 'weekly', weekday: 1, hour: 9, minute: 30 })
  assert.deepEqual(parseSchedule('hourly@15'), { type: 'hourly', minute: 15 })
  for (const bad of ['daily@24:00', 'daily@08:60', 'weekly@0@08:00', 'weekly@8@08:00', 'hourly@60', 'cron 0 8 * * *', 'daily@8']) {
    assert.throws(() => parseSchedule(bad), /非法调度表达式|非法调度时间/, bad)
  }
})

test('nextRunAt: daily picks today or tomorrow in Beijing time', () => {
  assert.equal(nextRunAt('daily@09:00', NOW), Date.UTC(2026, 8, 10, 1, 0)) // today 09:00 BJ
  assert.equal(nextRunAt('daily@08:04', NOW), Date.UTC(2026, 8, 11, 0, 4)) // past -> tomorrow 08:04 BJ
  assert.equal(nextRunAt('daily@08:05', NOW), Date.UTC(2026, 8, 11, 0, 5)) // exactly now -> tomorrow
  assert.equal(nextRunAt('daily@08:00', NOW), Date.UTC(2026, 8, 11, 0, 0)) // past -> tomorrow
})

test('nextRunAt: hourly picks this hour or the next', () => {
  assert.equal(nextRunAt('hourly@30', NOW), Date.UTC(2026, 8, 10, 0, 30)) // today 08:30 BJ
  assert.equal(nextRunAt('hourly@05', NOW), Date.UTC(2026, 8, 10, 1, 5)) // 08:05 BJ passed -> 09:05
})

test('nextRunAt: weekly lands on the requested weekday', () => {
  const p = beijingParts(NOW)
  const todayW = ((p.weekday + 6) % 7) + 1 // 1=Mon..7=Sun
  assert.equal(nextRunAt(`weekly@${todayW}@09:00`, NOW), NOW + 55 * 60_000)
  assert.equal(nextRunAt(`weekly@${todayW}@08:05`, NOW), NOW + 7 * DAY)
  assert.equal(nextRunAt(`weekly@${todayW}@08:00`, NOW), NOW + 7 * DAY - 5 * 60_000)
  const other = todayW === 1 ? 2 : 1
  const next = nextRunAt(`weekly@${other}@08:00`, NOW)
  assert.ok(next > NOW && next < NOW + 7 * DAY)
})

test('previousRunAt returns the most recent trigger point at or before now', () => {
  // 08:00:30 -> last trigger is today 08:00 (already passed)
  assert.equal(previousRunAt('daily@08:00', NOW), Date.UTC(2026, 8, 10, 0, 0))
  // 08:00:30 -> 08:30 not reached; last trigger is yesterday 08:30
  assert.equal(previousRunAt('daily@08:30', NOW), Date.UTC(2026, 8, 9, 0, 30))
  // hourly @00 -> last trigger is this hour 08:00
  assert.equal(previousRunAt('hourly@00', NOW), Date.UTC(2026, 8, 10, 0, 0))
})

test('describeSchedule renders human-readable text', () => {
  assert.equal(describeSchedule('daily@08:00'), '每天 08:00')
  assert.equal(describeSchedule('weekly@1@09:30'), '每周一 09:30')
  assert.equal(describeSchedule('hourly@15'), '每小时 15 分')
})
