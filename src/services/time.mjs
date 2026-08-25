/** Beijing time (UTC+8) helpers.
 *
 * The server container defaults to UTC, so `new Date().getHours()` etc. would
 * be 8 hours behind China time and could shift "today"/weekday boundaries for
 * todo deadlines. We fix the timezone in code (not via container TZ) so local
 * Windows dev and the UTC container behave identically.
 *
 * China has no DST, so a fixed +8h offset is exact.
 */
const BEIJING_OFFSET_MS = 8 * 3600 * 1000

/** Year/month/day/hour/minute/weekday of `ms` in Beijing time. */
export function beijingParts(ms = Date.now()) {
  const d = new Date(new Date(ms).getTime() + BEIJING_OFFSET_MS)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(), // 0=Sun .. 6=Sat
  }
}

/** `YYYY-MM-DD` in Beijing time. */
export function beijingDateStr(ms = Date.now()) {
  const p = beijingParts(ms)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/** `YYYY-MM-DD HH:mm` in Beijing time. */
export function beijingDateTimeStr(ms = Date.now()) {
  const p = beijingParts(ms)
  return `${beijingDateStr(ms)} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}

/** `今天是 YYYY-MM-DD HH:mm（周X）。` in Beijing time. */
export function beijingNowLine(ms = Date.now()) {
  const p = beijingParts(ms)
  return `今天是 ${beijingDateStr(ms)} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}（周${'日一二三四五六'[p.weekday]}）。`
}

/** Absolute timestamp of the Beijing-time midnight of `ms`'s calendar day. */
export function beijingMidnight(ms = Date.now()) {
  const p = beijingParts(ms)
  return Date.UTC(p.year, p.month - 1, p.day) - BEIJING_OFFSET_MS
}

/** Beijing weekday (0=Sun .. 6=Sat) of `ms`. */
export function beijingWeekday(ms = Date.now()) {
  return beijingParts(ms).weekday
}

/** Parse `YYYY-MM-DD HH:mm` or `YYYY-MM-DD` (Beijing wall-clock) into an
 * absolute epoch ms. A date-only string defaults to 00:00, or 23:59 when
 * `endOfDay` is set (for inclusive end-of-range queries). Returns null for
 * anything else — callers decide their own fallback for missing/invalid input. */
export function beijingParse(str, { endOfDay = false } = {}) {
  const m = String(str || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/)
  if (!m) return null
  const [, y, mo, d, h, mi] = m
  const hour = h != null ? Number(h) : (endOfDay ? 23 : 0)
  const minute = mi != null ? Number(mi) : (endOfDay ? 59 : 0)
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, minute) - BEIJING_OFFSET_MS
}
