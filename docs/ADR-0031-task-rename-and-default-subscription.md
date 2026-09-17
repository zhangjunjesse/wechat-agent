# ADR-0031: 公共任务改名迁移 + 注册核验即默认订阅

- 状态：Accepted（2026-09-17 追加变更，见下方「变更记录」：默认订阅范围扩到
  「微信日报」「微信周报」，产品直接指示）
- 类型：Bug fix（改名丢订阅者）/ Product（默认订阅）
- 日期：2026-09-16（初次），2026-09-17（默认订阅范围变更 + 存量回填脚本）
- 关联：ADR-0004（稳定租户键 = providerUserId——本记录的订阅键结论直接依赖它）、
  ADR-0014（定时任务与公共任务模型）、ADR-0017 / DESIGN-daily-report（日报管道）、
  ADR-0019（主题订阅，`report_topics` 按 `task_name` 关联）、
  ADR-0020（引导埋点，`guide_events` 按 `task_name` 关联）、
  ADR-0028（调度器独立队列 + 单元级重试——本次变更的成本/延迟评估直接依赖它）、
  DESIGN-wechat-digest.md（同批引入的 `kind='wechat-digest'`；本次变更后该文档
  的"不默认订阅"描述已同步更新）
- 触发：初次——把公共任务「每日早报」改名为「每日资讯」；
  2026-09-17——产品直接指示「所有人默认订阅微信日报和微信周报」。

## 问题

### 1. 改名 = 悄悄丢掉全部订阅者（正确性 bug）

`TaskStore.loadGlobalTasks` 的 upsert 键是 `tasks.id = 'global-<name>'`
（`task-store.mjs`）。**名字是主键的一部分**，所以改一个字就是插入一条全新任务：

- 新任务 `global-每日资讯`：`subscribers = '[]'`——一个订阅者都没有；
- 老任务 `global-每日早报`：不在配置里了，但也**没人删它**，带着全部订阅者
  留在库里，继续被 `getAllEnabled()` 扫到、继续每天 08:00 推送。

用户侧的观感是：所有老用户收到的还是旧名字的那份，新名字的任务空转；而管理员
以为自己只是改了个显示名。`report_topics`（ADR-0019）和 `guide_events`（ADR-0020）
按 `task_name` 关联，也会一起跟丢——用户设过的主题在新任务下等于没设过。

这不是"改名这个操作没做好"，是**任务模型本身没有"改名"这个概念**：配置是
声明式的，声明里没有办法表达"这条就是原来那条"。

### 2. 新用户核验完拿到一个空空如也的助手（产品）

注册核验成功（`POST /api/profile-verifications` → verified）后只写 ProfileStore，
用户回到微信面对的是一个什么都不会主动做的 Bot。要收到日报，得先知道"有公共
任务这回事"、再说出"订阅每日资讯"。实际上绝大多数人不会——他们只会觉得这东西
没什么用。`VerificationService` 早就留了 `onVerified` 钩子，但 `app.mjs` 构造时
从来没传过，**恒为 null**。

## 决策

### 1. 配置支持 `renamedFrom`，加载时做一次幂等改名迁移

`deploy/global-tasks.json` 的条目可带可选的 `"renamedFrom": "<旧名>"`。
`loadGlobalTasks` 在 upsert **之前**调用新增的 `TaskStore.renameGlobalTask(old, new)`。

迁移搬什么，按"**这是用户的，不是配置的**"划线：

| 搬 | 为什么 |
|---|---|
| `subscribers` | 就是这个 bug 的全部 |
| `created_at` | 取更早的——新任务不该假装自己是今天才存在的（`#tick` 用它当首次调度锚点） |
| `last_run_at` | 取更晚的——调度锚点，否则改名当天会重复触发一轮 |
| `report_topics.task_name` | ADR-0019，用户设过的主题 |
| `guide_events.task_name` | ADR-0020，埋点历史 |

`schedule`/`instruction`/`kind`/`cover`/`enabled` **不搬**：紧接着的 upsert 会用
配置里的新值覆盖，搬它们只会制造"到底以谁为准"的歧义。

两条路径：

- 新 id 还不存在（正常情况，迁移在 upsert 之前）→ 一条
  `UPDATE tasks SET id=?, name=? WHERE id=?`，整行状态（含 `retry_units`）
  原样跟着走，**没有"漏搬某一列"的余地**；
