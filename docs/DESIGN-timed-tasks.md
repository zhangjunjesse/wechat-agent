# DESIGN：定时任务系统（私有任务 + 公共任务订阅）（已实现 → 稳定决策见 ADR-0014）

- 状态：**Superseded by [ADR-0014](ADR-0014-timed-tasks.md)**（2026-09-10 实现完成；
  本文保留为设计过程记录。实现覆盖 P0+P1 全部内容，含 anchor 模型到期判定与
  contextToken 缓存；公共任务预置见 `deploy/global-tasks.json`）
- 关联：ADR-0006（forced skill invocation）、ADR-0013（渐进式技能）、iLink 发送（ADR-0009）
- 日期：2026-09-10

## 问题（与实现无关）

1. 用户只能被动等 agent 响应，不能"到点主动收到内容"——没有定时能力：每日信息推送、每日总结等只能靠用户手动发起。
2. 任务有两类不同归属：用户自己的任务（私有）与系统提供的通用任务（如"每日新闻推送"），后者应该让用户订阅/退订，而不是每个用户各建一份。

## 现状盘点

- **无任何定时调度**：唯一常驻循环是 `PollingService`（1s 轮询 iLink 入站消息）；`setTimeout`/`setInterval` 仅用于请求超时与页面轮询。
- **todo ≠ 定时任务**：`add_todo`/`list_todo` 是 MemoryStore 的待办清单（截止日期只是展示字段，无触发）。
- **主动推送缺 contextToken**：iLink `sendText` 强制要求 `context_token`（只能从入站消息拿到，ADR-0009 已记录"未缓存最近 contextToken"）——定时任务要主动推微信，必须先解决这个。

## 设计

### 1. 任务模型（私有 / 公共 + 订阅）

```
Task {
  id            // 稳定 id
  scope: 'user' | 'global'
  name          // 任务名（唯一；global 任务的订阅键）
  schedule      // 调度表达式（见下）
  instruction   // 到点后交给 agent 执行的指令模板（自然语言）
  // user 任务：
  ownerUserId
  // global 任务：
  subscribers: string[]   // 订阅者 userId 列表
  enabled, createdAt, lastRunAt, lastError
}
```

- **私有任务**：用户通过 agent 创建/删除/查看，只对该用户生效（owner 即执行对象）。
- **公共任务**：管理员预置（配置文件），用户可订阅/退订；执行时对每个订阅者各跑一轮。

### 2. 存储：SQLite（`data/tasks.db`，node:sqlite，与 sessions/memories 一致）

`tasks` 表存任务 + subscribers（JSON 列）。避免 JSON 文件并发写问题（调度器与 agent 工具同时写）。

### 3. 调度格式：极简周期表达式，零第三方依赖

不引入 cron 库（node_modules 需在服务器重新 npm install，tgz 部署不含依赖）。需求场景就是"每日/每周/每小时"周期，用自研极简格式：

```
daily@HH:MM        每日（如 daily@08:00）
weekly@D@HH:MM     每周某天（1-7 周一到周日，如 weekly@1@08:00）
hourly@MM          每小时的第 MM 分（如 hourly@00）
```

`SchedulerService`（类 PollingService 模式）：每 30s tick 一次，匹配到期任务执行。时区固定北京时间（复用 `src/services/time.mjs`）。

### 4. 执行与投递：contextToken 缓存（关键前置）

- **新增 contextToken 缓存**：`message-router` 收到 iLink 入站消息时，把
  `(toProviderUserId → { contextToken, providerBotId, at })` 写入内存 Map（+ 周期落盘 JSON，
  重启不丢）；`ILinkProvider` 发送时优先用传入值，无则用缓存。
