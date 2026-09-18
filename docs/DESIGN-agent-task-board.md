# DESIGN：Agent 任务板——承诺与执行分层（working proposal）

- 状态：Working（提案，未实现；实现并验证后按仓库惯例收敛为新 ADR，并部分取代
  ADR-0024 的工具面章节）
- 关联：ADR-0024（任务委派——本提案**取代其工具面**，**保留复用**其 runner/结算/
  notified 底座）、ADR-0025（委派判据——判据机制原样沿用，判定范围泛化，见 §5）、
  ADR-0023（长任务反馈——activeForm 接入 progress-notifier，见 §7）、
  ADR-0026/0028（报告调度与单元重试——**明确不动**，见 §8 边界）、
  ADR-0035（失败话术与错误分类——执行失败原样适用）、
  ADR-0001/0004（多租户边界与稳定租户键——任务板严格 per-user）、
  ADR-0016（记忆三层——todo 与任务板的分工边界，见 §8）、
  DESIGN-task-delegation.md（前身提案，已收敛为 ADR-0024）
- 参考设计：workbuddy（个人助手 agent）的任务工具集
  TaskCreate / TaskList / TaskGet / TaskUpdate / TaskOutput。原始工具描述存于
  工作区 `dsh-workspace/space-开发-dsh插件开发/workbuddy-task.txt`（仓库外）；
  本文档把决策所依赖的语义**全部内联**（§2），不依赖该外部文件存续。
- 日期：2026-09-18
- 撰写说明：本提案在同一轮变更内经历过一次方向修正——第一稿方向是把板字段并入
  `task_runs` 单表，评审中被推翻（理由见 §6 备选 B）。按 requirement-change 纪律，
  就地改写本提案为当前唯一方向，不留替代链。

## 1. 问题（与方案无关）

Agent 对"**答应了用户但还没做完的事**"没有任何持久、可自维护的表示。把"任务板"
这个方案拿掉，以下事实依然成立（均为 2026-09-18 代码审计结论，含坐标）：

1. **agent 不能维护自己的工作状态**。现有四个委派工具只覆盖发起（`delegate_task`，
   `src/tools/delegate-tools.mjs:17`）、查询（`list_tasks`:57 / `task_status`:78）、
   人工重试（`retry_task`:106）——没有任何"agent 主动更新任务状态"的语义。做到一半
   发现被卡、需要拆步、需要标记完成，模型都无处落笔。
2. **无依赖表达**。"先查资料、再写文档"这类有序工作无法表示成结构，只能塞进一个
   后台 run 的 prompt 里闷头做，中途失败全部重来。
3. **无清单概念**。用户一句话带三件事，agent 要么起三个互不知晓的后台任务，要么
   一个 run 串行硬做；没有一个地方回答"我现在欠这个用户哪几件事、各到哪一步"。
4. **扛不住重启**。执行队列是纯内存（`src/services/subagent-runner.mjs:27-28`
   `#queue`/`#running`）；`src/server.mjs` 对 `TaskRunStore` 只有构造调用（:163），
   **没有任何启动期扫描恢复**（已负向核实：store 全部方法为
   create/markRunning/settle/markNotified/markRetry/get/listByUser/runningCount/
   stats/pruneFinished/close，无恢复类方法）；`retry_task` 又只允许从
   `failed/timeout/cancelled` 重试（`delegate-tools.mjs:121`）。三者叠加：进程重启后
   卡在 `pending/running` 的任务**永久悬挂**，且 `task_status` 的"已用 N 秒"
   （`delegate-tools.mjs:147-152`）随时钟持续增长，制造"还在跑"的假象。
5. **进度反馈是通用心跳**。`progress-notifier.mjs:19-21`（8s ack + 40s 心跳）只能说
   "还在处理"，说不出"正在做哪件事的哪一步"。

本质：**承诺需要一个跨轮、跨天、跨重启的载体**；现状的载体是"当前这轮对话 +
一条阅后即焚的内存队列"，两者都活不过一次进程重启。

## 2. 参考设计的核心语义（内联，决策依据）

workbuddy 五工具的可迁移语义（非逐字，按决策相关性提炼）：