- 新旧并存（人工建过同名任务、或调用顺序被改）→ 合并用户侧状态到新行后删旧行。
  `subscribers` 取并集去重；`report_topics` 主键是 `(user_id, task_name)`，
  撞键时用 `UPDATE OR IGNORE` 让"新名下已有的设置"胜出，剩余旧行删除不留孤儿。

**幂等**：旧行不存在（没部署过旧名，或已经迁移过）直接返回 `false`。可以每次
启动都调——这正是它的使用方式（`loadGlobalTasks` 在 `server.mjs` 启动路径上）。

顺带把 `loadGlobalTasks` 里 `r.kind === 'report' ? 'report' : 'plain'` 的写法
换成白名单 `GLOBAL_TASK_KINDS`（`plain`/`report`/`wechat-digest`）：原写法在
新增 kind 时会把 `'wechat-digest'` 静默降级成 `'plain'`，是那种"配置写对了、
行为不对、日志里什么都没有"的故障。

### 2. `onVerified` 接上，核验通过即默认订阅「每日资讯」

`createApp` 新增可选 `taskStore` + `defaultSubscriptions`（默认 `['每日资讯']`），
构造 `VerificationService` 时传入 `buildOnVerified(...)`（单独导出，可脱离 HTTP 层测）。

**订阅键必须是 iLink `providerUserId`——这是唯一容易做错的地方。** 证据链：

1. `message-router.mjs`：`tenantKey = normalized.providerUserId || binding.profile?.providerUserId || binding.userId`，
   然后 `agent.respond({ userId: tenantKey, … })`；
2. `agents-sdk-agent.mjs`：`run(..., { context: { userId, profile, … } })`
   → 工具里的 `ctx.context.userId`；
3. `task-tools.mjs` 的 `subscribe_task`：`taskStore.subscribe(input.name, ctx.context.userId)`
   → **`tasks.subscribers` 里存的就是 providerUserId**；
4. `context-token-cache` 由 `message-router` 用 `normalized.providerUserId` 写入
   （`ContextTokenCache` 的注释也明说"按 iLink 用户 id（toProviderUserId）索引"）
   → `task-scheduler` 的 `contextTokens.get(ilinkId)` 同一命名空间；
5. 网页 `/api/chat` 走 `profileStore.stableKey(browserId)`，同样解析到 providerUserId
   （ADR-0004 的既定结论："统一稳定租户键 = `providerUserId`"）。

而 **ProfileStore 的记录键是网页那次性的 browser id**（`x-user-id`，
`ui-page.mjs` 里 `'u_'+crypto.randomUUID().slice(0,12)`），iLink id 只作为记录里的
`ilinkUserId` **字段**存在；`task-scheduler` 的 `profileStore.get(providerUserId)`
能查到，是靠 `ProfileStore` 内部 `#byIlink` 反查索引兜的（ADR-0004 的设计）。
两者是**不同命名空间**。

所以 `onVerified` 拿到的 `userId` 是 browser id，**必须过一道 `stableKey()`**
（ADR-0004 定义的规范解析：`profile.ilinkUserId || userId`）。调用时机也有讲究：
`VerificationService` 先 `store.put(userId, profile)` 再调钩子，此刻 `#byIlink`
索引已建好，`stableKey` 才解析得出来。

其余约束：

- **重复核验不重复订阅**：先 `isSubscribed` 再 `subscribe`（`subscribe` 本身已
  幂等，这道检查是为了不重复发欢迎语）。
- **欢迎语 best-effort**：核验走网页，那一刻通常**没有** iLink 会话。只有该用户
  此前给 Bot 发过消息、`ContextTokenCache` 里有 token 时才发得出去；发不出去
  就只订阅、不发消息（不报错、不重试）。
- **失败一律吞掉并上报 `onError`**：默认订阅是锦上添花，绝不能让它把"核验成功"
  这件事本身搞挂——`check()` 的返回值是用户在网页上唯一的反馈。任务名对不上
  （`subscribe` 抛「公共任务「X」不存在」）也只是记一条日志。

### 3. 「每日早报」→「每日资讯」

`deploy/global-tasks.json` 改名 + `renamedFrom`；`schedule`/`instruction`/`kind`/
`cover` 一字不动。代码里的用户可见措辞（`task-tools.mjs` 的工具描述）同步更新。
**历史 ADR（0014/0017/0019/0026/0027/0028）不改**——它们记录的是当时的事实；
在 DESIGN-daily-report.md 与 DESIGN-timed-tasks.md 加改名注记即可。

