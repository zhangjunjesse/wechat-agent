# ADR-0039: 板驱动子任务补上 WeChat channel——`send_file`/`notify_user` 此前在后台任务里必然拒绝

- 状态：Accepted
- 类型：Bugfix
- 日期：2026-09-19
- 关联：ADR-0012（`send_file`/`notify_user` 的 channel 门禁契约源头）、
  DESIGN-agent-task-board.md / ADR-0024（`SubagentRunner` 本体，`#tokenFor`/
  `#contextTokens` 缓存已在这里为 `#safeNotify` 存在）、ADR-0038（固定反馈管道，
  板任务的产出正是本记录要修的这条投递路径）

## 问题（与方案无关）

`buildSubagentPrompt`（`subagent-runner.mjs`）第 2 条明确告诉每一个被派去后台
执行的子 agent："产出文件时先用 write_file / 相应工具生成，再用 send_file 直接
发给用户（**当前对话是微信渠道**）"——但 `#execute()` 调用 `agent.respond()` 时
从未传过 `channel` 参数。`send_file`/`notify_user`（`wechat-send-tools.mjs`）都
在 `execute` 开头判 `!ctx?.context?.channel` 直接拒绝，于是这两个工具对**每一个**
板驱动任务都必然拒绝，只能改用 `write_file` 的下载链接兜底——prompt 对子 agent
撒了谎，子 agent 只能如实转告用户"当前对话不是通过微信进行的"。

证据来源：生产真实用户"Z.俊"（`provider_user_id =
o9cq80wXtSkIXBJDDLCggTI4WQPY@im.wechat`）2026-09-18～19 的任务板记录（`/data/
task-runs.db` 的 `agent_tasks`）与会话 transcript（`/data/sessions.db`）直接读出
——多轮"总结今天的消息，做成图片报告"任务，结算文案都含"当前对话不是通过微信
进行的，无法直接发送文件——请改用 write_file"，用户每次都只能点下载链接，从未
在微信里直接收到过图片。`notify_user` 同理必然返回"当前渠道不支持主动消息"。

对照发现：`#safeNotify()`（同文件）早就在用 `#tokenFor(userId)` 从
`#contextTokens` 实时缓存（`DESIGN-timed-tasks.md` 的既有机制，`message-router.
mjs` 每条入站消息都会刷新）里取 `providerBotId`/`contextToken`，拼出结算文本的
`provider.sendText(...)` 参数——**同样的数据早已在这个文件里，只是没有被组装成
`channel` 对象喂给 `agent.respond()`**，工具层因此拿不到。

## 决策

1. `SubagentRunner` 新增私有方法 `#channelFor(userId)`：复用既有 `#tokenFor`，
   套上 `type: 'ilink'`，还原出与 `message-router.mjs` 里
   `{ type: 'ilink', providerBotId, toProviderUserId, contextToken }` 完全同构
   的 `channel` 对象。不新增缓存、不新增数据源。
2. `#execute()` 里 `agent.respond({ userId, text, profile, ephemeral: true })`
   加一个参数：`channel: this.#channelFor(task.userId)`。`ephemeral` 与
   `channel` 是正交参数——`agents-sdk-agent.mjs#doRespond` 里 `ephemeral` 只管
   session 要不要读写，`channel` 原样进 `run(...)` 的 `context`，互不影响。
3. 缓存未命中（用户很久没发过消息，本进程内存里没有它的 token）时
   `#channelFor` 返回 `null`——与网页对话调用 `agent.respond()` 不传 `channel`
   时完全同一降级路径，`send_file`/`notify_user` 的 `!channel` 分支早已覆盖，
   不需要新增任何代码，行为就是今天的下载链接兜底。

## 本决策不解决什么（边界）

- **不解决同批次任务间的产出数据搬运**。子 agent prompt 明确"你没有
  task_create 等任务板工具"，也没有读取兄弟任务结果的工具（如 `task_output`）。
  生产真实案例：9-18 三任务批次里，"生成图文报告"因为找不到"整理消息要点"那
  一步产出的文件，如实拒绝编造内容，用户只能重新问一遍由主对话临场补救。这是
  "依赖边只管顺序、不管数据流"的更大设计问题（要不要把 `blockedBy` 任务的
  `result` 自动注入 description，或者给 worker 开一个只读的 `task_output`），
  留待单独评估，不在本次改动范围。
- **不解决进程重启打断正在跑的任务**。同一时段生产记录里出现过 2 次"进程重启
  中断，可重试"（board #1、#4 各自补跑 1～2 次才成功）——这是当天频繁
  `docker restart` 部署造成的运维噪音，`isRetryableError` 早已覆盖这类失败并
  自动重跑，不是本次要修的缺陷。
- **不改变单任务 300 秒超时上限**。`task-10`（"拉取今日微信群消息"，覆盖 19
  个群）撞过一次 300 秒硬顶，release 后重挑用 77 秒完成——观察到但不在本次
  改动范围，真出现规律性超限再单独评估要不要调 `timeoutMs`。

## 验收标准（可观察）

- `tests/subagent-runner.test.mjs` 新增两条：
  - contextToken 缓存命中时，`agent.respond` 收到的 `channel` 与
    `message-router.mjs` 同构：`{ type: 'ilink', providerBotId, toProviderUserId,
    contextToken }`。
  - 缓存未命中（`contextTokens.get()` 返回 `null`）时 `channel` 为 `null`，与
    网页对话同一降级契约。
- 全量 `npm test`：531/531 全绿（基线 529 + 新增 2，其余用例零回归——已跑
  `node --test tests/subagent-runner.test.mjs tests/wechat-send-tools.test.mjs
  tests/turn-pipeline.test.mjs` 与全量 `npm test` 两遍核对）。
- **生产验证（诚实标注：写这份记录时还没做）**：部署后用真实 WeChat 账号触发
  一次"生成图片报告"类任务，确认结算通知不再出现"当前对话不是通过微信进行
  的"，图片/文件以微信原生消息直接送达，不是下载链接。

## 遗留风险

- **contextToken 新鲜度**：`#tokenFor` 拿到的是"当前进程内存里最新"而不是
  "绝对新鲜"的 token——如果任务从创建到真正被执行之间隔了很久（长排队、长
  退避、或用户很久没再发过消息刷新缓存），iLink 侧 token 仍可能已经过期。这种
  情况下 `channel` 非空但底层 `provider.sendText`/`sendImage` 可能仍然失败，
  会落进 `#execute` 既有的 catch 分支、按现有失败分类（可重试/不可重试）处理，
  不是本次改动引入的新风险，只是没有专门为此加合法性预检。
- **群命令入口未单独验证**：ADR-0022 记录群 `@助手` 入口最终用
  `profile.ilinkUserId` 作为 tenant key，与私聊同一会话键——理论上 board 任务
  无论来自私聊还是群命令都应该命中同一份 `#contextTokens` 缓存，但本次生产
  证据（Z.俊 的案例）只覆盖了私聊路径，群命令触发的板任务尚未单独用真实数据
  核对。