- **板是 agent 自己的工作记忆**，不是用户界面。用户只会用自然语言问进度，agent 读板转述。
- **TaskCreate**：`subject`（祈使句）+ `description`（含验收上下文）+ `activeForm`
  （进行中文案，展示用）+ 可选 `owner`/`metadata`。明确的"何时不建"清单（单步琐事、
  纯对话）。
- **TaskList**：摘要视图；**可认领 = pending ∧ 无 owner ∧ 未被阻塞**；多个可选时
  **优先做最小 id**（早的任务往往为晚的铺上下文）。
- **TaskGet**：动手前读全文；**改前必读最新**（staleness 纪律）。
- **TaskUpdate**：agent 自己流转状态。**完成纪律**：测试没过 / 实现不完整 / 有未解决
  错误 / 找不到依赖 → 一律不许标 completed；**被卡 → 保持 in_progress 并新建一个
  任务描述卡点**；`deleted` 为永久移除；支持 `addBlocks`/`addBlockedBy` 建依赖边。
- **TaskOutput**：统一取回一次执行的输出（阻塞/非阻塞、超时、过滤），执行类型无关。
- **纪律全部写在工具描述里**——与本仓库 ADR-0025 独立得出的结论一致（每轮必然
  可见的表面才可靠），这是两套设计可以无缝对接的根本原因。

## 3. 提案：两层模型

### 3.1 为什么分层（本提案最重要的一个决定）

**任务 ≠ 执行。**

- **任务（板上一行）= 一个承诺**：给某个用户做成某件事。有依赖、有认领、有生命周期，
  可能经历多次尝试，也可能 agent 在对话里顺手做完、零次后台执行。
- **执行（`task_runs` 一行）= 兑现承诺的一次尝试**：有 attempts、有超时、有
  `notified` 防重推（`task-run-store.mjs:77-80` 的 CAS）。

一个任务对应 0..N 次执行。强行并成一张表（第一稿方向）的必然后果：
`blockedBy` 挂在一次执行上没有意义；`attempts` 挂在一个承诺上说不通；为对齐参考
设计的 4 态状态机就得丢掉现有执行层 `failed/timeout/cancelled` 的区分。分层后两个
状态机各安其位，**互不妥协**：

- 板：`pending → in_progress → completed`，旁路 `deleted`（终态）。
  **blocked 不是状态**，是派生条件（存在未完成的 blocker），避免双写不同步。
- 执行（现状不动）：`pending → running → done|failed|timeout|cancelled`
  （`task-run-store.mjs:14`），终态不可变、首次结果优先（:64-74）。

### 3.2 存储

新表 `agent_tasks`（建议同库 `data/task-runs.db`，与执行表同一事务域）：

```sql
CREATE TABLE agent_tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,  -- 小整数 id：token 便宜、天然有序
  user_id       TEXT NOT NULL,                      -- 稳定租户键（ADR-0004）
  subject       TEXT NOT NULL,                      -- 祈使句标题
  description   TEXT NOT NULL DEFAULT '',           -- 详情 + 验收上下文
  active_form   TEXT NOT NULL DEFAULT '',           -- 进行中文案（喂 progress-notifier）
  status        TEXT NOT NULL DEFAULT 'pending',    -- pending|in_progress|completed|deleted
  owner         TEXT NOT NULL DEFAULT '',           -- ''=无主可认领；'main'|'worker:<id>'
  result        TEXT NOT NULL DEFAULT '',           -- 最终交付摘要（结算时从执行回填）
  result_files  TEXT NOT NULL DEFAULT '[]',
  last_error    TEXT NOT NULL DEFAULT '',           -- 最近一次系统性失败（给下轮 drain 退避用）
  metadata      TEXT NOT NULL DEFAULT '{}',         -- 自由扩展（watch 型任务的钩子在这里）
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  completed_at  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE task_deps (
  task_id       INTEGER NOT NULL,                   -- 被阻塞方
  blocked_by_id INTEGER NOT NULL,                   -- 阻塞方
  UNIQUE(task_id, blocked_by_id)
);
```

`task_runs` 仅加一列 `board_task_id TEXT NOT NULL DEFAULT ''`（关联到板；空 = 旧式
独立执行，兼容存量行）。