## 变更记录：2026-09-17，默认订阅扩到「微信日报」「微信周报」

产品直接指示：「所有人默认订阅微信日报和微信周报」。这是对本记录"决策 2"的
需求变更（不是新问题），所以直接在本记录上追加，不开平行 ADR——订阅键、
`onVerified` 钩子、"重复核验不重复订阅"等约束原样成立，变的只是默认订阅的
任务清单从 1 条变成 3 条，以及多了"存量用户"这个此前没有的场景（当时
`DEFAULT_SUBSCRIPTIONS = ['每日资讯']` 上线时，"每日资讯"本身的存量订阅是靠
同一次提交里的改名迁移搬过去的，不需要单独的回填脚本；这次微信日报/周报是
全新任务，存量用户从未订阅过，没有"迁移"这条路可走，必须有一个显式的回填
步骤）。

### 变更前 → 变更后

| | 变更前 | 变更后 |
|---|---|---|
| `DEFAULT_SUBSCRIPTIONS` | `['每日资讯']` | `['每日资讯', '微信日报', '微信周报']` |
| 新用户（核验通过那一刻） | 只订「每日资讯」 | 三条全订 |
| 存量已核验用户 | 不受影响（`onVerified` 只在核验那一刻触发一次，不会补跑） | 需要一次性回填才能拿到「微信日报」「微信周报」（`scripts/backfill-default-subscriptions.mjs`） |

### 为什么回填绝不能挂到服务启动流程（本次变更最重要的约束）

`onVerified` 已经证明了"默认订阅"必须是"在某个一次性时刻施加一次"的语义——
它只在 `VerificationService.check()` 判定为 `verified` 的那一次调用，不会在
用户每次跟 Bot 说话、或服务每次重启时重新触发。存量用户没有这样一个天然的
"那一刻"，容易让人想出一个看似等价的替代方案："服务启动时扫一遍所有已核验
用户，确保他们都订阅了默认任务"。**这个方案错，而且错得很隐蔽**：

- 它在功能上等价于"每次启动都重新施加默认订阅"；
- 用户退订之后，`tasks.subscribers` 里就没有他了；下一次服务重启（部署、
  崩溃重启、`pm2`/systemd 的常规重启，生产上这不是罕见事件）时，这条"确保
  已核验用户都订阅"的逻辑会把他**重新**加回去；
- 从用户的角度看：退订功能在下一次重启前"有效"，重启后又"复活"了——这不是
  一个边界 bug，是**退订这个功能本身对存量默认订阅永久失效**，因为任何时刻
  的"未订阅"状态都会被下一次启动抹平，无法区分"从没订阅过"和"退订了"。

所以决策是：回填只能是一个**显式触发一次**的脚本（`scripts/backfill-default-subscriptions.mjs`，
形状仿 `scripts/backfill-wechat-wxid.mjs`），默认 dry-run，`--apply` 才写，且
**不出现在 `server.mjs` 的任何启动路径上**。跑完之后，`tasks.subscribers`
就是唯一权威状态，用户自己的订阅/退订永远优先，系统不会再主动"纠正"它。

### 回填脚本自己的幂等问题：`tasks.db` 没有退订的 tombstone

这条值得单独说清楚，因为它比"别挂到启动流程"更容易在**脚本自身**被做错。
`TaskStore.unsubscribe` 只是把 userId 从 `subscribers` 数组里过滤掉，不留任何
"曾经订阅过、后来退订了"的历史记录。如果回填脚本的判定完全依赖
`taskStore.isSubscribed()`（"不在订阅列表里 = 该回填"），那么：

1. 第一次 `--apply`：用户被订阅上「微信日报」；
2. 用户自己退订；
3. 出于别的原因（比如要给新一批核验用户回填）再跑一次脚本：`isSubscribed` 返回
   `false`（订阅列表里确实没有他），脚本会把他**当成"从没回填过"重新订阅**——
   退订等于白退，和"挂到启动流程"是同一个 bug 的另一种写法，只是触发方式从
   "自动重启"变成了"手工重跑"。

