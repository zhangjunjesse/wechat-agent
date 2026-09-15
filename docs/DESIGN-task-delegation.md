# DESIGN：任务委派（子 agent 后台执行）——working proposal

- 状态：Working（待实现；实现并验证后收敛为 ADR-0024）
- 关联：ADR-0023（长任务进度反馈，本提案收敛其"定期播报"部分）、ADR-0013（技能）、
  ADR-0014（定时任务）、ADR-0022（群命令入口）
- 研究依据（仓库内，含代码坐标）：
  - `docs/research-dsh-subagent.md`（DSH 子 agent 核心：runtime/manager/三 driver/通知/并发）
  - `docs/research-dsh-jobs.md`（DSH job 系统与通知回流的确切机制）
  - `docs/research-dsh-delegation-rules.md`（委派判据原文、todo 语义、技能格式、防呆）
- 日期：2026-09-15

## 问题（与实现无关）

用户指派一个需要多步工具调用、耗时 1-3 分钟的任务（导出飞书文档、调研、批量处理）时，
**主 agent 的 `respond()` 是同步的**：它要跑完整个 agent loop（所有工具调用）才返回，
再由 router 推送。期间用户零反馈；叠加"agent run 串行化"（保护 deepseek thinking 缓存），
并发消息还会排队，等待进一步拉长。ADR-0023 的 ack + 40 秒心跳只是让等待**可感知**，
没有改变"主 agent 被长任务占用"的本质——这正是用户指出的"投机取巧"。

本质需求：**主 agent 只做决策、秒级回复；长任务交给后台子 agent 执行；完成后主动通知。**

## 提案

### 1. 架构（借鉴 DSH 的分层，按微信场景简化）

```
微信/群消息 → Router → 主 agent（只决策，秒回）
                          ├─ 短任务 → 直接回答
                          └─ 长任务 → delegate_task{goal, context?}
                                       ├─ TaskRunStore 落库（task-N, running）
                                       ├─ 工具立即返回 → 主 agent 秒回：
                                       │    「✅ 已派发任务 #3（导出飞书文档），完成后发你」
                                       └─ SubagentRunner 后台执行（独立 agent 实例）
                                            ├─ 成功 → 结果推送用户 + 状态 done + 回写主会话
                                            ├─ 失败/超时 → 通知用户 + 状态 failed/timeout
                                            └─ 结算即无条件通知（无论结局）
用户等待期间可继续发消息（主 agent 随时可答「#3 还在跑」）
```

与 DSH 的对应与**有意偏离**：

| DSH 机制 | 本项目做法 | 理由 |
|---|---|---|
| `spawn`（零父历史，seed={}） vs `fork`（seed=父已完成轮次前缀） | P0 只做 **spawn + 可选 context 摘要**；P2 再评估 fork | 微信任务通常自包含；带整段对话历史费 token |
| `JobSnapshot` **纯内存 Map**（进程死即丢） | **落库 `TaskRunStore`（SQLite）** | 微信场景：用户跨会话问"任务怎么样了"、服务重启不能丢、需要审计；这是**有意偏离** |
| `followup`（唤醒当轮）/ `inject`（下一步注入） | **直接推微信**（用户即"通知接收方"）+ 主会话注入一条完成记录 | 微信没有"唤醒 agent"概念；用户要的是消息 |
| 通知内容只给 id 与取用指令（`job_output`），**不含输出本体** | 通知带**结果摘要**（≤200 字）+ 文件直接发 | 用户不方便"再调工具读输出" |
| `maxConcurrentJobsPerOwner=10`、无队列 | **每用户并发 2 + 队列排队** | 控制成本（每个子 agent 是完整 LLM run） |
| `maxDepth=3`（子可再委派） | **depth=1（子 agent 不再委派）** | 防递归与成本爆炸；微信场景不需要 |
| 工具限制**不继承**（子级自己的表） | 子 agent 用**受限工具集**：业务工具全给（lark/wechat/gzh/image/poster/文件/技能），**不给** delegate/task 工具，**给** `send_file`/`notify_user` | 防递归委派；子级要能自己交付文件与进度 |
| 结算通知在**所有权释放前**、**无条件**投递 | 同样：先落终态 → 再通知 → 再释放并发位 | 研究①第 9 条：最需要说明结局的正是"子级没机会开口"的情形 |
| 首次结果优先（晚到者丢弃） | 同样：终态不可变（`done` 之后不再改写） | 防重复/乱序覆盖 |
| `repeat-tool-reminder` 防呆 | P2 借用（子 agent 打转提醒） | 降低"子 agent 空转烧钱" |

### 2. 数据模型 `TaskRunStore`（SQLite `data/task-runs.db`）

