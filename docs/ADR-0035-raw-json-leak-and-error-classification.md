# ADR-0035: 原始 JSON 泄漏 + 异常原文泄漏 + 重试错误分类

- 状态：Accepted
- 类型：Bug fix / Architecture（用户可见文案统一收口 + 重试策略细化）
- 日期：2026-09-18
- 关联：ADR-0026（报告可靠性——失败重试机制的起点，本记录在其"报告任务失败
  推送话术"设计上打了一个补丁）、ADR-0028（报告任务重试按生成单元独立跟踪，
  本记录延用其单元级判定，新增"值不值得重试"这一维度）
- 触发：生产事故（真实会话，Z.俊 反馈"早报补发一下"之后收到一整段原始 JSON；
  另投诉助手把异常报错原文当回复发给他）

## 问题（真实事故）

2026-09-18 早上「每日资讯」推送异常。LLM 网关返回 `402 litellm.APIError:
账户余额不足或未开通套餐，请充值后使用`。当天「AI安全」主题的报告完全缺失
（`reports.db` 无对应行），而用户收到的却是一整段可读的原始 JSON
（`{"focus":"AI安全成焦点：...","items":[...]}`）。用户还反馈：出异常时，
错误信息原文（如上面那条 402 中文报错）被当成回复直接发给了他。

## 根因分析（file:line 级）

| # | 根因 | 位置 |
|---|---|---|
| A | **`report_unparsable`/`digest_unparsable` 降级路径把 `r.rawText` 原样当推送文案发出去** ——`r.rawText` 是喂给 `parseReportJson`/`parseDigestJson` 解析用的原始 LLM 输出；解析失败时它通常是一段结构化 JSON 而不是"模型说的一句人话"。

**本次事故的确切触发原因（实测复现，不是推断）**：模型产出的 JSON 里有一条标题含**未转义的双引号**——`"title":"Anthropic把Claude Cowork与chat合并为"一个Claude""`——`JSON.parse` 在 position 70 抛 `Expected ',' or '}' after property value`，`parseReportJson` 走 `catch { return { ok: false } }`（`src/services/daily-report.mjs:62`）直接返回，**根本没走到条目级校验**。

（复现方式：把用户实际收到的那段 payload 原样喂给 `JSON.parse` 即可。）

注意**不是**"标题超长被丢弃"——`daily-report.mjs:72` 的 `title.length > 120` 那条规则本次没有触发，用户收到的 7 条标题都只有 20–30 字。最初的排查结论写错过这一点，此处更正，避免后人误去调标题长度上限。旧代码 `const text = r.rawText \|\| this.#failureText(...)` 只要 `rawText` 非空就无条件展示，没有区分"这是道歉语"还是"这是半成品 JSON"。 | `src/services/task-scheduler.mjs`（改动前）行 210 / 222 / 288（`#runReportTask` 公共版分支、个性化分支、`#runDigestTask`） |
| B | **`agent.respond()` 抛出的异常被原样拼进用户可见回复** ——`⚠️ 处理出错了：${error?.message \|\| error}`，用户直接看到 `402 litellm.APIError: ...` 这类技术报错原文。 | `src/services/message-router.mjs`（改动前）行 72；`src/services/group-command-watcher.mjs`（改动前）行 189（同一份反模式在两处独立复制） |
| C | **重试机制不分错误类型，402/401/400 这类"重试也没用"的错误被当成普通失败机械重试** ——ADR-0026/0028 的重试判定只有"失败 → 值得重试"一档，没有"这个失败重试还是原样失败"的判断；402（账户余额问题）在充值之前重试 3 次必然还是 402，纯粹烧 `retryMax` 配额和日志，且每次都告诉用户"系统会自动重试"——一个不会兑现的承诺。 | `src/services/task-scheduler.mjs`（改动前）`#runReportTask`/`#runDigestTask` 的 `if (!unitIsLast) nextPending.push(...)`（无错误分类）、`#runForUser` 行 427（`retryable: true` 硬编码，不看错误类型） |

A 与本次"收到原始 JSON"的事故直接对应；B 与"异常信息原文发给用户"的投诉
直接对应；C 是"为什么没有任何机制推动重试及时放弃/正确处理"的更底层原因，
且**是 A 得以发生的放大器**——同一个 402 错误如果按 C 的旧逻辑走完 3 次重试，
中间某次重试若恰好让模型吐出格式不完整的 JSON（而不是稳定的异常），就会在
每一轮都触发一次 A。

## 决策

### 1. 新增统一收口模块 `src/services/failure-messaging.mjs`

避免"改了一处、另一处没同步"（ADR-0026 对 `get_daily_report`/
`resend_daily_report` 分工不清的同类教训），把"错误怎么呈现给用户"和"错误
值不值得重试"集中到一处，供三处调用方共用：