`scripts/backfill-default-subscriptions.mjs` 用一个旁路账本
（`BACKFILL_LOG_FILE`，默认 `data/default-subscriptions-backfill-log.json`）
记录"这个人这个任务已经被本脚本处理过"，只在 `--apply` 时写入，且一旦记录就
永久跳过——不再看 `subscribers` 当前状态。见脚本文件头注释与
`tests/backfill-default-subscriptions.test.mjs` 的
`CRITICAL: a user already backfilled who then unsubscribed is NOT re-subscribed on a re-run`。

### 默认回填范围不含「每日资讯」

`scripts/backfill-default-subscriptions.mjs` 的默认任务清单
（`DEFAULT_BACKFILL_TASKS`）是 `DEFAULT_SUBSCRIPTIONS` 去掉「每日资讯」，即
`['微信日报', '微信周报']`。理由：「每日资讯」的存量订阅已经由本记录最初那次
的改名迁移（`TaskStore.renameGlobalTask`）处理过——老任务「每日早报」的全部
订阅者已经原样搬到新任务上，之后任何人对「每日资讯」的退订都是在这次迁移
**之后**发生的真实决定。如果回填脚本默认还把「每日资讯」纳入范围，会把这些
人重新拉回订阅列表，直接违反"退订永远优先"。真要为「每日资讯」补回填（比如
发现迁移当时漏了什么人），操作者用 `--tasks 每日资讯` 显式指定——这样做的人
清楚自己在覆盖一条已有的历史状态，而不是被默认值悄悄带偏。

### 成本与延迟：默认订阅把 per-user 生成成本从"看谁主动订阅"变成"随全体用户数线性增长"

微信日报/周报是 per-user 生成（DESIGN-wechat-digest.md §3：每个订阅者一轮
map-reduce，map 按可见群数展开），且调度器对 `kind='wechat-digest'` 任务是
**逐订阅者严格串行**执行（`task-scheduler.mjs` `#runDigestTask`：`for (const unit of toAttempt)`
一个个 `await`；LLM 调用统一走 ADR-0028 的调度器专属 `AgentsSdkAgent` 实例，
本来就只有一条串行队列，这里没有额外并发）。在只有"用户主动订阅"的旧语义下，
这个成本只随"真的想看的人数"增长；默认订阅把它变成随**全体已核验用户数**
线性增长——这是本次变更引入的、此前不存在的规模风险，必须如实评估。

**真实量级**（生产实测，单用户"Z.俊"，2026-09-16）：

| 任务 | 可见群 | 活跃群（有消息） | 生成耗时 |
|---|---|---|---|
| 微信日报（1 天窗口） | 17 | 6 | 143s |
| 微信周报（7 天窗口） | 17 | 6（含 7 天内活跃） | 506s |

`#runDigestTask` 逐订阅者严格串行，因此 N 个订阅者的总耗时 ≈ N × 单用户耗时
（假设每人群数量级相近；实际会因人而异，群多的人更慢）。据此推算 21:30 那个
窗口的持续时间：

| 订阅者数 N | 微信日报窗口（daily@21:30） | 微信周报窗口（weekly@7@20:00，仅周日） |
|---|---|---|
| 5 | ≈ 12 分钟 | ≈ 42 分钟 |
| 20 | ≈ 48 分钟 | ≈ 169 分钟（2.8 小时） |
| 50 | ≈ 119 分钟（2 小时） | ≈ 422 分钟（7 小时） |

**风险判断**：

- **周日的双重叠加**：微信周报锚定 `weekly@7@20:00`（周日 20:00），微信日报
  锚定 `daily@21:30`。`#tick()` 单线程、不可重入（`this.#running` 门控），
  两个任务在同一个 `getAllEnabled()` 循环里按到期顺序逐个执行——如果周报在
  20:00 触发后，订阅者数量或群规模较大导致生成还没跑完就到了 21:30，日报会
  在周报**结算之后**才轮到（同一个 `#tick` 调用里靠后的任务要等前面的任务跑完
  才会被检查；就算等到下一次 `setInterval` 触发的新 `#tick`，`#running` 门控
  也保证同一时刻只有一个 `#tick` 在跑）。N 稍大时，周日晚上的日报**推迟**
  相当现实（上表 N=20 时周报窗口已经 ≈ 2.8 小时，会直接吃掉日报的锚点窗口）。
