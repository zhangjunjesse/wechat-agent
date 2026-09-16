#!/usr/bin/env node
/** 一次性手动触发一期微信日报/周报，打印真实产出（DESIGN-wechat-digest.md）。
 *
 * 为什么需要它：调度器只有 `sweep()` 一个入口，到点才跑、且对**全部订阅者**跑
 * 并真实推送微信。想拿真实群数据看一眼产出质量，必须有一条「指定用户 + 不推送」
 * 的旁路。本脚本就是那条旁路：走 WechatDigestRunner 的真实生成管道（同调度器
 * 调的那个 `generate()`），但**不碰 provider、不发任何微信消息**。
 *
 * 用法（容器内）：
 *   DIGEST_FILE=/data/digest-preview.db REPORTS_FILE=/data/reports-preview.db \
 *   node scripts/run-digest-once.mjs --nickname "Z.俊" --wxid zj391504704 \
 *        --user u_1a0c9651-ea5 --task 微信日报
 *
 * 参数：
 *   --nickname  微信昵称（accessibleChats 的匹配键之一）
 *   --wxid      微信 wxid（匹配键之一；与 nickname 至少给一个）
 *   --user      userId（决定群画像分区 / 记忆读取；不给则用 wxid|nickname）
 *   --task      公共任务名，默认「微信日报」（周报传「微信周报」）
 *   --poster    带上才渲染海报（需要 chromium；默认不渲染，只看文本）
 *   --json      额外打印完整 report JSON
 *
 * 安全边界：`generate()` 内部所有 LLM 调用都是 `ephemeral: true`，不写用户的
 * session/记忆；把 DIGEST_FILE / REPORTS_FILE 指到 *-preview.db 就完全不污染
 * 生产库。脚本自身只读 profiles.json 与聊天库。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentsSdkAgent } from '../src/llm/agents-sdk-agent.mjs'
import { MemoryStore } from '../src/services/memory-store.mjs'
import { ReportStore } from '../src/services/report-store.mjs'
import { GroupProfileStore } from '../src/services/group-profile-store.mjs'
import { WechatLogStore } from '../src/services/wechat-log-store.mjs'
import { WechatDigestRunner } from '../src/services/wechat-digest-runner.mjs'
import { renderPoster } from '../src/services/poster-render.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const flag = (name) => argv.includes(`--${name}`)

const nickname = arg('nickname')
const wxid = arg('wxid')
const taskName = arg('task', '微信日报')
if (!nickname && !wxid) {
  console.error('需要 --nickname 或 --wxid 至少一个')
  process.exit(2)
}
const userId = arg('user', wxid || nickname)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const globalTasksFile = process.env.GLOBAL_TASKS_FILE || path.resolve(repoRoot, 'deploy', 'global-tasks.json')
const task = JSON.parse(fs.readFileSync(globalTasksFile, 'utf8')).find((t) => t.name === taskName)
if (!task) { console.error(`${globalTasksFile} 里没有任务「${taskName}」`); process.exit(2) }
if (task.kind !== 'wechat-digest') { console.error(`「${taskName}」不是 wechat-digest 任务（kind=${task.kind}）`); process.exit(2) }
// 调度器建 unit 时用的就是这个 id 规则（task-store.mjs: `global-<name>`）。
const taskWithId = { ...task, id: `global-${task.name}` }

const wechatLogDbFile = process.env.WECHAT_LOG_DB || ''
if (!wechatLogDbFile || !fs.existsSync(wechatLogDbFile)) {
  console.error(`WECHAT_LOG_DB 未配置或文件不存在：${JSON.stringify(wechatLogDbFile)}`)
  process.exit(2)
}
if (!process.env.OPENAI_API_KEY) { console.error('缺 OPENAI_API_KEY'); process.exit(2) }

const wechatLogStore = new WechatLogStore({ file: wechatLogDbFile })
const groupProfiles = new GroupProfileStore({ file: process.env.DIGEST_FILE || 'data/digest.db' })
const reportStore = new ReportStore({ file: process.env.REPORTS_FILE || 'data/reports.db' })
const memoryStore = new MemoryStore({ file: process.env.MEMORIES_FILE || 'data/memories.db' })

// 与 server.mjs 的 schedulerAgent 同形，但 tools 留空：digest 的三段 prompt 都是
// 纯文本进 / JSON 出，不需要工具；空工具集也排除了"模型跑去调工具"的干扰变量。
const agent = new AgentsSdkAgent({
  model: process.env.OPENAI_MODEL || 'deepseek-flash',
  baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY,
  sessionStore: null,
  memoryStore,
  tools: [],
})

const posterRender = flag('poster')
  ? async (report, html) => renderPoster(html, { width: 750, outPath: path.resolve('data/reports', `${report.id}.png`) })
  : null

const runner = new WechatDigestRunner({
  agent, wechatLogStore, groupProfiles, memoryStore, reportStore, posterRender,
  onError: (error, info) => console.error(`  [stage=${info?.stage} ${info?.chat || ''}] ${error?.message || error}`),
})

const identity = { wxid, nickname }
const groups = wechatLogStore.accessibleChats(identity).filter((c) => c.isGroup)
console.log(`用户 ${userId}（${nickname || wxid}）· 任务「${taskName}」(${task.schedule})`)
console.log(`可见群 ${groups.length} 个：${groups.map((g) => g.name || g.chatWxid).join('、')}`)
console.log('--- 生成中（真实 LLM 调用，按群数可能要几分钟）---')

const started = Date.now()
const result = await runner.generate({ task: taskWithId, userId, profile: { wxid, nickname } })
const elapsed = ((Date.now() - started) / 1000).toFixed(1)

console.log(`--- 完成，用时 ${elapsed}s ---`)
if (!result.ok) {
  console.log(`❌ 生成失败：${result.error}`)
  if (result.rawText) console.log(`原始输出：\n${result.rawText}`)
  process.exit(1)
}
if (result.empty) {
  console.log('😌 空结果（"今天各群平静"）——这是正常结果，不是失败。')
  process.exit(0)
}

const r = result.report
const LABELS = { action_items: '📌 需要你行动', work_updates: '💼 你该知道', fun: '🍵 值得一看' }
console.log(`\n【${r.name}】${r.focus || ''}`)
for (const key of Object.keys(LABELS)) {
  const list = (r.items || []).filter((it) => (it.section || 'work_updates') === key)
  if (!list.length) continue
  console.log(`\n${LABELS[key]}（${list.length}）`)
  for (const item of list) {
    console.log(`  · ${item.title}`)
    if (item.summary) console.log(`    ${item.summary}`)
    if (item.source) console.log(`    ${item.source}`)
  }
}
console.log(`\n报告 id：${r.id}${r.posterPath ? `\n海报：${r.posterPath}` : ''}`)
if (flag('json')) console.log(`\n=== 完整 JSON ===\n${JSON.stringify(r, null, 2)}`)