**依赖选边表而非 JSON 列**：判定"任务 X 完成后谁被解锁"需要反向查询
（`WHERE blocked_by_id = X`），JSON 列做不到索引化；边表还天然承载
UNIQUE 去重与写入时校验（同用户、无环、blocker 存在）。

**id 用全局自增整数**：小数字省 token、`ORDER BY id` 即参考设计的"优先做早的"。
跨租户的 id 间隙泄漏（用户 A 能从自己任务 id 的跳跃推测系统总量）风险接受——
板内容本身严格按 `user_id` 过滤，不可见他人行。

### 3.3 工具面：五个换四个

| 新工具 | 取代 | 职责 |
|---|---|---|
| `task_create` | `delegate_task` | 建任务（可批量建 + 声明依赖）；**判据文本承载处**（§5） |
| `task_list` | `list_tasks` | 摘要 + 可认领标记；建新任务前查重（ADR-0025 纪律保留） |
| `task_get` | `task_status`（一半） | 全文 + 依赖两向 + 最近执行概要；**改前必读** |
| `task_update` | `retry_task` | agent 流转状态/改字段/建依赖边；**完成纪律承载处**；重试 = 失败任务改回 `pending`；取消 = 改 `deleted` |
| `task_output` | `task_status`（另一半） | 按板任务 id **或**执行 id 取输出；板 id → 最近一次执行 |

退役映射：`delegate_task` 的"派发即秒回"体验不变——`task_create` 后 drain 循环
秒级拾起；`retry_task`/`cancel_task`（ADR-0024 遗留未实现的后者）都归并进
`task_update` 的状态迁移，**cancel 语义首次真正落地**：对 `in_progress` 任务标
`deleted` → 执行结算时发现板已 deleted → 丢弃结果、抑制通知（不杀进程中的子 agent，
让它跑完但结果作废——避免引入进程级 kill 的复杂度）。

`task_update` 的服务端硬校验（不靠模型自觉）：`completed`/`deleted` 为终态不可迁出；
`completed` 必须无未完成 blocker；依赖边写入时拒绝环（DFS 深度上限）与跨用户引用。

### 3.4 执行模型：板即队列

- **主 agent 当场做**（短活）：认领（owner='main'）→ 做完 → `task_update` completed。
  不产生 `task_runs` 行。
- **后台 drain**（`SubagentRunner` 演进，底座复用 ADR-0024 全部机制）：
  1. 挑可认领任务（pending ∧ owner='' ∧ 无未完成 blocker），最小 id 优先；
  2. **认领用一条 CAS**：`UPDATE agent_tasks SET owner=?, status='in_progress'
     WHERE id=? AND status='pending' AND owner=''`——changes=1 即赢家，与
     `markNotified`（`task-run-store.mjs:77-80`）同一手法，天然防多 worker 抢单；
  3. 起 ephemeral 子 agent 执行（沿用 `subagent-runner.mjs:85`：真实用户 profile、
     不写会话/记忆、受限工具集防递归）；每次执行落 `task_runs` 行并带
     `board_task_id`；
  4. 结算：成功 → 板回填 result/completed + 既有结算通知链路（notified CAS 防重）；
     每用户并发 2 不变（`server.mjs:174` `DELEGATE_MAX_CONCURRENT`）。

**失败分两类，处置不同**：

- **模型可见的卡点**（做不下去、缺信息）：子 agent 按纪律**新建 blocker 任务**写明
  卡点，原任务保持 in_progress（对齐参考设计）；主 agent 下轮看板即知。
- **系统级失败**（超时 / LLM 4xx/5xx / 进程死）：runner 释放认领（清 owner 退回
  pending）+ `last_error` 落板；drain 依据该任务近期 `task_runs` 失败历史做退避，
  超上限（默认 3 次）停止自动重挑；错误分类与最终告知**原样走 ADR-0035**
  （不可重试类立即如实告知一次；可重试类中间静默、耗尽才说）。

### 3.5 重启恢复：分层后的免费结果

板在 SQLite 里，内存不再持有任何权威状态。恢复 = 一个幂等 sweep（启动时 + 周期）：

