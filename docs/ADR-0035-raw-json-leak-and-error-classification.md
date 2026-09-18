# ADR-0035: 原始 JSON 泄漏 + 异常原文泄漏 + 重试错误分类

- 状态：Accepted（本记录含两轮修改：初次事故整改 + 同日第二轮补强，见下方
  "追加决策"）
- 类型：Bug fix / Architecture（用户可见文案统一收口 + 重试策略细化）
- 日期：2026-09-18（第二轮补充同日）
- 关联：ADR-0026（报告可靠性——失败重试机制的起点，本记录先在其"报告任务失败
  推送话术"设计上打了一个补丁，第二轮进一步**修正**了 ADR-0026 关于"失败要不
  要告知用户"的决策，见"追加决策 §3"）、ADR-0028（报告任务重试按生成单元独立
  跟踪，本记录延用其单元级判定，新增"值不值得重试"这一维度，第二轮又在单元
  级重试之外加了一层"就地重生成"）
- 触发：生产事故（真实会话，Z.俊 反馈"早报补发一下"之后收到一整段原始 JSON；
  另投诉助手把异常报错原文当回复发给他）；第二轮触发：同一次事故复盘时发现
  ①20 分钟的重试间隔对"模型偶发吐坏 JSON"这种大概率秒级自愈的失败反应太慢
  （当天"AI安全"主题因此完全没送达），②产品负责人明确要求"异常了不要提示
  用户，很不友好"，与 ADR-0026 当年"失败要如实告知"的决策直接冲突，需要
  正面处理这个冲突而不是绕开它。

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

## 追加决策（同日第二轮，2026-09-18）

复盘时发现原始整改还不够：`retryIntervalMs` 默认 20 分钟，对"模型偶发吐坏
JSON"这种大概率**秒级自愈**的失败反应太慢（当天"AI安全"主题因此完全没送达）；
同时产品负责人明确要求——用户原话："如果异常，不要给用户提示异常信息，
很不友好"。这两点都在原整改范围之外，本轮补上，仍记在 ADR-0035 里（同一个
事故、同一批决策所有者，不新开 ADR）。

### 1. 解析失败当场重生成，不等 retryIntervalMs

`report_unparsable`/`digest_unparsable` 是最常见、也最容易自愈的失败形态
（模型这次输出坏 JSON，不代表下次还会）。20 分钟的节流是为"账户余额/网关
抖动"这类需要时间恢复的问题设计的，用在"多问一次模型"上完全不对——用户
不该为了等一个大概率立刻能修好的问题干等一个完整周期。

- **落点**：`task-scheduler.mjs#generateAndStore`（报告）与
  `wechat-digest-runner.mjs#generate` 的 reduce 步骤（digest）——两者都是
  "调 agent → 解析 JSON"这一步唯一发生的地方，在这里加一个内层循环最贴近
  问题本身，不需要往上层的 tick/`retry_units` 机制里塞新状态。
- **次数**：`unparsableRetries`（默认 **2**，即一次单元尝试内最多问模型
  **3** 次）。依据：约等于 `retryMax` 默认值的量级（同样是"这类失败该给几次
  机会"的经验判断），但语义完全不同——`unparsableRetries` 是**同一次单元
  尝试内**、**同一个 tick 内**的就地重试，不吃 `retryIntervalMs` 的节流，也
  不推进 `tasks.attemptCount`；`retryMax` 是跨 tick、隔 `retryIntervalMs`
  的单元级重试（ADR-0028）。两者独立配置、互不冲突：就地重试全部失败后，
  才会作为"这一次单元尝试失败"计入 `retryMax` 的重试预算。
- **纠正提示**：重试时在 prompt 末尾追加一句
  `failure-messaging.mjs` 新增的 `JSON_RETRY_HINT`常量（"注意：你上一次的
  输出不是合法 JSON……字符串内部如果需要出现双引号，必须写成 \" 转义"），
  沿用现有 prompt "请严格按照以下 JSON 结构输出，只输出 JSON" 的措辞风格，
  不另造一套写法；两处调用方（daily-report/wechat-digest）共用同一个常量，
  避免话术分裂。
