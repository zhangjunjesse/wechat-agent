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
import { AgentTaskStore } from './services/agent-task-store.mjs'
import { SubagentRunner } from './services/subagent-runner.mjs'
import { VisionClient } from './services/vision-client.mjs'
import { GroupProfileStore } from './services/group-profile-store.mjs'
import { WechatDigestRunner } from './services/wechat-digest-runner.mjs'
import { ExpertModeStore } from './services/expert-mode-store.mjs'
import { createTriage } from './llm/triage.mjs'
import { TurnPipeline } from './services/turn-pipeline.mjs'
import { ModelRoutingAgent } from './llm/model-routing-agent.mjs'

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
// 群画像（DESIGN-wechat-digest.md）：微信日报/周报按群性质决定从每个群捞什么。
// 独立库，与 tasks/reports 一样各自建表迁移。
const groupProfiles = new GroupProfileStore({ file: process.env.DIGEST_FILE || 'data/digest.db' })
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
// 历史聊天附件（ADR-0029）：媒体真身与 sync_inbox.db 同一只读挂载
// （<db 目录>/media/<media_id>.<ext>），wechat_fetch_chat_file 直接只读拷贝。
const wechatMediaDir = process.env.WECHAT_MEDIA_DIR || (wechatLogDbFile ? path.join(path.dirname(wechatLogDbFile), 'media') : '')

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

// 视觉理解（ADR-0030）：条件启用——未配置 VISION_MODEL 时 vision 为 null，
// image_describe 不注册，行为与未加此功能完全一致（模式同 lark/wechat_*）。
// 复用同一网关的 OPENAI_BASE_URL/OPENAI_API_KEY；单轮一次性 HTTP 问答，
// 刻意不接 deepseek-thinking-client/agents-sdk-agent 主链路（历史 400 事故区）。
const visionModel = process.env.VISION_MODEL || ''
const vision = visionModel && process.env.OPENAI_API_KEY
  ? new VisionClient({ baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY, model: visionModel })
  : null
if (!vision) console.warn('vision disabled: set VISION_MODEL to enable image_describe (ADR-0030)')

// 专家模式（ADR-0033）：per-user 临时切到更强的模型，默认 60 分钟后惰性过期。
// 状态存储必须在 buildTools 之前建好——`set_expert_mode` 工具（兜底路径）与
// ModelRoutingAgent 的快捷命令（主路径）写的是**同一个**实例，它是"这个用户
// 当前在不在专家模式"这件事的唯一 owner。
// 路径注意：容器 cwd 是 `/`，所以相对路径 `data/expert-mode.json` 在生产解析到
// `/data/expert-mode.json`（与 TASKS_FILE 等同一处理方式，该目录已挂载持久卷）。
const expertModel = process.env.EXPERT_MODEL ?? 'gpt-5.6-sol'
const expertModeTtlMs = Math.max(1, Number(process.env.EXPERT_MODE_TTL_MINUTES || 60)) * 60_000
const expertModeStore = expertModel ? new ExpertModeStore({ file: process.env.EXPERT_MODE_FILE || 'data/expert-mode.json' }) : null
if (!expertModeStore) console.warn('expert mode disabled: set EXPERT_MODEL to enable (ADR-0033)')

const tools = buildTools({ memoryManager, skillRegistry, fetchImpl: globalThis.fetch, wechatLogStore, wechatMediaDir, root: userFilesRoot, issueDownloadLink, provider, taskStore, reportStore, reportUrl, lark, vision, groupProfiles, expertMode: expertModeStore ? { store: expertModeStore, ttlMs: expertModeTtlMs, expertModel } : null })