- `in_progress` ∧ owner 非空 ∧ **无对应 running 执行行**（或执行 started_at 超过
  阈值）→ 清 owner 退回 pending → 下轮 drain 自然接上；
- 幂等性依据：重跑产生**新的** `task_runs` 行（历史保留），用户通知由 notified CAS
  保证至多一次；
- **存量迁移**：部署时同一 sweep 把现有 `task_runs` 里无主的 `running/pending` 孤儿
  行标为 `failed`（error='进程重启中断，可重试'）——第 1 节缺口 4 对旧数据也一并关闭。

### 3.6 用户可见面（用户不看板）

- 建任务当轮：agent 自然语言确认（"两件事记下了，先做 A，B 等 A 的结果"），
  **不承诺具体结果**（ADR-0024 纪律保留）；
- 长任务进行中：`active_form` 喂给 progress-notifier 的心跳文案——从"还在处理"
  变成"正在查你 9 月的出差记录"。附带解决一处已审计的文档-代码漂移：
  DESIGN-task-delegation.md §7 曾决定"删除 40 秒定期心跳"，但
  `progress-notifier.mjs:20-21` 实际保留（intervalMs=40s, maxHeartbeats=5）且
  `server.mjs` 未覆盖参数。本提案落地时把心跳**保留但内容化**（activeForm），并在
  收敛 ADR 里如实记录"当年说删、实际没删、现在决定不删"的沿革；
- 完成/失败：沿用既有结算推送与 ADR-0035 话术；
- 用户问进度：agent 调 `task_list`/`task_get` 后**人话转述**，不粘贴板结构。

## 4. 与既有决策的关系（逐条）

| 决策 | 关系 |
|---|---|
| ADR-0024 任务委派 | **部分取代**：工具面（4 工具 + 单发模型）退役；runner、ephemeral 子 agent、受限工具集、结算通知、notified CAS、并发上限**全部保留复用**。收敛时新 ADR 与其互链，声明各自 own 的条款 |
| ADR-0025 委派判据 | **扩展**：机制不变（纪律写在工具描述），判定问题从"要不要委派"泛化为"承诺要不要落板"（§5）；其"产物沙箱割裂"遗留继续开放，不在本提案范围 |
| ADR-0023 长任务反馈 | 8s ack 保留；心跳内容化（activeForm），见 §3.6 |
| ADR-0026/0028 报告调度 | **不动**。`retry_units` 是按 (用户,主题) 结算的扇出机制，语义与板不同（§8） |
| ADR-0035 失败分类与话术 | 执行失败原样适用（分类、静默、最终告知） |
| ADR-0016 记忆（todo） | 边界重申：todo = **用户**要做的事（记忆系统）；板 = **agent** 要做的事。互不迁移 |
| DESIGN-task-delegation.md | 前身。已收敛为 ADR-0024，其状态行同步修正；本提案是它的下一代 |

## 5. 何时建任务（判据，写进 `task_create` 描述）

**核心二分（动手前即可判定）**：这一轮结束时，用户拿到的是**结果**还是**承诺**？
- 拿到结果 → 不建任务；
- 只能给承诺 → 必须建任务——承诺需要载体去兑现。

**结构性信号**（命中任一即建）：≥2 件可独立交付的事；有顺序依赖；产物是交付物
（文件/文档/报告）；要等外部（人 / 时间 / 数据）；中间状态必须跨轮保留；用户明说
"帮我盯着 / 记一下（给你做的事）"。

**反判据（禁止清单，与正判据同等地位）**：
- 不许按"预计耗时"判（模型估不准——ADR-0025 已证明过一次代理指标之害）；
- 不许给做完的事补建任务；
- 不许把一件事拆成琐碎步骤铺满板（任务 = 有意义的交付单元，步骤活在 run 里）;
- 建前必 `task_list` 查重；对既有任务的追问走 `task_get`/`task_output`，不新建。

**校准闭环**（沿用 DESIGN-task-delegation §6.5 思路）：`stats()`
（`task-run-store.mjs:111-132`）已有短任务派发率；板侧新增两个派生指标——
"创建后 <30s 即 completed 占比"（过度建任务信号）与"用户问进度但板上无对应行"
（该建没建信号）。判据的好坏由这两个数字证伪，不靠感觉调 prompt。