- **不产生重复推送**：`#fanoutReport` 只在整个就地重试循环结束后、拿到最终
  的 `parsed`/`digest` 结果时调用一次；循环内部只是反复调 `agent.respond`
  + 解析，从不推送，所以就地重试无论成败都只对应一次用户可见的结果（成功
  = 一份正常报告；失败 = 落入下面第 3 条的静默/告知规则）。
- **与单元级 `retry_units` 互不干扰**：就地重试完全在 `#generateAndStore`/
  `WechatDigestRunner#generate` 内部完成，返回给调用方的仍然只是
  `{ ok:true, report }` 或 `{ ok:false, error, rawText }` 这一个结果；
  `#runReportTask`/`#runDigestTask` 的单元级重试队列逻辑（ADR-0028）完全不
  感知内部发生过几次就地重试，不需要改一行。

### 2. `parseReportJson`/`parseDigestJson` 对"未转义引号"做一次有界修复

新增 `src/services/json-repair.mjs`，只在 `JSON.parse` 已经失败之后尝试
**一次**、只处理**字符串值内部出现未转义双引号**这一种形态（本次事故的确切
根因）。做法是一次线性字符扫描（不是构建 AST 的通用解析器）：进入字符串后
每遇到一个引号，向后跳过空白看下一个非空白字符——是 `,`/`}`/`]`/`:` 之一
（或已到末尾）就判定为真正的字符串终止符，否则判定为"忘了转义的内部引号"，
补上反斜杠继续留在字符串状态里。修复后必须再过一遍 `JSON.parse`，通不过就
返回 `null`，调用方照旧走 `ok:false`——绝不把"修复失败"伪装成"修复成功"去
拼数据。用真实事故的 payload
（`"title":"Anthropic把Claude Cowork与chat合并为"一个Claude""`）验证过能
正确修复（见 `tests/daily-report.test.mjs`
`parseReportJson repairs the exact unescaped-quote shape...`）；也用截断
JSON、多余逗号、纯乱码三种"修不出来"的输入验证过不会误修成假数据（见
`repairUnescapedQuotes never fabricates data...`）。

这个修复器和第 1 件的就地重生成是互补关系，不是互斥：修复器先在原地试一次
（零 LLM 调用成本，命中就是这次事故这种形态），修不出来才会真的走到就地
重生成（多问模型一次，覆盖修复器覆盖不到的坏 JSON 形态，比如结构性错乱、
字段整体缺失）。

### 3. 失败话术改为"首次静默、最终才说"（修正 ADR-0026）

**这是对 ADR-0026 决策的修正，不是绕开**。ADR-0026 当年在"要不要完全静默"
上给出的结论是：不行——"用户已经习惯性到点收早报，突然没收到又没有任何
说明，只会让用户怀疑系统坏了/被退订了，回来问客服"。这个判断本身没有错，
本记录也没有推翻它——**最终放弃时仍然明确告知**，用户依然知道"这次没有、
明天会恢复"，不会被晾在那里怀疑自己是不是被退订了。ADR-0026 否决的是**一
次都不说**；本记录改的是**过程中要不要每次都说**：

- **可重试错误的首次/中间失败**：不再给用户发任何消息，只落服务端日志 +
  `tasks.last_error`。原因是第 1 件的就地重生成已经把"模型偶发吐坏 JSON"这
  个最大头的失败源压到了同一个 tick 内秒级解决；剩下真正跨 tick 重试的
  （网关抖动、限流），"每次失败都发一句「系统会自动重试」"对用户是纯噪音
  ——他既不需要采取任何行动，也不该被打扰去确认"是不是我的问题"。加上产品
  负责人的明确反馈："如果异常，不要给用户提示异常信息，很不友好"。
- **最终放弃时**（重试次数耗尽）：仍然发一条口语化说明（`#finalGiveUpText`，
  即原 `#failureText` 改名后只保留的这一支）——这正是 ADR-0026 坚持的部分：
  用户不会被晾在"今天早报去哪了"的疑惑里。