```
task_runs(
  id           TEXT PRIMARY KEY,      -- task-<seq>（每用户独立递增或全局）
  user_id      TEXT NOT NULL,         -- 归属用户（隔离）
  origin       TEXT NOT NULL,         -- 'chat' | 'group:<chatWxid>'（来源，供审计/回复）
  goal         TEXT NOT NULL,         -- 自包含任务描述（agent 写）
  context      TEXT DEFAULT '',       -- 主 agent 附带的上下文摘要（可选）
  status       TEXT NOT NULL,         -- pending|running|done|failed|timeout|cancelled
  result       TEXT DEFAULT '',       -- 结果摘要/最终文本
  result_files TEXT DEFAULT '[]',     -- 产出的文件相对路径列表
  error        TEXT DEFAULT '',
  notified     INTEGER DEFAULT 0,     -- 结算通知是否已投递（防重复通知）
  attempts     INTEGER DEFAULT 1,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER DEFAULT 0,
  finished_at  INTEGER DEFAULT 0
)
```

状态机（首次结果优先，终态不可变）：`pending → running → done | failed | timeout | cancelled`。
`notified` 位照搬 DSH 的 `JobSnapshot.reported`（通知抑制，避免重复推送）。

### 3. 委派判据（三条硬判据 + 负面清单；DSH 原文级依据见研究报告）

**该委派**（全部满足）：
1. **自包含**——不需要与用户来回澄清，一次说清就能做完（DSH: "Give it a complete, standalone prompt: it does not see this conversation"）；
2. **多步/耗时**——预计 ≥3 次工具调用，或需等待外部 API（导出/下载/抓多篇正文/生成图片），量级 ≥30 秒；
3. **不依赖当前对话上下文**——若依赖，则由主 agent 写进 `context` 摘要后仍可委派。

**不该委派**：简单问答与单次查询（直接答）；需要与用户澄清或多轮交互的（先问清）；
用户明确"现在就给我"且任务本身很快的；涉及隐私/敏感操作需要用户逐步确认的。

### 4. 工具集

| 工具 | 谁用 | 作用 |
|---|---|---|
| `delegate_task { goal, context? }` | 主 agent | 派发后台任务，**立即返回**「已派发 #N」 |
| `list_tasks` | 主 agent（用户问"我派的任务"） | 列出该用户最近任务与状态 |
| `task_status { id }` | 主 agent | 单任务详情（状态/结果/耗时/错误）——**不 busy-poll**：仅在用户问时调用 |
| `retry_task { id }` / `cancel_task { id }` | 主 agent | P1：重试失败任务 / 取消排队或运行中任务 |

### 5. 技能 `skills/task-delegation/SKILL.md`（ADR-0013 动态加载）

装完整 SOP（按 DSH 技能格式：`name`+`description` 必填、fail-closed）：
- 判据清单与反例（何时不该派）；
- **goal 写法模板**：背景/目标/输出格式（要什么形式的交付）/成功标准/边界（不许做什么）；
- 派发措辞模板：「✅ 已派发任务 #N（<一句话>），完成后我发你」——**不许承诺具体结果**；
- 完成/失败汇报模板：结果摘要 + 文件 + 「回复『重试 #N』可再试」；
- 与用户交互纪律：派发后继续正常对话、不 busy-poll、不替子任务编造结果。

### 6. 提示词规则（`conversation-pace.mjs` PACE_RULES 扩展）

新增第 5 条（长任务委派）：判据摘要 + 后台优先 + 派发后立即回复 + 完成时汇报；
原第 4 条（长任务节奏）收敛：**去掉"定期心跳"暗示**，改为"派发确认 + 完成通知；若模型没有委派、
自己执行长任务，则用 `notify_user` 在开工时说明一次"。

## 6.5 判断力的校准机制（Layer 3：让"准确"可收敛——DSH 无对应机制，本项目自设计）

原则层（判据）只能保证"有依据"，**准确性靠反馈校准**：

1. **任务表派生指标**（直接由 `TaskRunStore` 统计，脚本化）：
   - **短任务派发率** = 完成耗时 <30s 的任务占比 → 偏高说明**判据过松**（该收紧阈值）；
   - **未派长任务** = 主 agent 自身 run >60s 的轮次占比 → 偏高说明**该派没派**（判据需更主动）；
   - **失败/重试率** → 偏高说明 `goal` 写法有问题（回到技能模板修正）。
2. **用户纠正入口**：用户说「这个不用派，直接做」「这种以后都派出去」→ agent 写入**记忆
   preference 类**（现有记忆系统已有该类别）→ 后续判断带上该用户偏好（**个性化校准**，
   比全局阈值更准）。
3. **参数化**：`DELEGATE_MIN_SECONDS`（默认 30）、每用户并发（默认 2）、任务超时（默认 300s）
   全部 env 可覆盖，按统计结果调整，不改代码。

## 6.6 任务管理机制分工（别和现有 todo 混）

| | 归属 | 语义 | 持久性 |
|---|---|---|---|
| `todo`（记忆系统 v2） | 用户 | **要做什么**（"周五交报告"） | 长期（active 卡） |
| `task_runs`（本提案新增） | agent | **正在做什么 / 做完了没**（"导出文档 #3"） | 落库 SQLite；终态 7 天后归档 |