- `isRetryableError(error)`：基于错误信息的正则分类——`402`/`401`/`400`/
  "余额不足"/"未开通套餐"/"鉴权失败" 等判定**不可重试**；`429`/`5xx`/
  超时/网络类判定**可重试**；未识别类型默认按可重试处理（维持 ADR-0026
  既有的保守策略，不误杀没见过的错误类型）。
- `friendlyChatErrorText(error)`：用户主动对话失败时的口语化文案（按
  `isRetryableError` 分岔措辞，但两种都不出现错误码/英文报错原文）。
- `logServerError(scope, error, extra)`：完整错误（含 stack）记入
  `console.error`，用户看不到的信息排查时仍然可用。
- `looksLikeRawJsonPayload(text)`：判断一段文本"看起来像没解析成功、原样
  漏出来的结构化 JSON"（20 字内出现 `{`/`[` 且带引号字段名）而不是人话——
  只有判定为"人话"时才允许把 `rawText` 直接展示给用户。

### 2. 用户主动对话失败：不再泄漏异常原文（根治 B）

`message-router.mjs`、`group-command-watcher.mjs` 的 catch 分支改为：
`logServerError(...)`（完整栈落日志）+ `friendlyChatErrorText(error)`（口语化
一句话发给用户）。**两类失败区分对待**：

- **用户主动对话时的失败**（本条）：必须告知用户"出问题了"（不静默——用户
  至少要知道能不能继续等），但只给一句自然、不训导的话，技术细节一律不带。
- **定时任务推送时的失败**（见下条）：不是"要不要告诉用户"这么简单，而是
  "告不告诉、告诉几次"要看这个失败还会不会自动恢复。

### 3. 定时任务失败：不再原样展示 rawText（根治 A）

`task-scheduler.mjs` 新增 `#unitFailure(task, r, unitAttemptNumber,
unitIsLast)`：只有 `r.rawText` **不**匹配 `looksLikeRawJsonPayload` 时才展示
（对应"模型道歉语"这类历史上就允许透传的场景，既有测试 `unparsable report
degrades to raw text push` 保留原行为不变），否则一律走 `#failureText`/
`#nonRetryableFailureText` 这类标准话术——**永远不把结构化 JSON 原文发给
用户**。`#runReportTask`（公共版 + 个性化两个分支）与 `#runDigestTask` 三处
统一改用这个方法，不再各写一份判断。

### 4. 重试按可重试/不可重试区别对待（根治 C，也是 A 的放大器）

- `#unitFailure` 同时用 `isRetryableError({ message: r.error })` 判定：
  **不可重试错误第一次失败就放弃**（`giveUp = unitIsLast || !retryable`），
  不再进 `retry_units`、不再对用户承诺"会自动重试"，改用
  `#nonRetryableFailureText`（"遇到无法自动恢复的问题……今天不再重试，
  问题解决后下个周期会自动恢复正常推送"）——如实反映"这不是等一等就能自愈
  的问题"，而不是重复烧 `retryMax` 次 LLM 调用和日志。
- **可重试错误**（429/5xx/超时/网络）**行为不变**：仍按 ADR-0026/0028 既有的
  指数退避雏形——`retryIntervalMs` 节流 + `retryMax` 上限重试，退避策略本身
  未改动（`retryIntervalMs` 目前是固定间隔而非指数递增，见"遗留"）。
- `#runForUser`（私有/非报告类任务）的生成失败判定也从硬编码 `retryable:
  true` 改为 `isRetryableError(error)`，与报告/日报生成单元共用同一份分类，
  避免同一个 402 在不同任务类型里一个立刻放弃、另一个还傻等 3 轮。
- **重试不导致重复推送**：本记录未改动这一保证——ADR-0028 的单元级
  `retry_units` 机制本就保证"已成功的单元不会被重跑"，新增的"不可重试
  立即放弃"只是让**这个单元**提前进入"结算"状态，不影响其他单元/用户。
- **失败仍要落盘可观测**：不可重试的放弃与可重试的重试耗尽一样，都通过
  `results.push({ userId, error: r.error })` 汇总进 `tasks.last_error`
  （SQLite 持久化，非仅内存）；此外 `#generateAndStore`/`#runForUser` 的
  catch 分支新增 `logServerError(...)`，把完整错误栈也落进服务端日志——
  `last_error` 只存精简消息，排查时还需要日志里的 stack。

## 备选（不选的理由）

- **不区分错误类型，仍然对所有失败一视同仁重试** ：本次事故的直接教训——
  402 在余额恢复前重试三次毫无意义，纯粹浪费重试预算、拖长故障感知时间、
  还制造"系统会自动重试"的虚假承诺。
