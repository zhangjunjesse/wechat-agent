#!/usr/bin/env node
/** 引导话术效果统计（ADR-0020）。
 *
 * 用法：
 *   node scripts/guide-stats.mjs              # 读本地 data/tasks.db
 *   TASKS_FILE=/data/tasks.db node scripts/guide-stats.mjs   # 读生产库
 *
 * 输出：订阅 → 引导曝光 → 主题转化 漏斗、各入口曝光量、平均转化耗时、趋势。
 * 数据来自 TaskStore 的 guide_events / report_topics / tasks.subscribers。 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'

const file = process.env.TASKS_FILE || 'data/tasks.db'
if (!fs.existsSync(file)) {
  console.log(`任务库不存在：${file}（生产用法：TASKS_FILE=/data/tasks.db node scripts/guide-stats.mjs）`)
  process.exit(0)
}
const db = new DatabaseSync(file)

function safeJson(text, fallback) {
  try { const v = JSON.parse(text); return Array.isArray(v) ? v : fallback } catch { return fallback }
}

const pad = (n) => String(n).padStart(2, '0')
const dayKey = (ms) => {
  const d = new Date(ms + 8 * 3600_000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

// 漏斗
let subRows = []
try { subRows = db.prepare("SELECT subscribers FROM tasks WHERE scope = 'global'").all() } catch { /* 空库 */ }
const subscribed = new Set()
for (const r of subRows) for (const u of safeJson(r.subscribers, [])) subscribed.add(String(u))

let shownRows = [], convRows = []
try {
  shownRows = db.prepare("SELECT user_id, entry, created_at FROM guide_events WHERE event = 'guide_shown'").all()
  convRows = db.prepare("SELECT user_id, entry, created_at FROM guide_events WHERE event = 'guide_converted'").all()
} catch { /* guide_events 表尚未创建（旧库未跑过新代码） */ }

const shownUsers = new Set(shownRows.map((r) => String(r.user_id)))
const byEntry = {}
for (const r of shownRows) byEntry[r.entry] = (byEntry[r.entry] || 0) + 1

const firstConv = new Map()
for (const r of convRows) if (!firstConv.has(String(r.user_id))) firstConv.set(String(r.user_id), Number(r.created_at))
const lastShown = new Map()
for (const r of shownRows) lastShown.set(String(r.user_id), Number(r.created_at))

const hours = []
for (const [u, convAt] of firstConv) {
  const shownAt = lastShown.get(u)
  if (shownAt && convAt >= shownAt) hours.push((convAt - shownAt) / 3600_000)
}

const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0)
console.log('===== 引导话术效果（guide_events）=====')
console.log(`订阅用户        : ${subscribed.size} 人`)
console.log(`收到引导曝光    : ${shownUsers.size} 人（${shownRows.length} 次展示）`)
console.log(`完成主题转化    : ${firstConv.size} 人`)
console.log(`转化率（曝光→转化）: ${rate(firstConv.size, shownUsers.size)}%`)
console.log(`转化率（订阅→转化）: ${rate(firstConv.size, subscribed.size)}%`)
console.log(`平均转化耗时    : ${hours.length ? `${Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10} 小时` : '（暂无数据）'}`)

console.log('\n-- 各入口曝光量 --')
for (const [k, v] of Object.entries(byEntry).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(10)} ${v} 次`)
}
if (!Object.keys(byEntry).length) console.log('  （暂无曝光）')

console.log('\n-- 转化用户明细 --')
if (!convRows.length) console.log('  （暂无转化）')
for (const [u, at] of firstConv) console.log(`  ${u}  ${new Date(at).toISOString()}`)

console.log('\n-- 近 7 天趋势（北京时间）--')
const days = new Map()
for (const r of [...shownRows, ...convRows]) {
  const k = dayKey(Number(r.created_at))
  const d = days.get(k) || { shown: 0, converted: 0 }
  if (r.event === 'guide_shown') d.shown++
  else d.converted++
  days.set(k, d)
}
if (!days.size) console.log('  （暂无事件）')
for (const [k, d] of [...days.entries()].sort()) console.log(`  ${k}  曝光 ${d.shown} · 转化 ${d.converted}`)

db.close()