- **与 08:00 每日资讯抢调度器队列**：时间上不重叠（08:00 vs 20:00/21:30），
  当前看没有直接冲突；但如果将来任何一条任务的锚点调整到互相靠近，同一条
  `#tick` 循环 + 同一条调度器专属串行队列（ADR-0028）会让它们互相排队等待，
  这是本次变更放大的同一类风险，不是新引入的机制问题。
- **个人定时任务被拖慢**：ADR-0028 的遗留风险原文已经指出"晚触发的个人定时
  任务仍会排在日报批次后面"——默认订阅让这个批次从"1 个订阅者"变成"全体
  用户"，这条遗留风险的实际影响随之放大。

**本次不实现的缓解方向（留作独立提案）**：按订阅者分片错峰触发、给
wechat-digest 任务单独的并发度（当前刻意串行是为了复用同一条 LLM 队列，
真要并发需要评估 DeepSeek thinking 缓存的并发安全性，见 `serial-queue.mjs`
注释里的历史事故）、周报窗口与日报窗口之间加最小间隔保护。这些都是需要单独
权衡"生成质量 vs 并发复杂度 vs 用户等待时长"的架构决策，本次变更的范围只是
"接入默认订阅"本身，不顺手做限流/错峰。**生产上线前应先看一次真实的存量
用户规模 N，再判断上述哪一档量级适用、是否需要在做错峰之前先暂缓这次全量
默认订阅**——这是本记录唯一没有替产品做的判断，如实留给上线前评估。

### 测试补充

`tests/backfill-default-subscriptions.test.mjs`：`DEFAULT_BACKFILL_TASKS` 不含
「每日资讯」、已核验判定（`verifiedAt` + `ilinkUserId` 都在）、未核验/无
`ilinkUserId`（`test-user`/`repro`/`repro2` 这类合成档案）被排除并给出理由、
同一 `ilinkUserId` 去重为一个订阅者、dry-run 不写、`--apply` 真的写、已订阅
幂等跳过、以及最关键的一条——已回填又退订的用户重跑脚本不会被拉回来。
`tests/app.test.mjs` 的 ADR-0031 默认订阅套件同步扩展：`subSetup` 现在预置
全部三条公共任务，断言新用户核验通过后三条全订上、欢迎语列出三个任务名。

### 追加操作：2026-09-17 对「每日资讯」的一次显式回填

决策者在上线后要求"存量用户也都要有「每日资讯」"，于是在生产上显式执行了
`--tasks 每日资讯 --apply`。这**是对上文"默认回填不含「每日资讯」"这条理由的
一次有意覆盖**，不是默认值改变——`DEFAULT_BACKFILL_TASKS` 保持不含「每日资讯」，
脚本默认行为未变。

覆盖成立的依据：LYan_w（`o9cq80yoCe…`）和老管（`o9cq800NNL…`）都是在默认订阅
功能上线**之前**注册的，属于"从没机会拿到默认值"，而不是"拿到后主动退订"；
`tasks.db` 里没有退订 tombstone，区分不了这两种情况，因此由决策者本人拍板承担
这一处歧义。Z.俊 已订阅，脚本幂等跳过。dry-run 与 `--apply` 输出一致：新增 2 项。

此后这两个 `(人, 每日资讯)` 组合已进入回填账本，**再次重跑脚本不会把他们
重新订阅回来**——若他们之后主动退订，退订依然是最终状态。

生产实测（2026-09-17）：三条公共任务的 `subscribers` 均为同样三个 `ilinkUserId`。
`TaskStore` 无内存缓存（唯一实例字段是 `#db`，读写全部直查 sqlite），因此这次
容器外写入无需重启服务即在下一次 `sweep()` 生效。

## 备选（不选的理由）

- **不改名，只加个 `displayName` 字段**：主键仍是 `name`，等于把问题推给下一次；
  而且从此每处展示都要想"用哪个名字"。
- **改名时手工 SQL 迁移一次**：一次性脚本不在启动路径上，下一次改名照错不误；
  且线上库和开发库要各跑一遍，漏一个就是静默数据分裂。`renamedFrom` 声明在配置
  里，和"这个任务叫什么"放在同一个地方，改名的人不可能看不见。
- **用稳定 id（如 `global-daily-news`）+ 可变 name 重构任务模型**：更干净，但要
  迁移线上全部 `tasks`/`report_topics`/`guide_events`/`reports.task_id` 的关联，
  影响面远超"改一个名字"这件事本身。`renamedFrom` 是低风险增量；模型重构留给
  真正需要它的时候。
