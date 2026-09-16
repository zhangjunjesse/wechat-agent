# 收尾记录：日报调度可靠性修复（ADR-0028，2026-09-16）

> 本文件是这次修复的落盘完成凭证：发现了什么、改了什么、每一步的核实证据。

## 背景与发现

用户提问「很多人都订阅、都在 8 点执行，会不会崩溃」。排查结论：不会因并发/
内存崩溃（`#tick()` 纯串行 for 循环、LLM 调用走 `AgentsSdkAgent` 单实例串行
队列、海报渲染一次性子进程用完即杀，三处天然把并发钳死在 1），但发现两个
真问题：

1. **重试判定粒度对不上（正确性 bug）**：ADR-0027 之后一个报告任务一轮有
   多个独立生成单元（公共版 + 每个 (用户,主题)），但 ADR-0026 的重试判定是
   任务级全有全无（`retry = anyAttempted && !anySucceeded`）——部分成功部分
   失败时，失败单元既不被重试，其用户还收到过「系统会自动重试，无需操作」
   的**虚假承诺**（任务已结算，承诺不会兑现）。
2. **调度器和实时聊天抢同一条串行队列（延迟风险）**：`TaskScheduler` 与
   `MessageRouter`（私聊）/`GroupCommandWatcher`（群命令）共用主
   `AgentsSdkAgent` 实例 = 共用一条串行执行队列，8 点批量日报生成会把实时
   消息堵在队列后面，订阅规模上去后忙碌窗口拉长到分钟级。

## 改动文件

| 文件 | 改动 |
|---|---|
| `src/services/task-store.mjs` | 新增 `retry_units` 列迁移（`PRAGMA table_info` + `ALTER TABLE`，默认 `'[]'`，风格同 ADR-0026 的 `attempt_count`）；新增 `setReportRetryUnits(id, units)`；`markRun` 结算时一并清空 `retry_units`；`#map` 输出 `retryUnits` |
| `src/services/task-scheduler.mjs` | `#runReportTask` 重写为按生成单元执行：首轮跑全部单元，失败单元（含 unparsable 降级）记入 `retry_units`（含各自尝试次数），重试轮只重跑挂着的单元，已成功用户绝不重复推送；全部单元成功或耗尽后才返回 `retry=false`（→ `markRun` 整体结算）；失败话术按单元自己的重试余量措辞。`#tick()` 零改动（单元 attempts 与任务级 attemptCount 天然同步：首轮全跑、重试轮只跑挂着的） |
| `src/server.mjs` | 新增 `schedulerAgent`（独立 `AgentsSdkAgent` 实例）供 `TaskScheduler` 独享：全量工具集（同主 agent 的同一个 `tools` 数组引用，非 `makeSubagent` 受限版）+ `...sessionOpts` 同一份 `sessionStore`/`memoryStore` 引用（`#runForUser` 写用户真实会话历史，数据源必须一致），分开的只有串行队列 |
| `tests/task-scheduler.test.mjs` | 新增 2 条 ADR-0028 测试（见下）；修正 ADR-0027「部分失败」测试的结算断言（原断言 `lastRunAt > 0` 锁的正是本次要修的 bug 行为，改为断言不结算 + 失败单元进 `retry_units`；「主题间互不连累」的本意保留） |
| `tests/task-store.test.mjs` | 新增 1 条 `retry_units` 状态机测试（默认空数组 / 覆写 / `markRun` 清空） |
| `docs/ADR-0028-report-scheduler-reliability.md` | 新增决策记录（交叉引用 ADR-0026/0027/0024） |
| `docs/STATUS.md` | 测试数 342→345；新增「日报调度可靠性（ADR-0028）」一节 |

## 测试证据

- **改动前基线**：`node --test tests/*.test.mjs` → **342/342 全绿**（本机实测，
  与 STATUS.md 记录一致）。
- **改动后**：`node --test tests/*.test.mjs` → **345/345 全绿**（净增 3）：
  - `partial failure retries only the failed unit; delivered units are never
    re-pushed (ADR-0028)`：3 个单元（公共版 + u1 的 AI/芯片），AI 失败其余
    成功 → 任务不结算、`retry_units=[{u1,AI,attempts:1}]`；重试轮只多 1 次
    生成（合成会话 id 精确断言为 AI 单元）、u2/芯片不被重复推送；AI 成功后
    整体结算、单元状态清空；结算后不再触发。
  - `a unit that keeps failing exhausts its own retries, gets the give-up
    text, then the task settles (ADR-0028)`：AI 连续失败 3 次（retryMax=2）→
    最后收到「已重试 3 次仍失败，今天不再重试，明天按计划再试」、任务结算
    （锚点推到明天）、`retry_units` 清空；芯片全程只生成/推送 1 次。
  - `setReportRetryUnits persists per-unit retry state and markRun clears it`。