- **到点执行**（对每个命中任务的每个目标用户）：
  1. `agent.respond({ userId, text: 任务指令包装（标记"这是定时任务 X，请执行…"）, profile })`
     —— agent 可自由使用已有工具（gzh 搜索、记忆、生成等）产出内容；
  2. 产出经 iLink `sendText` 推给该用户的微信（用缓存的 contextToken）；
  3. 记录 `lastRunAt`；失败（contextToken 缺失/过期）记 `lastError` 并跳过，不中断其他订阅者。
- 未绑定微信/无 contextToken 的用户：任务创建/订阅时提示"需要先绑定并给助手发过消息"，执行时跳过并记录。
- 网页用户（只走网页聊天的）默认不适合推送类任务——订阅工具返回说明。

### 5. Agent 工具集（用户侧，走渐进式技能编排）

| 工具 | 作用 |
|---|---|
| `create_task` | 创建私有任务（name/schedule/instruction） |
| `list_my_tasks` | 查看自己的任务（含下次触发时间） |
| `delete_task` | 删除自己的任务（校验 owner） |
| `list_global_tasks` | 公共任务目录（可订阅的） |
| `subscribe_task` / `unsubscribe_task` | 订阅/退订公共任务 |

模型按用户意图调用（"每天早上8点给我推送行业新闻"→ 订阅公共"每日新闻"或建私有任务）。

### 6. 公共任务来源：配置文件（`deploy/global-tasks.json`，部署时放置）

启动时加载/合并进 tasks 库（name 冲突则更新 instruction/schedule，subscribers 保留）。
示例：`每日早报`（daily@08:00，"搜索今天的 AI 与科技要闻，汇总成 5 条简报"）、
`每日总结`（daily@22:00，"回顾今天我们的对话，输出今日小结与明日建议"）。

### 7. 错误处理与幂等

- 执行串行化（同一任务同轮不并发）；`lastError` 保留最近一次失败原因；
- 推送失败不重试当天（记录即可），避免重复打扰。

## 备选方案（不选的理由）

- **引入 node-cron / cron-parser**：功能强但要在服务器重装依赖，tgz 部署链路复杂化；极简格式已覆盖需求（每日/每周/每小时）。
- **完整 cron 五段式**：对用户和模型都难写难校验，收益低。
- **任务执行用独立 LLM 调用而非 agent.respond**：会失去现有工具/记忆/技能能力，产出质量差；复用 respond 一次搞定。
- **公共任务让每个用户复制成私有**：订阅语义丢失（用户无法跟随公共任务更新），与需求"订阅"不符。

## 验收标准

1. `create_task` 创建私有任务，`list_my_tasks` 可见，`delete_task` 只删自己的。
2. 公共任务目录 `list_global_tasks` 展示，`subscribe_task`/`unsubscribe_task` 生效且隔离（只影响自己）。
3. 到点后 agent 真实执行（复用工具），产出推送到订阅者微信（需已绑定 + contextToken 缓存）。
4. contextToken 缓存随入站消息更新，重启不丢。
5. 失败（无 contextToken/超时）记录 `lastError`，不中断其他用户。
6. `npm test` 全绿（新增存储/调度/工具/投递单测，mock 掉真实 LLM 与 iLink）。
7. 服务器实测定时任务触发一轮（观察推送）。

## 风险与未决

- **iLink 主动推送可靠性**：contextToken 有有效期，长时间不互动可能过期——过期后推送失败并提示用户重新互动一次（待实测确认行为）。
- **多订阅者轮询执行耗时长**：串行执行 N 个用户可能拉长 tick；先串行（量小），量大再加并发上限。
- **公共任务配置方式**：先配置文件（管理员编辑重启），后续可加 manage 工具热更新。
- **执行失败是否重试**：本期不重试（记录 lastError），避免重复打扰。

## 分期建议

- **P0**：任务存储 + SchedulerService + contextToken 缓存 + 私有任务工具（create/list/delete）。
- **P1**：公共任务（配置文件 + subscribe/unsubscribe + 目录工具）+ 到点执行 agent + 微信推送。
- P0/P1 可在一次 bounded change 内完成（本设计整体评审通过后实施）。
