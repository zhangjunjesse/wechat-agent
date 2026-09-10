# ADR-0014: 定时任务系统（私有任务 + 公共任务订阅）

- 状态：Accepted
- 类型：Architecture / Feature
- 日期：2026-09-10
- 前身：`docs/DESIGN-timed-tasks.md`（working proposal，已实现，本记录为稳定决策）

## 问题

用户只能被动等 agent 响应，不能"到点主动收到内容"。需求：① 用户通过 agent 设置
自己的定时任务（每日推送/每日总结）；② 区分用户私有任务与公共全局任务（系统预置，
用户订阅/退订）。

## 决策

### 1. 任务模型

- **私有任务**（scope=user）：用户通过 `create_task` 创建，owner 独享；执行只推 owner。
- **公共任务**（scope=global）：管理员配置 `deploy/global-tasks.json` 预置
  （`loadGlobalTasks` upsert，保留 subscribers）；用户 `subscribe_task`/`unsubscribe_task`
  管理自己的订阅；执行对每个订阅者各推一轮。
- 存储：SQLite `data/tasks.db`（node:sqlite，与 sessions/memories 一致；`TaskStore`）。

### 2. 调度：极简表达式，零第三方依赖

- 格式：`daily@HH:MM` / `weekly@D@HH:MM`（D=1周一~7周日）/ `hourly@MM`，北京时间。
- `src/services/schedule.mjs`：`parseSchedule` / `nextRunAt`（下一个触发点）/
  `describeSchedule`（人类可读展示）。
- `TaskScheduler`：30s tick（`timer.unref`），`sweep()` 公开（测试/手动触发）。

### 3. 到期判定（anchor 模型）

- `next = nextRunAt(schedule, anchor)`，`anchor = lastRunAt > 0 ? lastRunAt : createdAt`；
  `next <= now` 即执行。**刚创建的任务绝不补跑创建前的周期**；执行后 `lastRunAt = now`
  天然防重。

### 4. 执行与投递

- 对每个目标用户：profile 必须已验证（nickname/wxid）→ `agent.respond`
  （text 包装为"【定时任务「name】」+ instruction"，可自由用工具/记忆/技能）→
  iLink `sendText` 推送微信。
- **contextToken 缓存**（前置）：`ContextTokenCache`（内存 Map + 落盘
  `data/context-tokens.json` 防抖写，重启恢复）；`MessageRouter` 每次入站更新；
  调度器推送时读取。无有效 token 的用户跳过并记 `lastError`（不中断其他订阅者）。
- 未验证用户跳过；`lastRunAt`/`lastError` 任务级记录。

### 5. Agent 工具集

`create_task` / `list_my_tasks` / `delete_task`（owner 校验）/ `list_global_tasks` /
`subscribe_task` / `unsubscribe_task`。模型按用户意图调用。

## 备选（不选的理由）

- **node-cron**：需要服务器重装依赖，tgz 部署链路复杂化；极简格式覆盖需求。
- **完整 cron 语法**：对用户和模型难写难校验。
- **独立 LLM 调用执行**：失去工具/记忆/技能能力；复用 agent.respond 一次搞定。
- **公共任务复制成私有**：丢失订阅语义，无法跟随公共任务更新。

## 后果

- 用户可自建周期任务（每日/每周/每小时），也可订阅系统公共任务。
- 主动推送依赖 contextToken 有效性（用户最近与 bot 互动过）；长时间不互动可能
  推送失败（记 lastError，用户重新互动后恢复）——这是 iLink 协议的现实约束。
- 错过周期不补跑（anchor 模型），避免创建即补发/宕机补发。

## 验收证据

- `npm test`：**166/166 全绿**（schedule 解析/nextRunAt/previousRunAt 5 条、
  TaskStore CRUD+订阅隔离+upsert 3 条、ContextTokenCache 落盘恢复 2 条、工具集 2 条、
  调度器触发/防重/跳过/多订阅者 4 条）。
- 服务器实测定时任务触发一轮（观察 agent 执行 + 推送尝试）。

## 遗留（诚实边界）

- 预置公共任务当前仅"每日早报"（`deploy/global-tasks.json`），管理员编辑文件后重启生效；
  后续可加 manage 工具热更新（未做）。
- iLink 主动推送的 contextToken 有效期行为待真实会话长期验证。