- **把 `rawText` 整体禁止展示（哪怕是人话）**：会破坏既有行为——模型偶尔
  会用自然语言道歉（"抱歉，今天没有合适的新闻"），这种文本本身就是对用户
  最诚实的说明，比"生成失败，系统会自动重试"更具体；改用启发式甄别
  （`looksLikeRawJsonPayload`）而不是一刀切禁用。
- **定时任务失败一律静默、不发任何消息**：考虑过（任务里明确提出这个选项），
  但否决——用户已经习惯性到点收早报，突然没收到又没有任何说明，只会让
  用户怀疑"是不是系统坏了/我被退订了"，回来问客服，体验并不比"如实告知
  在重试/放弃"更好。折中是**不可重试错误立刻给出明确的"放弃"说明**（而不是
  重复三次"会自动重试"的空话），**可重试错误维持现状**（每次失败都告知，
  ADR-0026 当年否决过"完全静默"就是因为"用户只会干等或来问"）。
- **异常文案按错误类型给出更细的用户提示（如"余额不足，请联系管理员充值"）**：
  否决——面向普通用户的对话失败文案不该暴露"账户余额"这类运维概念（用户
  又不能自己充值），维持"我这边的服务暂时用不了…不是你的问题"这种不需要
  用户采取任何行动的表述；运维需要的细节走 `logServerError`。

## 验收证据

`node --test --test-concurrency=1 "tests/*.test.mjs"`：**488/488 全绿**（详见
本次提交附带的测试输出）。净变化：

- `tests/message-router.test.mjs`：既有测试改名 + 断言反转——从"断言异常原文
  被发给用户"改为"断言异常原文不会被发给用户，只有 ⚠️ 开头的口语化提示"。
- `tests/task-scheduler.test.mjs`：
  - 既有 `report generation failure retries with backoff...` 测试的模拟错误
    从 `402 Insufficient Balance` 换成 `502 Bad Gateway`（该测试验证的是
    "可重试错误的退避到放弃"链路，用不可重试的 402 做例子本身就是不准确的，
    继续用 402 会与新分类矛盾）。
  - 新增 `non-retryable generation failure (402) gives up immediately...`：
    直接复现本次事故的错误文案，断言只调用一次 LLM、立刻结算、不进
    `retry_units`、用户收到的文案不含 `402`/`litellm`/"系统会自动重试"。
  - 新增 `unparsable report whose raw text still looks like JSON never
    leaks the JSON to the user`：复现事故形态——解析失败（本次是标题里的
    未转义双引号让 `JSON.parse` 抛错）但原始输出仍是一段 JSON——断言推送文案不含
    `"focus"`/`"items"`/原始 focus 内容。
  - 既有 `unparsable report degrades to raw text push` 测试（模型道歉语场景）
    未改一字，原样通过——确认"人话仍然透传"的行为没有回归。

## 遗留（诚实边界）

- **退避策略仍是固定间隔，不是指数退避**：`retryIntervalMs` 沿用 ADR-0026
  的固定节流（默认 20 分钟一次，`retryMax` 次封顶），本记录只解决了"要不要
  重试"，没有把"重试间隔"改成指数递增。当前 `retryMax=3`、总窗口约 1 小时，
  规模较小时够用；订阅量/失败频率上去后值得做成指数退避，暂不在本次范围。
- **`isRetryableError` 是正则匹配错误消息，不是结构化错误码**：LLM SDK/网关
  返回的错误目前只有 `error.message` 这一个信息源（未见 `.status`/`.code`
  字段透传），分类天然有误判空间（比如错误消息里凑巧出现"400"这样的数字但
  不是 HTTP 状态码）；未识别类型默认按可重试处理，降低误伤概率，但不是
  100% 准确，需要在后续生产观察中根据实际报错文案调整正则。
- **`looksLikeRawJsonPayload` 是启发式，不是语义分析**：理论上模型可能生成
  一段"20 字内带引号字段名"但其实是人话的文本（如直接引用了 JSON 格式说明
  的道歉语），届时仍会被误判为"结构化数据"而换成标准话术——比起"漏判导致
  再次泄漏 JSON"，这个方向的误判（多余地换成标准话术）后果轻得多，可接受。
- **未做"账户余额不足"的主动告警**：本记录只做到"用户不再收到技术报错/
  原始 JSON"和"不再对不可重试错误做无意义重试"，没有新增"给管理员发通知"
  这类主动告警机制——运维仍需要靠 `logServerError` 落的日志/`tasks.last_error`
  人工发现，这与 ADR-0026 遗留的"没有失败告警面板"是同一个未解决的边界。