const sessionOpts = { sessionStore, memoryStore, tokenBudget: Number(process.env.SESSION_TOKEN_BUDGET || 128_000), threshold: Number(process.env.SESSION_FOLD_THRESHOLD || 0.8), keepTurns: Number(process.env.SESSION_KEEP_TURNS || 30) }
const defaultAgent = process.env.OPENAI_API_KEY ? new AgentsSdkAgent({ model: process.env.OPENAI_MODEL || 'deepseek-flash', baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY, ...sessionOpts, tools, skillRegistry }) : undefined
// 专家模式的第二个实例（ADR-0033）：与默认实例**共用同一份 `sessionOpts`**，也就
// 是同一个 sessionStore/memoryStore 实例引用——模型换了，对话历史与长期记忆必须
// 连续，否则用户切一次模式就像换了个助手。分开的只有模型（和 AgentsSdkAgent
// 每实例自带的那条串行队列，隔离手法同 ADR-0024/ADR-0028）。
const expertAgent = defaultAgent && expertModel
  ? new AgentsSdkAgent({ model: expertModel, baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY, ...sessionOpts, tools, skillRegistry })
  : null
// 包装器而不是去改 MessageRouter 或 /api/chat：三个调用方（私聊路由、网页
// /api/chat、群命令 watcher）看到的仍然只是"一个有 respond() 的东西"，一行都不用改。
// 未配置专家模型时 ModelRoutingAgent 纯透传，服务行为与未加此功能完全一致。
const agent = defaultAgent
  ? new ModelRoutingAgent({ defaultAgent, expertAgent, store: expertModeStore, ttlMs: expertModeTtlMs })
  : undefined

// Agent 任务板（DESIGN-agent-task-board.md，前身 ADR-0024 任务委派）：
// 承诺层（agent_tasks，板）与执行层（task_runs，单次尝试）分离，同一个 DB 文件。
// 主 agent 只决策与秒回；板上任务由 drain 循环交给后台子 agent（独立实例 +
// 独立 thinking 缓存，受限工具集：无任务板工具防递归，保留 send_file/notify_user
// 与业务工具）。板即队列 → 进程重启后 recover() 释放死认领，任务不悬挂。
const taskRunsFile = process.env.TASK_RUNS_FILE || 'data/task-runs.db'
const taskRunStore = new TaskRunStore({ file: taskRunsFile })
const boardStore = new AgentTaskStore({ file: taskRunsFile })
// 启动期孤儿清理：上一个进程遗留的 pending/running 执行行如实标 failed，
// 终结"已用 N 秒永远涨"的假象（必须在 runner.start() 之前）。
const orphaned = taskRunStore.failOrphans()
if (orphaned) console.log(`task runs: ${orphaned} orphaned run(s) from previous process marked failed`)
const subagentTools = buildTools({ memoryManager, skillRegistry, fetchImpl: globalThis.fetch, wechatLogStore, wechatMediaDir, root: userFilesRoot, issueDownloadLink, provider, taskStore: null, reportStore: null, lark, vision })
const makeSubagent = () => process.env.OPENAI_API_KEY
  ? new AgentsSdkAgent({ model: process.env.OPENAI_MODEL || 'deepseek-flash', baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY, ...sessionOpts, tools: subagentTools, skillRegistry })
  : null
const subagentRunner = agent ? new SubagentRunner({
  agentFactory: makeSubagent,
  board: boardStore,
  runs: taskRunStore,
  sessions: sessionStore,
  provider,
  contextTokens,
  profileStore,
  maxConcurrentPerUser: Number(process.env.DELEGATE_MAX_CONCURRENT || 2),
  timeoutMs: Number(process.env.DELEGATE_TIMEOUT_MS || 300_000),
  maxAutoAttempts: Number(process.env.BOARD_MAX_AUTO_ATTEMPTS || 3),
  onError: (error, task) => console.warn(`subagent board#${task?.id || '?'} notify failed: ${error?.message || error}`),
}) : null
if (subagentRunner) {
  const { taskBoardTools } = await import('./tools/task-board-tools.mjs')
  const bt = taskBoardTools({ board: boardStore, runs: taskRunStore, runner: subagentRunner })
  tools.push(bt.taskCreate, bt.taskList, bt.taskGet, bt.taskUpdate, bt.taskOutput)
  subagentRunner.start()
}