工具：`delegate_task`（派）· `list_tasks`（"我派的任务"）· `task_status {id}`（详情）·
`retry_task {id}` / `cancel_task {id}`（P1）。用户可见性：结算主动推 + 随时可问/可重试/可取消，
通知带 task id 便于引用。

**主动性三落点**：① 派发即确认（秒级，主 agent 回复"已派发 #N"）；② 结算即通知（不等用户问）；
③ "长任务在后台跑"这件事本身主动告知（消除"是不是挂了"）。

### 7. 与 ADR-0023（progress-notifier）的关系——**收敛而非废弃**

| ADR-0023 机制 | 收敛后 |
|---|---|
| 8 秒延迟 ack | 保留（**兜底**：模型没委派、自己闷头跑长任务时仍给反馈） |
| 40 秒定期心跳 | **删除定期播报**（DSH 纪律：不 busy-poll、不定时播报）；仅保留"超过 5 分钟仍未结束"补一条 |
| 失败必告知 | 保留（主 agent 失败 + 子任务失败都要告知） |

### 8. 体验流（微信，端到端）

```
用户（群引用 @助手 / 私聊）：「把这个飞书文档导出成 PDF 发我」
主 agent（秒级）：delegate_task → task-3 → 回复「✅ 已派发任务 #3（导出飞书文档为 PDF），完成后发你」
用户可继续说别的 → 主 agent 立即响应
子 agent（后台，独立实例）：lark 导出 → 下载 → send_file 交付
结算：TaskRunStore 置 done → 推送「☑️ 任务 #3 完成：已发送《季度总结.pdf》」+ 主会话注入记录
失败：「⚠️ 任务 #3 失败：导出权限不足；回复『重试 #3』或先在飞书后台加权限」
超时：「⏱ 任务 #3 超过 5 分钟未完成，已停止；回复『重试 #3』可以再试」
```

## 备选方案（不选的理由）

- **保持同步 + ack/心跳（现状 ADR-0023）**：用户等待期间主 agent 被占用、并发消息排队，
  体验上限低（用户已明确指出这是投机取巧）。
- **子 agent 直接复用主 agent 实例**：会与主 run 争 thinking 缓存与串行锁 → 又 400；
  必须独立实例（各自 client + 各自队列）。
- **子 agent 可继续会话（DSH `send_message`/coldResume）**：微信场景用户极少需要与后台
  子 agent 多轮交互，P2 再评估；P0 只做一次性委派。
- **完全照搬 DSH（内存 job、无队列、depth 3）**：微信需要跨会话查询与重启不丢 → 落库；
  成本需要上限 → 队列；递归无收益 → depth 1。

## 验收标准（可观察）

| # | 验收 | 直接证据 |
|---|---|---|
| A1 | 派发后**主 agent 秒级回复**（不含子任务耗时） | `tests/delegate-tools.test.mjs`：mock runner 慢 3s，工具返回耗时为 ms 级且含 task id |
| A2 | 子任务在后台独立执行，**不阻塞**主 agent 后续消息 | 集成测试：派发后立刻再发一条消息 → 主 agent 立即响应（不等子任务） |
| A3 | 完成/失败/超时**都**通知用户一次，且不重复 | `tests/subagent-runner.test.mjs`：三态各推一条；`notified` 位防重 |
| A4 | 任务落库可查（跨重启） | `tests/task-run-store.test.mjs`：写→关闭→重开→读到终态与结果 |
| A5 | 用户可查「我派的任务」 | `tests/delegate-tools.test.mjs`：`list_tasks` 返回状态列表 |
| A6 | 子 agent 工具集受限（无 delegate/task，有 send_file/notify_user） | 组装测试断言工具名集合 |
| A7 | 同用户并发上限生效，超出排队不丢 | runner 测试：3 个任务 + 并发上限 2 → 第三个 pending 后执行 |
| A8 | 原 ADR-0023 兜底仍在（未委派的长任务有 ack、失败必告知） | 既有 `tests/message-router.test.mjs` 通过 |
| A9 | 全量回归 | `npm test` |

## 风险与未决

- **成本**：一次委派 = 主 agent 一轮 + 子 agent 完整一轮（LLM 调用 +1）。买的是**秒回与并行**，
  不是省钱；用并发上限与队列兜住峰值。
- **模型误判**：可能把简单任务也派了（浪费）或该派不派（退化为慢）。缓解：判据写进 prompt
  与技能 + `list_tasks` 让用户可纠正；后续可从任务表统计"派发中短任务占比"调参。
- **上下文割裂**：子 agent 看不到主对话 → 靠 `context` 摘要；若关键细节缺失，子任务会问
  （子 agent 无 ask_user 能力 → 应设计为"信息不足则明确报告缺什么"，而非瞎猜）。
- **通知与用户消息交错**：微信是消息流，可接受；但同一时刻推送多条时注意合并（P2）。
- **主 agent 承诺与现实偏差**：规则禁止编造结果，只允许"已派发"；结果一律由子任务结算通知给出。