- ADR-0026 的全部既有重试测试（全失败→节流→耗尽→结算、中途成功即结算、
  unparsable 降级、投递失败不占重试预算）**不改一字全绿**——单一单元场景下
  新旧判定等价。

## 问题 2 的核实方式（无接线单测，按仓库惯例代码核实）

仓库没有 server.mjs 接线的直接单测先例（一贯做法是组件级测试复刻构造参数，
如 `delegate-tools.test.mjs`）。代码核实：

- `src/server.mjs` 现在有三处 `new AgentsSdkAgent`：113 行主 `agent`（供
  `createApp`/`MessageRouter` 与 `GroupCommandWatcher`）、121 行 `makeSubagent`
  （委派子 agent，受限工具集）、160 行 `schedulerAgent`（本次新增，供
  `TaskScheduler`，162-163 行 `agent: schedulerAgent`）。
- `AgentsSdkAgent` 的 `#runQueue = createSerialQueue()`（`agents-sdk-agent.mjs:25`）
  是**实例字段初始化器**——每次 `new` 必然各持一条独立队列，两个实例的
  `respond()` 互不排队。
- 两处构造展开同一个 `sessionOpts` 对象（同一 `sessionStore`/`memoryStore`
  实例引用 → 同一个 `data/sessions.db`/`data/memories.db`），传入同一个
  `tools` 数组引用（构造时 delegate 工具已 push 进该数组，两实例工具集逐项
  一致）。

## Git 证据

- Commit：**`bb677351a9e0ce9fd5bbee45477b3470edc9d515`**
  （`日报调度可靠性：重试按生成单元下沉 + 调度器独享执行队列（ADR-0028）`，
  7 files changed, 437 insertions(+), 46 deletions(-)）
- Push 成功核对（`git ls-remote --heads origin main` 与本地 `git rev-parse HEAD`
  逐字节一致）：

  ```
  bb677351a9e0ce9fd5bbee45477b3470edc9d515	refs/heads/main
  bb677351a9e0ce9fd5bbee45477b3470edc9d515
  ```

## 生产部署证据（datadefender.cn，容器 wechat-agent，env 零改动）

流程：`npm pack --pack-destination deploy`（191 files，shasum
`7e7e76649c9f2c8583a81773eee66bd1ed4a9faf`）→ scp 到
`/opt/wechat-agent/` → ssh `bash -s` 管道执行（本地脚本 `tr -d '\r'` 去 CRLF）：
解压 → `rsync -a --delete --exclude node_modules` 进 `/opt/wechat-agent/app/`
→ `docker restart wechat-agent` → 等 8 秒 → healthz 轮询。

- **healthz**：第 1 次即 `200`。
- **启动日志**（tail 20）：`global tasks loaded: 每日早报` +
  `wechat-agent listening on http://0.0.0.0:8789`，其余仅已知老噪音
  （`Tracing: request failed`/`failed to export traces`、5 个过期 iLink 绑定的
  `session timeout (-14)`、SQLite ExperimentalWarning）——干净启动。
- **容器内 grep 改动标记**（确认跑的是新代码，不是只重启）：

  ```
  /app/src/services/task-scheduler.mjs:4     ← 'ADR-0028' 出现次数
  /app/src/server.mjs:1
  /app/src/services/task-store.mjs:3
  /app/docs/ADR-0028-report-scheduler-reliability.md:1
  task-store.mjs:57  if (!cols.includes('retry_units')) ... ALTER TABLE tasks ADD COLUMN retry_units ...
  task-store.mjs:264 markRun ... retry_units = '[]' ...
  server.mjs:159/162/163  schedulerAgent 接线
  ```

- **清理**：远程 `/tmp/wa-deploy-adr0028` 与 `/opt/wechat-agent/wechat-agent-0.1.0.tgz`
  已删；本地 `deploy/wechat-agent-0.1.0.tgz` 与 `deploy/_deploy-adr0028.sh`
  已删（`git status` 干净）。

## 遗留（同 ADR-0028）

- 忙碌窗口只是被隔离没有被缩短（生成总量仍随订阅规模线性涨）。
- 投递失败仍不重试（维持 ADR-0026 的生成/投递区分）。
- 队列隔离效果未经生产高峰实测（当前规模触不到该窗口）。
- `retry_units` 迁移在生产的实际生效要等下一次任务执行/重启后建列（重启已
  发生，进程启动时 TaskStore 构造即补列）。