- **不可重试错误**（402/401/400）：不适用"先静默"——它不会自己恢复，静默
  只会让用户白等到明天才发现异常，所以维持"立即告知、不承诺重试"（沿用
  本 ADR 原有决策，未改动）。
- **落点**：`task-scheduler.mjs#unitFailure`——`giveUp` 语义不变
  （ADR-0028 定义的"这个单元是否到此为止"），新增的是它返回的 `text` 现在
  可能是空字符串（代表"这一次不发消息"），三处调用方（`#runReportTask` 的
  公共版/个性化分支、`#runDigestTask`）据此在 `text` 为空时跳过
  `#fanoutReport`，只记 `results.push({ userId, silent: true })` 做可观测
  记录，不调用 provider 发消息。
- **对"模型给了人话"（安全 rawText）的场景不受影响**：`#unitFailure` 里
  `safeRaw` 分支（模型自然语言道歉，如"抱歉，今天没有合适的新闻"）仍然
  无条件透传——这不是"失败通知"，是模型确实给出的内容，跟本条"要不要通知
  失败"的规则是两回事，透传逻辑本身继续沿用 ADR-0035 第一轮的
  `looksLikeRawJsonPayload` 判断，未改动。
- **解析失败经第 1 件的就地重生成后成功**：`#generateAndStore`/
  `WechatDigestRunner#generate` 直接返回 `ok:true`，根本不会走到
  `#unitFailure`——用户只会收到正常日报/简报，完全感知不到中途那次坏输出，
  这是"首次静默"规则里最常见、最理想的一种结果。

## 备选（不选的理由）

- **不区分错误类型，仍然对所有失败一视同仁重试** ：本次事故的直接教训——
  402 在余额恢复前重试三次毫无意义，纯粹浪费重试预算、拖长故障感知时间、
  还制造"系统会自动重试"的虚假承诺。
- **把 `rawText` 整体禁止展示（哪怕是人话）**：会破坏既有行为——模型偶尔
  会用自然语言道歉（"抱歉，今天没有合适的新闻"），这种文本本身就是对用户
  最诚实的说明，比"生成失败，系统会自动重试"更具体；改用启发式甄别
  （`looksLikeRawJsonPayload`）而不是一刀切禁用。
- **定时任务失败一律静默、不发任何消息（连最终放弃也不说）**：仍然否决
  ——这是 ADR-0026 的原判断，追加决策 §3 没有推翻它：最终放弃这一刻依然
  会发一条口语化说明，用户不会被晾在"是不是系统坏了/我被退订了"的疑惑里。
  追加决策 §3 改的只是"过程中的每次中间失败要不要都说"，不是"要不要说"。
- **异常文案按错误类型给出更细的用户提示（如"余额不足，请联系管理员充值"）**：
  否决——面向普通用户的对话失败文案不该暴露"账户余额"这类运维概念（用户
  又不能自己充值），维持"我这边的服务暂时用不了…不是你的问题"这种不需要
  用户采取任何行动的表述；运维需要的细节走 `logServerError`。
- **写一个通用的、能修任意畸形 JSON 的解析器/引入第三方修复库**：否决——
  超出了"这次事故是什么形态"的范围，通用修复器意味着要对"什么算合理修复"
  做大量主观判断，误修成看似合法实则错误数据的风险远大于收益；`json-repair.mjs`
  刻意只做一件事（未转义引号），修不出来就老实放弃。

## 验收证据

`node --test --test-concurrency=1 "tests/*.test.mjs"`：第一轮 **488/488**
全绿；第二轮（本次追加决策）**496/496** 全绿（净增 8 条测试）。

第一轮净变化（原样保留，未再改动）：

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

第二轮（追加决策 §1-3）净变化：

