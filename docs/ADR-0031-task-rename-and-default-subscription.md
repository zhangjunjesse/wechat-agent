# ADR-0031: 公共任务改名迁移 + 注册核验即默认订阅

- 状态：Accepted
- 类型：Bug fix（改名丢订阅者）/ Product（默认订阅）
- 日期：2026-09-16
- 关联：ADR-0004（稳定租户键 = providerUserId——本记录的订阅键结论直接依赖它）、
  ADR-0014（定时任务与公共任务模型）、ADR-0017 / DESIGN-daily-report（日报管道）、
  ADR-0019（主题订阅，`report_topics` 按 `task_name` 关联）、
  ADR-0020（引导埋点，`guide_events` 按 `task_name` 关联）、
  DESIGN-wechat-digest.md（同批引入的 `kind='wechat-digest'`）
- 触发：把公共任务「每日早报」改名为「每日资讯」。

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