// 固定反馈管道（DESIGN-turn-pipeline / ADR-0038）：分诊（轻量 LLM，复用记忆侧
// memoryComplete：单轮、关思考）→ task 则回执先行 + 计划机械落板交 drain。
// TURN_PIPELINE=0 是保险丝：关掉后所有消息走主 agent 原路径，行为与管道
// 上线前完全一致（分诊内部失败也同样降级，双重保底）。
const turnPipeline = process.env.TURN_PIPELINE !== '0' && subagentRunner
  ? new TurnPipeline({ triage: createTriage({ complete: memoryComplete }), board: boardStore, runner: subagentRunner, sessions: sessionStore, memory: memoryManager })
  : null
if (!turnPipeline) console.warn('turn pipeline disabled (TURN_PIPELINE=0 or no runner): all messages take the legacy chat path')

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
// 微信日报/周报（DESIGN-wechat-digest.md）：per-user 管道，依赖 WECHAT_LOG_DB
// 只读挂载。未配置时 digestRunner 为 null，digest 类任务整体跳过（不会退化成
// 推一条空文本），行为与未加此功能一致——同 lark/vision/wechat_* 的条件启用模式。
// 与日报共用 schedulerAgent（ADR-0028 的独立队列），不再多开一条队列。
// 解析失败当场重生成的次数上限（ADR-0035 第 1 件）：额外问模型几次，不是
// retryMax 那种跨 tick/隔 retryIntervalMs 的重试。日报与 digest 共用同一个
// 环境变量——同一类失败（模型偶发吐坏 JSON），没必要分两套配置。
const unparsableRetries = Number(process.env.TASK_UNPARSABLE_RETRIES ?? 2)
const digestRunner = wechatLogStore && schedulerAgent ? new WechatDigestRunner({
  agent: schedulerAgent, wechatLogStore, groupProfiles, memoryStore, reportStore, posterRender, unparsableRetries,
  onError: (error, info) => console.warn(`digest ${info?.stage || '?'} failed (${info?.userId || '?'}${info?.chat ? `/${info.chat}` : ''}): ${error?.message || error}`),
}) : null
if (!digestRunner) console.warn('wechat digest disabled: needs WECHAT_LOG_DB + OPENAI_API_KEY (DESIGN-wechat-digest.md)')
const scheduler = schedulerAgent ? new TaskScheduler({
  taskStore, agent: schedulerAgent, provider, profileStore, contextTokens, reportStore, reportUrl, posterRender,
  retryMax: Number(process.env.TASK_RETRY_MAX || 3),
  retryIntervalMs: Number(process.env.TASK_RETRY_INTERVAL_MS || 20 * 60_000),
  unparsableRetries,
  digestRunner,
  // 三节全空时是否发一句"今天各群平静"（DIGEST_QUIET_PUSH=0 则彻底静默）
  digestQuietPush: process.env.DIGEST_QUIET_PUSH !== '0',
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

// `taskStore` 进 createApp 是为了 ADR-0031 的"核验通过即默认订阅"——VerificationService
// 的 onVerified 钩子此前一直没人接，现在由 createApp 内部接上。
const app = createApp({ provider, store, verifier, profileStore, agent, downloadTokens, userFilesRoot, contextTokens, reportStore, lark, taskStore, boardStore, pipeline: turnPipeline })
const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || '127.0.0.1'
await listen(app, { port, host })
console.log(`wechat-agent listening on http://${host}:${port}`)
process.on('SIGTERM', () => { scheduler?.stop(); groupWatcher?.stop(); memoryMaintenance?.stop(); subagentRunner?.stop(); contextTokens.flush(); groupProfiles.close(); process.exit(0) })
process.on('SIGINT', () => { scheduler?.stop(); groupWatcher?.stop(); memoryMaintenance?.stop(); subagentRunner?.stop(); contextTokens.flush(); groupProfiles.close(); process.exit(0) })