- `tests/task-scheduler.test.mjs`：
  - 新增 `in-place regenerate succeeds within the same sweep after a bad
    first attempt...`：第 1 次坏输出、第 2 次（带 `JSON_RETRY_HINT`）成功，
    全程在同一次 `sweep()` 内完成，用户只收到正常日报、断言不含"已重试"/
    "无法自动恢复"字样。
  - 新增 `in-place regenerate exhausts unparsableRetries, then falls back
    to the unit-level retry queue silently`：就地重试 3 次全部失败（默认
    `unparsableRetries=2`），断言 `calls===3`、`sent.length===0`（首次失败
    静默）、`retryUnits` 正确挂起。
  - 既有 `report generation failure retries with backoff...` 改名为
    `...silent until it finally gives up`，断言改为"中间两次失败
    `sent.length` 保持 0，只有第 3 次（耗尽）才变成 1"。
  - 既有 `unparsable report whose raw text still looks like JSON...`
    改造为跨多轮 sweep：第 1 轮断言静默（`sent.length===0`）+ `retryUnits`
    挂起，第 2 轮（耗尽）才断言最终话术不含 `"focus"`/`"items"`/原始内容。
  - `one topic failing does not block another topic`、`partial failure
    retries only the failed unit`、`a unit that keeps failing exhausts its
    own retries` 三条既有测试的"中间失败"断言从"收到会自动重试消息"改为
    "收到消息数不变/断言不含'系统会自动重试'"，"最终放弃"断言不变。
- `tests/daily-report.test.mjs`：新增
  `parseReportJson repairs the exact unescaped-quote shape from the
  2026-09-18 incident`（拿事故原始 payload 验证修复成功）、
  `repairUnescapedQuotes never fabricates data when the input is genuinely
  unfixable garbage`（截断 JSON/多余逗号/纯乱码都保持 `null`，不误修）、
  `repairUnescapedQuotes escapes an inner quote only when it is not
  followed by a JSON terminator`（单测修复器的核心启发式）。
- `tests/wechat-digest.test.mjs`：新增 `parseDigestJson repairs the same
  unescaped-quote shape as daily-report`。
- `tests/wechat-digest-runner.test.mjs`：新增 `reduce in-place regenerate
  succeeds on the second attempt...`、`reduce in-place regenerate exhausts
  unparsableRetries then reports digest_unparsable`；`setup()` 测试帮助函数
  新增可选的 `agent`/`unparsableRetries` 覆盖参数以支撑这两条新测试。
- `tests/wechat-digest-scheduler.test.mjs`：既有 `one subscriber failing
  does not affect another...` 的"u2 收到会自动重试话术"断言改为"u2 完全
  没收到消息"（`sentText.length===1`，只有 u1 那条）。

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
- **`repairUnescapedQuotes` 的终止符启发式在极端边界会误判**：如果字符串
  内容本身就以逗号/右括号/冒号紧跟一个引号结尾（而不是真的到了字符串边界），
  会被误判为终止符而提前收尾。这种边界目前没见过真实案例，且误判后大概率
  导致后续 `JSON.parse` 仍然失败（进而 `ok:false`），比"误判成看似合法的
  错误数据"风险小得多；后续生产观察中如果发现真实的误判案例再收紧。
- **静默期完全依赖服务端可观测性**：可重试错误的首次/中间失败现在用户完全
  无感知，一旦 `logServerError`/`tasks.last_error` 没人看，故障发现会比
  "每次都告知"的旧行为慢——这是本次修正主动接受的取舍（用户体验 vs 故障
  可见性），换来的前提是"就地重生成大幅降低了真正需要多轮重试的失败数量"；
  没有做到的是给运维一个主动告警（同上一条"账户余额不足"的告警缺口是同一类
  未解决问题）。
- **`unparsableRetries` 与 `retryMax` 叠加后的最坏调用次数**：一个持续输出
  坏 JSON 又赶上跨 tick 重试的单元，最坏情况下会问模型
  `(unparsableRetries+1) * (retryMax+1)`（默认 3×4=12）次才彻底放弃——比
  修正前的 `retryMax+1`（默认 4）次更耗 LLM 配额。这是"更快自愈"与"更贵重试
  上限"之间的取舍，当前默认值下单次事故的调用次数仍在可接受范围，量级上去
  后需要重新评估默认值。
