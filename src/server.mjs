import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApp, listen } from './app.mjs'
import { ILinkProvider } from './providers/ilink-provider.mjs'
import { BindingStore } from './services/binding-store.mjs'
import { AgentsSdkAgent } from './llm/agents-sdk-agent.mjs'
import { SessionStore } from './services/session-store.mjs'
import { MemoryStore } from './services/memory-store.mjs'
import { MemoryManager } from './llm/memory-manager.mjs'
import { MemoryExtractor } from './llm/memory-extractor.mjs'
import { SkillRegistry } from './skills/skill-registry.mjs'
import { WechatLogStore } from './services/wechat-log-store.mjs'
import { DownloadTokenStore } from './services/download-tokens.mjs'
import { TaskStore } from './services/task-store.mjs'
import { ReportStore } from './services/report-store.mjs'
import { ContextTokenCache } from './services/context-token-cache.mjs'
import { TaskScheduler } from './services/task-scheduler.mjs'
import { MemoryMaintenance } from './services/memory-maintenance.mjs'
import { MemoryClusterer } from './llm/memory-cluster.mjs'
import { MemoryGeneralizer } from './llm/memory-generalize.mjs'
import { MemoryProfiler } from './llm/memory-profile.mjs'
import { createMemoryComplete } from './llm/memory-complete.mjs'
import { renderPoster } from './services/poster-render.mjs'
import { buildTools } from './tools/index.mjs'
import { LarkTokenStore } from './services/lark-token-store.mjs'
import { LarkClient } from './services/lark-client.mjs'
import { GroupCommandWatcher } from './services/group-command-watcher.mjs'
import { TaskRunStore } from './services/task-run-store.mjs'
import { SubagentRunner } from './services/subagent-runner.mjs'

const userFilesRoot = process.env.USER_FILES_ROOT || 'data/user-files'
const provider = new ILinkProvider({ userFilesRoot })
const store = new BindingStore({ file: process.env.BINDINGS_FILE || 'data/bindings.json' })
const verifier = process.env.WECHAT_SYNC_ACCESS_KEY ? new (await import('./services/remote-wechat-verifier.mjs')).RemoteWechatVerifier({ baseUrl: process.env.WECHAT_SYNC_BASE_URL || 'https://datadefender.cn', accessKey: process.env.WECHAT_SYNC_ACCESS_KEY }) : null
const profileStore = new (await import('./services/profile-store.mjs')).ProfileStore({ file: process.env.PROFILES_FILE || 'data/profiles.json' })
const sessionStore = new SessionStore({ file: process.env.SESSIONS_FILE || 'data/sessions.db' })
const memoryStore = new MemoryStore({ file: process.env.MEMORIES_FILE || 'data/memories.db' })
// Resolve skills relative to the source tree (repo root / container /app),
// independent of process CWD, so the declarative skills/ dir is always found.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const skillRegistry = new SkillRegistry({ dir: process.env.SKILLS_DIR || path.resolve(__dirname, '..', 'skills') })

// Timed tasks (ADR-0014): store + contextToken cache + public task catalog.
// Report archive (DESIGN-daily-report.md): structured report storage + dedup
// fingerprints + public web page backing store.
const taskStore = new TaskStore({ file: process.env.TASKS_FILE || 'data/tasks.db' })
const reportStore = new ReportStore({ file: process.env.REPORTS_FILE || 'data/reports.db' })
const contextTokens = new ContextTokenCache({ file: process.env.CONTEXT_TOKENS_FILE || 'data/context-tokens.json' })
const globalTasksFile = process.env.GLOBAL_TASKS_FILE || path.resolve(__dirname, '..', 'deploy', 'global-tasks.json')
if (fs.existsSync(globalTasksFile)) {
  try {
    const loaded = taskStore.loadGlobalTasks(JSON.parse(fs.readFileSync(globalTasksFile, 'utf8')))
    if (loaded.length) console.log(`global tasks loaded: ${loaded.map((t) => t.name).join(', ')}`)
  } catch (e) { console.warn(`failed to load global tasks from ${globalTasksFile}: ${e.message}`) }
}

