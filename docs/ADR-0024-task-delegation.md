# ADR-0024: 任务委派——主 agent 秒回，长任务交后台子 agent

- 状态：Accepted（**部分被 ADR-0025 取代**：§决策 3·判断力三层的 ① 四条硬判据与 ② 技能装判据；
  架构部分——独立实例/ephemeral/受限工具集/队列/超时/落库/通知纪律——仍然有效）
- 类型：Architecture / Feature
- 日期：2026-09-15
- 前身：`docs/DESIGN-task-delegation.md`（working proposal，已实现，本记录为稳定决策）
- 关联：ADR-0023（长任务进度反馈，本记录收敛其"定期播报"条款）、ADR-0022（群命令入口）、
  ADR-0013（技能）、ADR-0014（定时任务）
- 研究依据：`docs/research-dsh-subagent.md`、`docs/research-dsh-jobs.md`、
  `docs/research-dsh-delegation-rules.md`（本机 DSH 实现，含代码坐标）

## 问题

主 agent 的 `respond()` 是同步的：一个多步任务要跑完整个 agent loop（1-3 分钟）才返回并推送；
叠加"agent run 串行化"（保护 deepseek thinking 缓存），并发消息还会排队。ADR-0023 的
ack + 心跳只让等待**可感知**，没有解决"主 agent 被长任务占用"的本质。

## 决策

### 1. 架构：主 agent 只决策，长任务后台执行

`delegate_task` 工具把**自包含 + 多步 + 耗时**的任务交给 `SubagentRunner` 后台执行，
工具**立即返回**「已派发任务 #N」，主 agent 秒回用户（因此不被占用，可继续接待其他消息）；
子任务结算时 runner **无条件通知用户**（成功/失败/超时都通知，`notified` 位保证只发一次）。

### 2. 与 DSH 的对应与有意偏离

| DSH | 本项目 | 理由 |
|---|---|---|
| `spawn`（零父历史）vs `fork`（seed=父已完成轮次） | 只做 spawn：`goal` + 可选 `context` 摘要 | 微信任务多为自包含；带整段历史费 token |
| `JobSnapshot` 纯内存（进程死即丢） | **落库 `TaskRunStore`（SQLite）** | 用户跨会话问"任务怎么样了"、重启不丢、需审计与重试 |
| `followup` 唤醒 / `inject` 注入 next-step | **直接推微信** + 用户可查（`list_tasks`/`task_status`） | 微信没有"唤醒 agent"；用户要的是消息 |
| 通知只给 id + 取用指令（`job_output`） | 通知带**结果摘要**（≤200 字） | 用户不方便"再调工具读输出" |
| 每 owner 10 并发、无队列 | **每用户并发 2 + 队列排队** | 每个子 agent 是完整 LLM run，需成本上限 |
| `maxDepth=3`（子可再委派） | **子 agent 无 delegate/task 工具**（不可递归） | 防递归与成本爆炸 |
| 工具限制不继承（子级自己的表） | 子 agent 受限工具集：业务工具 + `send_file`/`notify_user`，无 task/delegate | 子级要能自己交付文件与汇报；不能递归派发 |
| 结算通知在所有权释放前、无条件 | 同样：先落终态 → 再通知 → 再释放并发位 | 最需要说明结局的正是"子级没机会开口"的情形 |
| 首次结果优先（晚到者丢弃） | 同样：终态不可变 | 防乱序/重复覆盖 |
| 无子 agent 墙钟超时 | **单任务超时 300s**（env 可配）→ timeout 终态 + 通知 | 微信场景不能让任务无限挂起 |

### 3. 关键技术点

- **独立 agent 实例**：每个子 agent 由 `agentFactory` 新建 `AgentsSdkAgent`（自带
  `wrapClientForDeepSeek` 包装 client 与串行队列）——**不能复用主实例**，否则与主 run
  争 thinking 缓存 → DeepSeek 400（本项目踩过）。
- **执行上下文隔离**：`respond({ userId: 'subagent:<taskId>', profile: 用户真实档案, ephemeral: true })`
  —— `ephemeral` 不写用户的 session/记忆；profile 用真实的，使 `wechat_*`/`lark_*` 工具
  能以该用户身份工作。
- **判断力三层**（详见 DESIGN §3/§6.5 与 `skills/task-delegation/SKILL.md`）：
  ① 四条硬判据（自包含 / 多步 / ≥30 秒 / 不依赖对话）写进工具描述与技能；
  ② 技能 `task-delegation`（ADR-0013 动态加载）装完整 SOP：判据、`goal` 模板、
     派发与汇报措辞、反例集；
  ③ **校准**：`TaskRunStore.stats()` 输出短任务派发率/失败率/平均耗时（判据过松或该派没派的
     信号），用户纠正（"这个不用派"）写进记忆 preference，阈值 env 可调。

  > ⚠️ **① ② 已被 ADR-0025 取代（2026-09-16）**：① 的"多步/≥30 秒"是对耗时的**错误代理指标**
  > （`lark_export_doc` 单次调用即 10–60 秒却漏判），已改为**操作类型清单**；② 判据**不得**放在
  > 按需加载的 skill 里（不 `use_skill` 就不在上下文），改为写进 `delegate_task` 工具描述 +
  > `PACE_RULES`，skill 降级为细节手册（goal 模板/汇报话术/反例）。③ 的校准保留。
- **收敛 ADR-0023**：保留"8 秒延迟 ack"（未委派的长任务兜底）与"失败必告知"；
  **删除 40 秒定期心跳**（DSH 纪律：不 busy-poll、不定时播报）。

### 4. 工具与可见性

`delegate_task`（派）· `list_tasks`（"我派的任务"）· `task_status {id}`（详情）·
`retry_task {id}`（失败/超时重试）。任务与用户的 `todo`（记忆系统）**职责分离**：
todo = 用户"要做什么"（长期），task_runs = agent"正在做什么/做完了没"（落库，终态 7 天归档）。

## 备选（不选的理由）

- **保持同步 + ack/心跳（ADR-0023 现状）**：等待期间主 agent 被占用、并发消息排队，体验上限低。
- **子 agent 复用主 agent 实例**：争 thinking 缓存 → 400。
- **照搬 DSH（内存 job、无队列、depth 3）**：微信需要跨会话查询与重启不丢 → 落库；成本需上限 → 队列；递归无收益 → 禁用。
- **子 agent 可继续会话（DSH `send_message`/coldResume）**：微信用户极少与后台子 agent 多轮交互，暂不做。

## 验收证据

- `npm test`：**324/324 全绿**（新增 16：TaskRunStore 7——状态机/首次结果优先/通知位只抢一次/
  重试/隔离与并发计数/校准统计/归档/id 续号；SubagentRunner 5——后台执行与完成通知/失败与超时
  也通知且仅一次/每用户并发上限排队/自包含 prompt 与结算文案；delegate-tools 5——秒级返回/
  列表与详情隔离/重试限制/未启用降级/**受限工具集**（有 send_file+notify_user，无 delegate/task））。
- 生产部署后 healthz 200。

## 遗留（诚实边界）

- **回写主会话未做**：子任务完成后只推用户 + 落库；主 agent 需用 `task_status` 查询才知道结果
  （不回写可避免污染 session，留待观察是否需要）。
- `cancel_task` 未做（超时/失败可重试，但运行中无法主动取消）。
- 子 agent 内部进度只借 `notify_user`（≤2 次），无阶段化进度回报。
- **成本**：一次委派 = 主 agent 一轮 + 子 agent 完整一轮；买的是秒回与并行，不是省钱。
