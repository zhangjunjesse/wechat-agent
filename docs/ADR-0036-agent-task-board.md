# ADR-0036: Agent 任务板——承诺与执行分层（板即队列）

- 状态：Accepted（已实现并通过全量测试；生产部署另行执行）
- 类型：Architecture / Feature
- 日期：2026-09-18
- 前身：`docs/DESIGN-agent-task-board.md`（working proposal，含完整问题论证、
  备选与验收推导，已收敛为本记录；参考设计 workbuddy 五工具语义内联在该文档 §2）
- 关联：**部分取代 ADR-0024**（工具面：delegate_task/list_tasks/task_status/retry_task
  四工具退役；其 runner 底座条款——独立实例/ephemeral/受限工具集/并发上限/notified
  CAS/无抢占——由本记录继承并继续有效）；**修正 ADR-0025 的事实位置**（判据仍写在
  工具描述里，但所在工具变为 `task_create`，判定问题从"要不要委派"泛化为"承诺要不要
  落板"）；ADR-0035（失败分类与话术，执行失败原样适用）；ADR-0001/0004（板严格
  per-user）；ADR-0016（todo=用户要做的事，板=agent 要做的事，互不迁移）；
  ADR-0026/0028（调度器不动，定时任务不上板）

## 问题

Agent 对"答应了用户但还没做完的事"没有持久、可自维护的表示：不能自己更新任务状态、
无依赖表达、无清单概念（多件事塞一个 run 硬做）、执行队列纯内存——进程重启后
pending/running 的委派任务**永久悬挂**且 `task_status` 的"已用 N 秒"持续虚增。
完整论证与代码坐标见 DESIGN 文档 §1。

## 决策

**两层模型**：承诺与执行分离，同一个 DB 文件（`data/task-runs.db`）。

| 层 | 表 | 一行是什么 | 状态机 |
|---|---|---|---|
| 板（新） | `agent_tasks` + 边表 `task_deps` | 一个承诺：依赖/认领/生命周期/退避 | `pending → in_progress → completed`，旁路 `deleted`（终态不可迁出；blocked 是派生不是状态） |
| 执行（原有） | `task_runs`（+`board_task_id` 列） | 兑现承诺的一次尝试 | 原 6 态不变，`notified` CAS 防重推 |

一个任务对应 0..N 次执行；强行单表会让 blockedBy 挂在执行上无意义、attempts 挂在
承诺上说不通，还得为对齐参考设计丢掉 failed/timeout/cancelled 区分（DESIGN §3.1）。

**五工具**（`src/tools/task-board-tools.mjs`，取代 delegate 四工具）：
`task_create`（判据承载处：结果 vs 承诺二分 + 结构信号 + 反判据 + 查重 + 自包含）、
`task_list`（可认领视图 + 建前查重）、`task_get`（改前必读，staleness）、
`task_update`（完成纪律承载处；重试=status→pending **幂等清退避**；取消=deleted）、
`task_output`（板 id 或执行 id 取输出）。纪律在描述里，关键迁移有**服务端硬校验**：
终态不可迁出、有未完成前置不能标 completed、依赖防环（BFS）、跨用户不可见。

**板即队列**（`SubagentRunner` 重写）：可认领 = pending ∧ 无 owner ∧ 无未完成
blocker ∧ auto_attempts 未满 ∧ 越过时间退避。认领是一条 CAS UPDATE（恰一个赢家）。
每用户并发 2；执行走 ephemeral 子 agent（无任务板工具防递归）。

**失败双轨**（ADR-0035 落到板上）：可重试（超时/限流/网络）→ 释放回 pending +
auto_attempts+1 + **时间退避**（默认 60s，`retryBackoffMs`——没有它，释放并发位后的
立即 re-drain 会连珠炮式重试，限流根本等不到自愈），中间**静默**，攒满
`BOARD_MAX_AUTO_ATTEMPTS`（默认 3）才通知一次；不可重试（402/401/400）→
auto_attempts 直接顶满 + 立即通知一次。通知永不含错误码/原始报错、永不承诺
"会自动重试"；完整错误进服务端日志。