## 6. 备选方案（真实取舍）

- **A：只补重启恢复，不做板。** 修掉最痛的缺口 4，但缺口 1-3（无自维护状态、无依赖、
  无清单）原样保留；且恢复逻辑写在"单发任务"旧模型上，板一来还得重写一遍。落选：
  同一片代码两次施工。
- **B：板字段并入 `task_runs` 单表（本提案第一稿）。** 表面省一张表，实际把承诺与
  尝试两种生命周期焊死：blockedBy 对执行无意义、attempts 对承诺无意义、状态机被迫
  二选一。评审中推翻，理由已入 §3.1。
- **C：引入外部任务框架（BullMQ / 消息队列）。** 新增运行时依赖（Redis），与单机
  SQLite 个人助手的规模完全不成比例；且现有 notified CAS / 终态不可变语义要重新
  发明一遍。落选。

## 7. 验收标准（可证伪；证据对准失败层）

| # | 断言 | 失败层 | 直接证据 |
|---|---|---|---|
| A1 | 多件事请求 → N 板行 + 正确依赖边 | 工具/模型协作 | 工具序列单测 + 一条真实 `/api/chat` 端到端路径 |
| A2 | 并发认领恰一个赢家 | store 原子性 | 单测：同任务两次 claim，第二次 changes=0 |
| A3 | 重启恢复：in_progress+死 owner → sweep → pending → 重跑 → **用户至多一次通知** | 恢复/幂等 | replay 测试，断言 notified 位与推送 mock 调用次数 |
| A4 | 依赖环被拒绝 | store 校验 | 单测 A→B→A 第二条边报错 |
| A5 | 跨用户不可见 | 租户边界 | 单测：A 的 list/get 拿不到 B 的行 |
| A6 | 存量孤儿执行行被清理为可重试 | 迁移 sweep | 单测造 running 孤儿 → sweep → failed 且 retry 可用；部署时生产核对一次 |
| A7 | cancel：in_progress 标 deleted → 结算结果被丢弃、零通知 | 结算联动 | runner 单测 |
| A8 | 调度器测试套件一字未改全绿 | 负向保证（不波及） | 既有 tests 全量 |
| A9 | 纪律条款存在于工具描述 | 机械可判 | 描述文本断言。**行为层面的完成纪律是概率性的，只做抽样审计，不宣称不变量**（诚实边界） |

## 8. 边界与非目标

- **调度任务不上板**（日报/周报/每日资讯及用户自建定时任务留在 TaskScheduler）；
- **不做用户可见的板 UI**；不做跨用户/全局板（板严格 per-user）；
- **watch 型任务**（"帮我盯着 X"）：phase 1 只作为普通板任务存在（metadata 留钩子），
  事件驱动的 sweep 另行提案；
- **worker pool 扩容**（并发 >2）与产物跨会话交接：留待后续，字段已就位。

## 9. 风险与放弃的能力

- **token 开销**：五工具描述常驻 + 活跃用户的板读写。靠 §5 校准指标观测，超标再收紧
  判据；这是用 token 买"承诺不丢"的明码交易。
- **LLM 纪律是概率性的**：错误 completed 无法根除，只能靠描述纪律 + 服务端硬校验
  （终态/blocker 检查）+ 抽样审计压低。
- **两层多一个关联概念**：实现与排查要多想一层 join；`task_output` 对常见场景
  （给板 id 拿最近执行）隐藏该复杂度。
- **放弃**：`delegate_task` 一句话即发的极简性（`task_create` 描述更重）；执行中
  子 agent 的进程级中止（cancel 只作废结果，不杀进程）。
- **迁移注意**：全仓负向搜索 `delegate_task` 引用（含 skills/ 提示词），实现时同步
  清理——此为验收 A8 之外的独立检查项。

## 10. 未确认（如实）

- workbuddy 的并发与持久化**实现**细节不可得（只有工具描述文本），本提案按描述语义
  推定其行为契约；
- 板读写的真实 token 开销未实测，上线后用 §5 指标量；
- `delegate_task` 是否被仓库外（用户自装技能等）引用，实现时负向搜索确认。