- **默认订阅在 `subscribe_task` 工具侧做（让 agent 自己去订）**：依赖模型在正确
  时机自觉调用，不可靠；且核验发生在**网页**，那一刻根本没有 agent 会话。
- **默认订阅用 browser id 作键**：会写进 `subscribers` 一个调度器
  `contextTokens.get()` 永远查不到的键——用户永远收不到推送，且日志里只有一条
  `skipped: 'no_context_token'`，极难定位。这正是本记录花最大篇幅论证键体系的原因。
- **迁移时一并把 `reports.db` 里 `task_id='global-每日早报'` 的历史报告改名**：
  见下方"遗留"——收益（7 天去重窗口）小于风险（改 `task_id` 会让已发出去的
  `/reports/<id>` 链接指向的行与任务对不上）。

## 验收证据

- `tests/task-store.test.mjs` 新增：改名迁移（订阅者保留、旧 id 消失、
  `created_at`/`last_run_at` 语义、`report_topics`/`guide_events` 跟随）、
  **重复执行幂等**、新旧并存时的合并、`renamedFrom` 指向不存在的旧任务时 no-op、
  `kind` 白名单（`wechat-digest` 不被降级成 `plain`、未知 kind 被降级）。
- `tests/app.test.mjs` 新增：`buildOnVerified` 用 **stableKey** 订阅（断言写进
  `subscribers` 的是 `ilinkUserId` 而不是 browser id）、重复核验不重复订阅、
  有 contextToken 时发欢迎语 / 无 token 时只订阅不发、任务不存在时不抛错。
- **未运行**：见下。

## 未验证边界（诚实声明）

- **`node --test tests/` 未执行**：实施会话的环境拒绝执行 `node --test`
  （`This command requires approval`，非交互会话无法授权），与代码无关。
  上述测试为**静态编写、未运行**，其通过与否没有证据。
- **线上 `data/tasks.db` 的真实迁移未验证**：本仓库 checkout 里的
  `data/tasks.db` 是 0 字节、`data/profiles.json` 不存在，没有可迁移的真实数据。
- **`reports.db` 的历史报告不迁移**（有意）：老 `task_id` 的报告行原样留着，
  `/reports/<老 id>` 链接不失效；代价是改名后近 7 天的去重窗口从零开始，
  可能重复报道一次旧闻，7 天后自愈。
- **`ilinkUserId` 可能被写成 bot id**：`ui-page.mjs` 发的是
  `b.profile?.providerUserId || b.providerBotId`——`binding.profile` 为 null 时
  （`data/bindings.json` 里确有这种记录）会把 `…@im.bot` 当成 `ilinkUserId` 存进
  档案。那种档案的 `stableKey` 会返回 bot id，默认订阅就会写进一个永远收不到
  推送的键。**本记录不修这个上游缺陷**，但它是已知的、会让默认订阅静默失效的
  前置条件，记在这里以便后续处理。

### 2026-09-17 变更新增的未验证边界

- **`scripts/backfill-default-subscriptions.mjs` 未针对生产 `data/profiles.json`
  / `data/tasks.db` 实跑过**：本仓库 checkout 没有生产数据，脚本的正确性由
  `tests/backfill-default-subscriptions.test.mjs` 的合成 fixture 验证（含
  "去重到一个订阅者""退订不被拉回"等关键场景），但生产 profiles.json 里
  `ilinkUserId` 字段的实际脏数据分布（例如上一条提到的 bot id 误写、或其他
  未预见的形状）没有过一遍真实数据核实。**上线前建议先 dry-run 一次，人工看
  一遍排除列表和去重结果是否符合预期，再 `--apply`。**
  （生产回填的执行由使用者自行操作，不在本次实施范围内。）
- **21:30 窗口的真实持续时间未压测**：本记录给出的量级估算（12 分钟～2 小时+）
  是基于单用户实测耗时（143s/506s）做的线性外推，没有跑过多订阅者并发场景
  的真实计时——实际耗时可能因用户群规模差异、LLM 服务当时的延迟波动而偏离
  这个估算。真实存量用户规模 N 未知，因此表格只能给出几档参考值，不是对
  生产表现的承诺。
- **是否需要在默认订阅上线前先做错峰/限流，本记录没有替产品做决定**——见上方
  "本次不实现的缓解方向"，如实留作独立提案，需要在看到真实 N 之后再判断。