// MemoryManager needs an extractor that talks to the same LLM the agent uses.
const llm = new (await import('openai')).default({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1' })
/** 记忆侧统一 LLM 入口（提取/聚类/泛化/档案）：单轮、确定性、**关闭思考**——
 *  deepseek-flash 的思考会吃掉 max_tokens 导致空响应（详见 memory-complete.mjs）。 */
const memoryComplete = createMemoryComplete(llm, { model: process.env.OPENAI_MODEL || 'deepseek-flash' })
const memoryManager = new MemoryManager({
  store: memoryStore,
  extractor: new MemoryExtractor({ complete: memoryComplete }),
})

// 记忆维护（DESIGN-memory-lifecycle：三层压缩 + 档案层）：tick 每 6h 检查，
// 活跃用户 ≥24h、不活跃用户 ≥7 天跑一次重量维护。MEMORY_MAINTENANCE=0 可关闭。
const memoryMaintenance = process.env.MEMORY_MAINTENANCE === '0' ? null : new MemoryMaintenance({
  store: memoryStore,
  clusterer: new MemoryClusterer({ complete: memoryComplete }),
  generalizer: new MemoryGeneralizer({ complete: memoryComplete }),
  profiler: new MemoryProfiler({ complete: memoryComplete }),
  onError: (error, userId) => console.warn(`memory maintenance error (${userId}): ${error?.message || error}`),
})
memoryMaintenance?.start()

// Read-only direct SQLite access to the WeChat sync receiver's DB (mounted
// read-only into this container — see ADR-0007). Optional: omitted when not
// configured (local dev, tests, or before the mount is set up) rather than
// crashing the whole server.
const wechatLogDbFile = process.env.WECHAT_LOG_DB || ''
const wechatLogStore = wechatLogDbFile && fs.existsSync(wechatLogDbFile) ? new WechatLogStore({ file: wechatLogDbFile }) : null
if (wechatLogDbFile && !wechatLogStore) console.warn(`WECHAT_LOG_DB=${wechatLogDbFile} not found; wechat_* tools disabled`)

// Download links (see ADR-0008): write_file / run_code write into a per-user
// sandbox with no browse UI — the universal fallback (works from web chat,
// where there's no WeChat session to send a file through). On WeChat itself,
// send_file (ADR-0009, wired below via `provider`) delivers a real file
// attachment instead. Tokens live in memory (server.mjs creates the ONE
// store both buildTools and createApp share) and expire.
const downloadTokens = new DownloadTokenStore({ ttlMs: Number(process.env.DOWNLOAD_TOKEN_TTL_MS || 24 * 3600 * 1000) })
process.env.PUBLIC_BASE_PATH ||= '/wechat-agent/'
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || 'https://datadefender.cn').replace(/\/$/, '')
const issueDownloadLink = (userId, relPath) => `${publicBaseUrl}${process.env.PUBLIC_BASE_PATH}files/${downloadTokens.issue(userId, relPath)}`
// 提前到这里（原在 scheduler 构造前）：resend_daily_report 工具（ADR-0026）也要
// 用它拼公网链接，而工具集在 buildTools() 里构建，早于 scheduler。
const reportUrl = (reportId) => `${publicBaseUrl}${process.env.PUBLIC_BASE_PATH}reports/${reportId}`

// 飞书文档（ADR-0021）：条件启用——未配置 LARK_APP_ID/SECRET 时 lark 为 null，
// 整套工具不注册、/lark/* 路由 404，服务器行为与未加此功能完全一致（零影响）。
const larkAppId = process.env.LARK_APP_ID || ''
const larkAppSecret = process.env.LARK_APP_SECRET || ''
const lark = larkAppId && larkAppSecret
  ? { client: new LarkClient({ appId: larkAppId, appSecret: larkAppSecret, tokenStore: new LarkTokenStore({ file: process.env.LARK_TOKENS_FILE || 'data/larks.db' }) }) }
  : null
if (!lark) console.warn('lark docs disabled: set LARK_APP_ID + LARK_APP_SECRET to enable (ADR-0021)')

const tools = buildTools({ memoryManager, skillRegistry, fetchImpl: globalThis.fetch, wechatLogStore, root: userFilesRoot, issueDownloadLink, provider, taskStore, reportStore, reportUrl, lark })

const sessionOpts = { sessionStore, memoryStore, tokenBudget: Number(process.env.SESSION_TOKEN_BUDGET || 128_000), threshold: Number(process.env.SESSION_FOLD_THRESHOLD || 0.8), keepTurns: Number(process.env.SESSION_KEEP_TURNS || 30) }
const agent = process.env.OPENAI_API_KEY ? new AgentsSdkAgent({ model: process.env.OPENAI_MODEL || 'deepseek-flash', baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY, ...sessionOpts, tools, skillRegistry }) : undefined

// 任务委派（DESIGN-task-delegation.md / ADR-0024）：
// 主 agent 只决策与秒回；长任务交给后台子 agent（独立实例 + 独立 thinking 缓存，
// 受限工具集：无 delegate/task 工具防递归，保留 send_file/notify_user 与业务工具）。
const taskRunStore = new TaskRunStore({ file: process.env.TASK_RUNS_FILE || 'data/task-runs.db' })
const subagentTools = buildTools({ memoryManager, skillRegistry, fetchImpl: globalThis.fetch, wechatLogStore, root: userFilesRoot, issueDownloadLink, provider, taskStore: null, reportStore: null, lark })
const makeSubagent = () => process.env.OPENAI_API_KEY
  ? new AgentsSdkAgent({ model: process.env.OPENAI_MODEL || 'deepseek-flash', baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY, ...sessionOpts, tools: subagentTools, skillRegistry })
  : null
const subagentRunner = agent ? new SubagentRunner({
  agentFactory: makeSubagent,
  store: taskRunStore,
  provider,
  contextTokens,
  profileStore,
  maxConcurrentPerUser: Number(process.env.DELEGATE_MAX_CONCURRENT || 2),
  timeoutMs: Number(process.env.DELEGATE_TIMEOUT_MS || 300_000),
  onError: (error, task) => console.warn(`subagent ${task?.id || '?'} notify failed: ${error?.message || error}`),
}) : null
if (subagentRunner) {
  const { delegateTools } = await import('./tools/delegate-tools.mjs')
  const dt = delegateTools({ taskRunStore, runner: subagentRunner })
  tools.push(dt.delegateTask, dt.listTasks, dt.taskStatus, dt.retryTask)
}

// Timed tasks: scheduler pushes task outputs to each user's WeChat when due.
// Report tasks (DESIGN-daily-report.md + ADR-0018): one generation + fan-out;
// the report is rendered into a poster long-image (HTML → PNG via headless
// browser: system chromium/chrome/edge or @sparticuz/chromium) and pushed as
// 图+短描述; the web URL goes in the short text. No browser → renderPoster
// throws and the scheduler degrades to text-only (non-fatal).
// 失败重试（ADR-0026）：TASK_RETRY_MAX 次（默认 3），每次间隔 TASK_RETRY_INTERVAL_MS
// （默认 20 分钟）；仍失败才放弃、等下一个自然周期（通常是明天）。
const posterRender = async (report, html) => {
  const out = path.resolve('data/reports', `${report.id}.png`)
  return renderPoster(html, { width: 750, outPath: out })
}
// 调度器专属 agent 实例（ADR-0028）：AgentsSdkAgent 每实例一条串行执行队列
// （防并发 run 互踩 DeepSeek thinking 缓存），若与 MessageRouter/GroupCommandWatcher
// 共用主 `agent`，8 点批量日报生成会把实时聊天/群命令堵在同一条队列后面（订阅
// 规模上去后忙碌窗口拉长到分钟级）。独立实例 = 独立队列（隔离手法同 ADR-0024
// 的委派子 agent），但语义不同：这里是**全量工具集**（同主 agent，不是防递归的
// 受限版），且 `...sessionOpts` 指向同一份 sessionStore/memoryStore——个人定时
// 任务（#runForUser）写的是用户真实会话历史，数据源必须与实时聊天一致，分开的
// 只有队列。
const schedulerAgent = process.env.OPENAI_API_KEY
  ? new AgentsSdkAgent({ model: process.env.OPENAI_MODEL || 'deepseek-flash', baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY, ...sessionOpts, tools, skillRegistry })
  : undefined
const scheduler = schedulerAgent ? new TaskScheduler({
  taskStore, agent: schedulerAgent, provider, profileStore, contextTokens, reportStore, reportUrl, posterRender,
  retryMax: Number(process.env.TASK_RETRY_MAX || 3),
  retryIntervalMs: Number(process.env.TASK_RETRY_INTERVAL_MS || 20 * 60_000),
}) : null
scheduler?.start()

// 群命令监听（群聊入口：收走 wechat-sync，发走 iLink 私聊）。
// 依赖 WECHAT_LOG_DB（wechat-sync 只读挂载）+ agent，缺失时休眠。
const groupWatcher = wechatLogStore && agent && process.env.WECHAT_LOG_DB
  ? new GroupCommandWatcher({
      dbFile: process.env.WECHAT_LOG_DB,
      agent, provider, profileStore, contextTokens,
      cursorFile: process.env.GROUP_WATCHER_CURSOR || 'data/group-watcher-cursor.json',
      onError: (error, row) => console.warn(`group command error (${row?.msg_id || '?'}): ${error?.message || error}`),
    })
  : null
groupWatcher?.start()

const app = createApp({ provider, store, verifier, profileStore, agent, downloadTokens, userFilesRoot, contextTokens, reportStore, lark })
const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || '127.0.0.1'
await listen(app, { port, host })
console.log(`wechat-agent listening on http://${host}:${port}`)
process.on('SIGTERM', () => { scheduler?.stop(); groupWatcher?.stop(); memoryMaintenance?.stop(); contextTokens.flush(); process.exit(0) })
process.on('SIGINT', () => { scheduler?.stop(); groupWatcher?.stop(); memoryMaintenance?.stop(); contextTokens.flush(); process.exit(0) })