**重启恢复 = 免费结果**：板在 SQLite 里，内存不是权威。`recover()`（启动 + 30s 周期）
释放死认领（worker owner 不在本进程 live 集合；`main` owner 超过 10 分钟）回 pending，
不占退避预算；重跑产生新执行行，notified CAS 保证用户至多一次通知。启动时
`failOrphans()` 把上个进程遗留的 pending/running 执行行如实标 failed（可重试）——
关闭审计发现的悬挂缺口，对旧数据同样生效。

**cancel 语义**（ADR-0024 一直没做的 `cancel_task` 就此落地）：对 in_progress 任务标
deleted → 执行结算时发现板已 deleted → 结果作废、零通知（不杀进程中的子 agent，
执行行仍如实记录结局供审计）。

**用户可见面**：用户不看板。建单/进度/结果全部人话；`activeForm` 喂给
progress-notifier——心跳从"仍在处理中"变成"仍在处理中：正在导出季度总结"
（`message-router.mjs`；群命令入口 phase 1 未接，见遗留）。

## 备选（详见 DESIGN §6）

只补重启恢复不做板（同一片代码两次施工）；板字段并入 task_runs 单表（第一稿方向，
评审推翻——两种生命周期焊死）；外部任务框架（新增 Redis 级依赖，规模不成比例）。

## 后果

- 承诺跨轮/跨天/跨重启不丢；多件事有结构（DAG）；agent 可自维护状态；
- 换来的代价：五工具描述常驻的 token 开销（校准指标：`AgentTaskStore.stats()` 的
  under30sRate=过度建任务信号）；两层多一个 join 概念（task_output 隐藏常见场景）；
- 放弃：delegate_task 一句话即发的极简性；执行中子 agent 的进程级中止；
- LLM 完成纪律是概率性的——描述纪律 + 服务端硬校验 + 抽样审计压低，不宣称不变量。

## 验证（2026-09-18 实际执行）

- Passed: `node --test --test-concurrency=1 "tests/*.test.mjs"` → **509/509**
  （新增 31：store 9 / runner 8 / tools 5 / run-store 2 + 既有改造；原 delegate-tools
  测试随工具一并删除）。覆盖：CAS 认领唯一赢家（A2）、依赖环拒绝（A4）、跨用户
  隔离（A5）、**重启恢复 replay**——死认领释放→重跑→用户恰一次通知（A3）、可重试
  失败中间静默/放弃才说 + 时间退避钉死"不连珠炮重试"、402 类立即通知不再自动重挑、
  取消作废结果零通知（A7）、孤儿执行行清理后可人工重试（A6）、纪律文本存在于
  工具描述（A9 机械半）、调度器/路由/既有全量无回归（A8）。
- Passed: `node --check src/server.mjs src/app.mjs`（装配层不在测试执行路径内）。
- Inspected: 负向搜索 `delegate_task|delegate-tools|list_tasks|task_status|retry_task`
  在 src/skills/tests 仅剩历史性注释（描述"被取代者"），无活引用。
- Not run: 生产部署与真实微信端到端（部署时按 A1 的运行时半验：真实多件事请求 →
  板行 + 依赖 + 完成通知）。

## 遗留（诚实边界）

- **A1 的运行时半**（真实 LLM 会不会按判据建任务/维护状态）未验——测试全是直接调
  工具；上线后靠 stats 校准指标 + 抽样观察。
- 群命令入口（GroupCommandWatcher）的心跳未接 activeForm，仍是通用文案。
- 后台执行的子 agent **没有**任务板工具（防递归），所以"被卡→建 blocker 任务"的
  纪律只约束主 agent；子 agent 的做不下去表现为"结果说明里写清缺什么"（done 携带
  解释文本）。
- watch 型任务（"帮我盯着 X"）只能作为普通板任务存在，事件驱动 sweep 未做
  （metadata 留了钩子，另行提案）。
- 时间退避是固定值非指数；`main` 认领的 10 分钟 stale 阈值是经验值。
- 板任务的产物仍落在 `subagent:<runId>` 沙箱（ADR-0025 已知遗留，未随本次解决）。
