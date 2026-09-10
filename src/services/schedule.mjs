import { beijingParts } from './time.mjs'

/** 极简定时任务调度表达式（零第三方依赖，见 DESIGN-timed-tasks.md）：
 *
 *   daily@HH:MM       每日，如 daily@08:00
 *   weekly@D@HH:MM    每周某天，D=1(周一)~7(周日)，如 weekly@1@08:00
 *   hourly@MM         每小时的第 MM 分，如 hourly@00
 *
 * 时间一律按北京时间解释（复用 services/time.mjs 的北京时区换算）。 */

const EXPR_RE = /^(daily)@(\d{1,2}):(\d{2})$|^(weekly)@([1-7])@(\d{1,2}):(\d{2})$|^(hourly)@(\d{2})$/

export function parseSchedule(expr) {
  const m = EXPR_RE.exec(String(expr || '').trim())
  if (!m) throw new Error(`非法调度表达式：${JSON.stringify(expr)}（格式：daily@HH:MM / weekly@D@HH:MM / hourly@MM）`)
  if (m[1] === 'daily') {
    const hour = Number(m[2]); const minute = Number(m[3])
    if (hour > 23 || minute > 59) throw new Error(`非法调度时间：${expr}`)
    return { type: 'daily', hour, minute }
  }
  if (m[4] === 'weekly') {
    const hour = Number(m[6]); const minute = Number(m[7])
    if (hour > 23 || minute > 59) throw new Error(`非法调度时间：${expr}`)
    return { type: 'weekly', weekday: Number(m[5]), hour, minute }
  }
  const minute = Number(m[9])
  if (minute > 59) throw new Error(`非法调度时间：${expr}`)
  return { type: 'hourly', minute }
}

/** 下一个触发时刻（北京时间）的 Unix 毫秒。`nowMs` 之后最近的触发点。 */
export function nextRunAt(expr, nowMs = Date.now()) {
  const s = parseSchedule(expr)
  const p = beijingParts(nowMs) // { year, month, day, hour, minute, weekday, ... }（北京时区）
  const base = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - 8 * 3600_000 // 北京 -> UTC 毫秒
  // 北京本地“今天”的候选触发点（用 UTC 构造当天 00:00 再偏移）
  const dayStartUtc = Date.UTC(p.year, p.month - 1, p.day) - 8 * 3600_000
  const DAY = 24 * 3600_000
  if (s.type === 'daily') {
    let t = dayStartUtc + (s.hour * 60 + s.minute) * 60_000
    if (t <= nowMs) t += DAY
    return t
  }
  if (s.type === 'weekly') {
    // p.weekday is JS convention (0=Sun..6=Sat); convert to 1=Mon..7=Sun to
    // match the expression's D field.
    const todayWeekday = ((p.weekday + 6) % 7) + 1
    let diff = s.weekday - todayWeekday
    let t = dayStartUtc + (s.hour * 60 + s.minute) * 60_000 + diff * DAY
    if (t <= nowMs) t += 7 * DAY
    return t
  }
  // hourly
  let t = dayStartUtc + (p.hour * 60 + s.minute) * 60_000
  if (t <= nowMs) t += 3600_000
  return t
}

/** 上一个（最近一次已过去的）触发时刻，北京时间的 Unix 毫秒。
 * 用于调度器判断"任务到点是否该执行"：最近触发点 prev <= now，
 * 若上次执行时间 < prev 说明这一轮还没跑过，应该执行。 */
export function previousRunAt(expr, nowMs = Date.now()) {
  const periodMs = periodMsOf(expr)
  let prev = nextRunAt(expr, nowMs) - periodMs
  while (prev > nowMs) prev -= periodMs
  return prev
}

function periodMsOf(expr) {
  const s = parseSchedule(expr)
  if (s.type === 'daily') return 24 * 3600_000
  if (s.type === 'weekly') return 7 * 24 * 3600_000
  return 3600_000
}

/** 一个调度表达式的人类可读描述（用于展示/目录）。 */
export function describeSchedule(expr) {
  const s = parseSchedule(expr)
  const pad = (n) => String(n).padStart(2, '0')
  if (s.type === 'daily') return `每天 ${pad(s.hour)}:${pad(s.minute)}`
  if (s.type === 'weekly') return `每周${'一二三四五六日'[s.weekday - 1]} ${pad(s.hour)}:${pad(s.minute)}`
  return `每小时 ${pad(s.minute)} 分`
}
