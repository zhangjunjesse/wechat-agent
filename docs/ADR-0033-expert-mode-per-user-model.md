# ADR-0033: 专家模式——per-user 临时切换更强模型（含 DeepSeek 包装按模型名 gate）

- 状态：Accepted（代码已落地，**真实端到端探针未执行**，见「验收证据」与「未验证边界」）
- 类型：Feature / Bug fix
- 日期：2026-09-17
- 关联：ADR-0004（稳定租户键——本记录的状态存储用的就是它）、
  ADR-0024 / ADR-0028（多 `AgentsSdkAgent` 实例 + 共用 sessionStore 的既有手法）、
  ADR-0030（视觉模型：同样是"配置缺失 → 特性静默不存在"的条件启用模式）、
  ADR-0013（工具描述里带动态信息的写法）

## 问题

### 1. 模型是全局写死的，用户没有任何办法为一个难问题临时换一个更强的模型

`src/server.mjs` 在构造 `AgentsSdkAgent` 时把模型名写死成
`process.env.OPENAI_MODEL || 'deepseek-flash'`（三处：主 agent、委派子 agent、
调度器 agent），`src/llm/agents-sdk-agent.mjs` 再把它烘进
`new OpenAIChatCompletionsModel(modelClient, model)`。整条链路**没有任何
per-user 模型覆盖机制**——`respond({ userId, text, profile })` 的调用方
（`MessageRouter` / `/api/chat` / `GroupCommandWatcher`）拿到的就是一个固定模型
的 agent。

生产默认是 `deepseek-v4-flash`（便宜、快），这对 95% 的日常对话是对的；但用户
偶尔会有一个明确更难的问题，希望临时用更强的模型。当前唯一的做法是改
`server.env` + 重建容器，对全体用户永久生效——粒度、时机、可逆性三样全错。

生产网关 `http://120.78.77.32:4000/v1` 的 `/models` 实测可用模型：
`gpt-5.6-sol`、`gpt-5.6-luna`、`gpt-5.6-terra`、`claude-fable-5`、
`claude-opus-5`、`deepseek-v4-flash`。所以"更强的模型"这件事不缺供给，缺的是
per-user 的开关。

### 2. 前置缺陷：DeepSeek 专有的 `reasoning_content` 被**无条件**注入所有模型的请求

`src/llm/agents-sdk-agent.mjs:33` 原本是：

```js
const { client: modelClient, reset: resetThinking } = wrapClientForDeepSeek(rawClient)
```

**无条件**包装。`wrapClientForDeepSeek` 的行为是：给请求里**每一条**带
`tool_calls` 的 assistant 消息补上 `reasoning_content`，真值缺失时还补占位字符串
`'（思考过程已省略）'`（这是 DeepSeek 三次生产 400 换来的兜底，见该文件注释与
`tests/deepseek-thinking-client.test.mjs`）。

`reasoning_content` 是 DeepSeek 思考模式的**专有协议字段**。对
`gpt-5.6-sol` 这类非 DeepSeek 模型，往请求体里塞这个字段轻则被网关忽略、重则
直接 400。这个洞此前一直没被踩到，纯粹因为"这套栈只跑过 DeepSeek"——它是历史
事实的残留，不是有意的设计。专家模式引入第二个模型的那一刻，它从"多余"变成
"阻塞性缺陷"，所以必须在同一条记录里一并修。

## 决策

### 1. 路由包装器 `ModelRoutingAgent`，而不是改任何调用方

新增 `src/llm/model-routing-agent.mjs`。它**不是** agent：没有模型、没有工具、
不碰 session/记忆。它持有两个 `AgentsSdkAgent` 实例（默认模型一个、专家模型
一个），`respond(args)` 时按该用户当前的专家模式状态决定转给谁，其余参数
（`userId`/`text`/`profile`/`channel`/`attachments`/`ephemeral`…）原样透传、返回值
原样透回。

`src/server.mjs` 用它包住原来的 `agent` 再注入 `createApp`。
**`src/app.mjs`、`MessageRouter`、`/api/chat` 一行都没改**——它们看到的仍然只是
"一个有 `respond()` 的东西"。

> 顺带说明一处与需求描述的差异：`GroupCommandWatcher`（ADR-0022，群里 @助手）
> 用的也是同一个 `agent` 变量，所以它**也**被包进来了。这是想要的：专家模式是
> per-user 的事实，同一个用户从群里 @ 助手和从私聊问，理应是同一个模型。调度器
> `schedulerAgent` 与委派子 agent 是**另外构造**的实例，没有被包，见下文§6。

**两个实例共用同一份 `sessionStore` / `memoryStore`**。`server.mjs` 里
`sessionOpts` 是一个对象字面量，`...sessionOpts` 展开进两个构造函数，
`sessionStore`/`memoryStore` 两个字段传下去的是**同一个实例引用**（不是两个连
同一个文件的不同实例）。这条必须成立：模型换了，对话历史和长期记忆不能跟着
换，否则用户切一次模式就像换了一个助手。分开的只有模型本身，以及
`AgentsSdkAgent` 每实例自带的那条串行队列（隔离手法同 ADR-0024 / ADR-0028）。

未配置专家模型时 `ModelRoutingAgent` **纯透传**（`enabled === false`），连快捷
命令都不拦——不能出现"系统说已切换、实际什么都没变"的假承诺；服务也绝不会因为
一个可选特性起不来。

### 2. 触发：确定性快捷命令（主）+ 工具（兜底），两条路写同一个状态存储

**快捷命令（主路径）**：在 `ModelRoutingAgent.respond()` 里、把请求交给任何 LLM
**之前**，对 `text.trim()` 做**精确**匹配：

- 开启：`切换到专家模式`、`专家模式`、`开启专家模式`、`打开专家模式`、`进入专家模式`
- 关闭：`退出专家模式`、`关闭专家模式`、`恢复默认模式`、`普通模式`、`默认模式`

短语表是导出的常量（`EXPERT_ON_PHRASES` / `EXPERT_OFF_PHRASES`），加词只动一行。
命中即改状态并**立即返回确认文本**：零 token、零延迟、结果确定，不存在"模型今天
心情不好没调工具"这种不确定性。

**刻意只做精确匹配，不做包含匹配**：`帮我开启专家模式吧`、`专家模式是什么意思？`
都**不**命中——否则"这个词出现在句子里"就会把人切走，那是不可控的。自由说法由
下面的工具接。

开启的确认文本必须带**具体的恢复时刻**（北京时间 `HH:MM`，口径同
`services/time.mjs`：容器是 UTC，时区固定在代码里而不是容器 TZ 里）：

```text
已切换到专家模式，接下来 60 分钟我会用更强的模型回答你。
将在 19:00 自动恢复默认模型；想提前恢复，回我「退出专家模式」。
```

**工具（兜底路径）**：`src/tools/expert-mode-tools.mjs` 的 `set_expert_mode`
（`{ enable: boolean }`），接住"开个专家模式吧""换个更聪明的模型试试"这类说法。
它有一个**无法回避的局限**：工具是在当前这轮 run 里被调用的，而模型在这轮开始
时就已经定了——**切换只能从下一条消息开始生效**。工具的返回文本因此明确要求
模型这么转述，不许声称"这条回复已经是新模型写的"。诚实地说"下一条开始"比让
用户产生错觉要好。

两条路径写的是**同一个** `ExpertModeStore` 实例（`server.mjs` 在 `buildTools()`
之前就建好它，再分别传给工具集和路由器）。"这个用户当前在不在专家模式"这件事
只有一个 owner。

### 3. 状态存储与**惰性**过期

新增 `src/services/expert-mode-store.mjs`。键 = 稳定租户键（`userId`，即 ADR-0004
的 `providerUserId`），值 = `expiresAt`（epoch ms）。

**过期是惰性判定**：`isActive(userId)` 就是 `clock() < expiresAt`。
**明确不用 `setTimeout`/定时器**——挂在进程里的"到点恢复"会随部署/重启/崩溃一起
消失，重启后用户会**永久**停在专家模式上，且没有任何记录说明为什么。惰性判定把
"过期"变成数据上的事实而不是进程里的承诺：状态落盘的是一个绝对时刻，任何进程在
任何时候读它都得到同一个答案。代价是过期不会主动通知用户——这是有意的：
**静默恢复**，不给用户推"你的专家模式到期了"这种没人需要的打扰。

- **重复开启 = 刷新**（从当前时刻重新算 TTL），不是叠加。30 分钟时再开一次，
  到期时刻是"此刻 + 60 分钟"，不是"原到期 + 60 分钟"。
- 持久化同 `context-tokens.json` 的形状（内存 Map 权威 + 同步落盘 JSON）；每次
  写入顺手清掉已过期条目，文件不会无限长大。
- 路径默认 `data/expert-mode.json`，`EXPERT_MODE_FILE` 可覆盖。容器 cwd 是 `/`，
  所以这个相对路径在生产解析到 `/data/expert-mode.json`（已挂载持久卷）——与
  `TASKS_FILE` 等同一处理方式。
- `clock` 可注入。过期语义是这个模块的全部内容，不可注入就等于不可测。

### 4. `wrapClientForDeepSeek` 按模型名 gate

新增两个导出，**原函数签名与行为一字未动**：

```js
export function isDeepSeekModel(model) { return /deepseek/i.test(String(model || '')) }

export function wrapClientForModel(client, model) {
  if (!isDeepSeekModel(model)) return { client, reset: () => {}, wrapped: false }
  return { ...wrapClientForDeepSeek(client), wrapped: true }
}
```

`agents-sdk-agent.mjs` 改为调用 `wrapClientForModel(rawClient, model)`。
非 DeepSeek 模型拿到的是**原始 client 本身**（不是"包装了但不注入"）：
`client.chat.completions.create` 不被改写，请求体里不会多出任何字节；`reset`
退化成 no-op，调用方不需要知道自己跑的是哪种模型。

**为什么新增 `wrapClientForModel` 而不是给 `wrapClientForDeepSeek` 加参数**：
后者要么破坏现有 7 条回归测试的调用形态，要么需要给"没传模型名"设一个默认行为
——而这里"默认包装"和"默认不包装"都是错的默认值（一个会把新模型坑了，一个会把
DeepSeek 坑了）。拆成两个函数让"包不包"必须由调用方显式回答。

### 5. 配置

| 变量 | 默认 | 含义 |
|---|---|---|
| `EXPERT_MODEL` | `gpt-5.6-sol` | 专家模式用的模型；**留空则整个特性不启用** |
| `EXPERT_MODE_TTL_MINUTES` | `60` | 开启后多久自动恢复 |
| `EXPERT_MODE_FILE` | `data/expert-mode.json` | 状态文件（生产 → `/data/expert-mode.json`） |

没有 `OPENAI_API_KEY` 时整个 agent 不启用（现有结构），专家模式跟着一起不存在。
`EXPERT_MODEL` 为空时：`ExpertModeStore` 不建、`set_expert_mode` 不注册、
`ModelRoutingAgent` 纯透传——行为与未加此功能完全一致（同 lark/vision 的条件
启用模式）。

### 6. 明确不做

- **定时任务不受影响**：`schedulerAgent`（日报/周报/wechat-digest）和委派子
  agent 都是**另外构造**的 `AgentsSdkAgent`，仍然读 `OPENAI_MODEL`，没有被
  `ModelRoutingAgent` 包。日报的成本与时延特性不应该被某个用户的临时开关左右。
  相应地，`set_expert_mode` **不进**子 agent 的受限工具集（`buildTools` 的
  `expertMode` 参数在那一处没传）——后台任务不得把用户交互对话的模型从底下换掉。
- **不做按群/按会话切换**，只做 per-user。
- **不做用量/成本统计与限流**（成本风险见「遗留风险」）。
- **不做"过期时主动通知用户"**（见 §3）。

## 备选方案（否掉的）

1. **把模型选择塞进 `AgentsSdkAgent.respond()` 的参数里**（每轮按 userId 现场
   决定用哪个模型）：需要把 `sdkModel` 从构造期移到调用期，触碰的是
   `deepseek-thinking-client` 的 reasoning 缓存与串行队列所在的那段代码——那段
   代码是三次生产 400 换来的，改它的风险远大于"多起一个实例"的成本。共享 agent
   定义的架构原则（ARCHITECTURE.md §3）说的是"不要每用户一个实例"，两个模型两个
   实例并不违反它。
2. **改 `MessageRouter` 和 `/api/chat` 各自做一次路由判断**：同一个决策会分裂成
   两份实现，日后必然漂移（`GroupCommandWatcher` 就会是第三份）。包装器让
   "选哪个模型"只存在于一个地方。
3. **用定时器在 60 分钟后自动关闭**：进程重启即失效，且失效方式是"永久停在专家
   模式"——比不做还糟。见 §3。
4. **只做工具、不做快捷命令**：那就把一个确定性的开关交给模型的判断力。用户明确
   说出"切换到专家模式"却因为模型没调工具而没切，是不可接受的；而且要多花一整轮
   LLM 调用去做一件纯状态变更的事。
5. **只做快捷命令、不做工具**：用户说"开个专家模式吧"就撞墙。两条路成本都很低，
   没有理由二选一。
6. **重复开启 = 叠加时长**：会让"我多说几次就能一直用着"变成一个可被无意识利用
   的漏洞，且用户对总时长失去感知。刷新语义下"什么时候结束"永远只有一个答案。
7. **给 `wrapClientForDeepSeek` 加一个 `{ model }` 可选参数**：见 §4 末段。
8. **不修 `reasoning_content` 的 gate，先看看 gpt-5.6-sol 会不会真的 400**：
   "先上线看看会不会炸"在一个已经因为这个字段炸过三次的地方不是可选项。

## 验收证据

### 自动化测试

> 实现方所在的执行环境拒绝启动 `node`（非交互会话无法应答授权提示），因此下列
> 测试由**评审方在本机实跑**。命令与结果：
>
> ```
> $ node --test --test-concurrency=1 "tests/*.test.mjs"
> # tests 480 / # pass 480 / # fail 0 / duration_ms 41436
> ```
>
> 480 = 本次之前的 461 + 新增 19（`expert-mode` 15 + deepseek gate 4）。
> `--test-concurrency=1` 是必需的：`poster-render.test.mjs` 会真起 chromium，
> 默认并行下会被 60s 超时掐成 cancelled（已知环境问题，与本次改动无关）。


新增 `tests/expert-mode.test.mjs`（15 条）覆盖：

- 快捷命令开启/关闭全部短语，且**两个 agent 的 `respond` 一次都没被调用**（零
  token 的硬断言，不是"大概没调"）；
- 开启回复里带具体恢复时刻（固定时钟 → 断言 `19:00` 这个确切字符串）；
- 惰性过期：59 分钟仍走专家 agent、**正好 60 分钟**回到默认 agent；
- 过期是静默的（返回的就是默认模型的原始回答，不带任何"已恢复"提示）；
- 重复开启是**刷新**而非叠加（断言新到期 = 当前时刻 + TTL，且再过 TTL 就失效）；
- 路由透传：`userId`/`text`/`profile`/`channel`/`attachments` 全部按**对象引用**
  断言（不是深比较），返回值 `deepEqual` 原样透回；
- per-user 隔离：A 开了不影响 B；
- 未配置专家模型 → 纯透传，连快捷命令都原样交给默认 agent、状态存储不被写；
- `ephemeral`（定时任务/子 agent 的系统侧执行）不匹配快捷命令；
- 非命令文本不被模糊匹配走；前后空白 trim 后仍命中；
- `ExpertModeStore` 落盘 → 新实例（模拟重启）仍有效，且过期判定跨重启正确；
- 过期条目不会永久留在文件里；
- `set_expert_mode` 工具与快捷命令共用同一存储、返回文本必须含"下一条消息"、
  重复开启是刷新、未配置时诚实报告不可用。

`tests/deepseek-thinking-client.test.mjs` 追加 4 条 gate 回归：

- `isDeepSeekModel` 的正负样本（含 `openrouter/deepseek-chat` 带前缀的形态）；
- **非 DeepSeek 模型的请求体里不含 `reasoning_content`**（遍历所有请求的所有
  消息断言字段不存在），且拿到的是原始 client 本身；
- DeepSeek 模型行为与直接调 `wrapClientForDeepSeek` 一致；
- 非 DeepSeek 分支不改写 `client.chat.completions.create`，`reset` 是安全 no-op。

原有 7 条 DeepSeek 测试**一个字都没改**（它们仍直接调 `wrapClientForDeepSeek`），
所以"现有行为完全不变"是被原测试本身钉住的，不是靠新测试声称的。

`tests/delegate-tools.test.mjs` 追加一条：子 agent 工具集里**没有**
`set_expert_mode`。

### 真实端到端探针

`scripts/probe-expert-model.mjs`（新增）：用与生产**完全同一条链路**
（`AgentsSdkAgent` → `@openai/agents` 的 `run()` → `OpenAIChatCompletionsModel`）
对生产网关跑一轮**带工具调用**的真实 agent run。工具集只放一个确定性工具
`probe_lookup`，它返回一个固定暗号；**只有模型真的调用了工具、真的把工具结果带
进第二轮，最终回答里才可能出现那个暗号**——所以"回答里有暗号"是工具链路走通的
硬证据，而不是"HTTP 200 所以大概没问题"。key 只从环境变量传，不进仓库任何文件。

**评审方已在本机对生产网关实跑，三个问题全部通过**（2026-09-17）：

```
$ OPENAI_BASE_URL=http://120.78.77.32:4000/v1 EXPERT_MODEL=gpt-5.6-sol \
  node scripts/probe-expert-model.mjs            # key 从生产 server.env 取，不入仓库
deepseek 包装（ADR-0033 的 gate）= 关（不会注入 reasoning_content）
[1/2] HTTP 200，网关共 6 个模型：gpt-5.6-sol, gpt-5.6-luna, gpt-5.6-terra,
      claude-fable-5, claude-opus-5, deepseek-v4-flash   ✅ gpt-5.6-sol 在列表中
[2/2] → 工具被调用了：probe_lookup(reason="用户询问今日暗号…")
      最终回答：QINGZHOU-7731                             ✅ 暗号出现在最终回答里
EXIT=0
```

即：(a) 模型可用；(b) `assistant(tool_calls) → tool → assistant` 这条历史上炸过
三次的多轮路径在 `gpt-5.6-sol` 上走通了；(c) 去掉 DeepSeek 包装后**没有 400**。

**顺带实测到一个产品相关的事实：延迟波动很大。** 同一个探针（一次工具调用 + 两
轮模型响应）两次运行分别耗时 **205.6s** 和 **44.0s**。`deepseek-v4-flash` 的同类
交互是秒级。这意味着专家模式下用户**会明显感到变慢**，且慢的程度不稳定。本次不
做任何超时/降级处理（ADR-0023 的长任务反馈机制覆盖的是子 agent，不是主回合），
记入「遗留风险」。

**探针脚本的退出码修正**：首次运行时三项断言全过、但进程以退出码 1 结束——
`fs.rmSync` 删临时目录时被 Windows 拒绝（`EBUSY`，进程仍持有 SQLite 句柄）。
脚本的契约是"退出码 0 = 三个问题都通过"，假失败等于毁掉这个契约。修法不是把
`rmSync` 包进 `try` 吞掉异常，而是补上真正缺失的能力：`MemoryStore` 与
`SessionStore` 各新增一个 `close()`（与 ADR-0032 时期给 `WechatLogStore` 补
`close()` 同一个理由和同一种写法），探针在删目录前显式关闭。生产常驻进程不需要
调用它们，行为零变化。

## 未验证边界（诚实声明）

> 下面三条在实现方交付时是敞开的（它的执行环境既不能跑 `node` 也不能出网），
> 评审方实跑后**已经关闭**，保留记录是为了说明它们曾经是风险点、以及是被什么
> 证据关掉的：480/480 测试通过、探针 `EXIT=0`（见「验收证据」）。已关闭的是：
> 测试未运行、`gpt-5.6-sol` 可用性未验证、该模型的工具调用能否跑通未验证、
> 去掉 DeepSeek 包装后是否报 400 未验证。

### 生产端到端实测（上线后，2026-09-17 11:13 CST）

上线后走**真实装配路径** `/api/chat → ModelRoutingAgent → AgentsSdkAgent`，用真实
已核验档案 `u_1a0c9651-ea5`（Z.俊）跑了一组开关对照：

| 步骤 | 请求 | 响应 | 耗时 |
|---|---|---|---|
| 1 | `切换到专家模式` | 「已切换…将在 **12:13** 自动恢复默认模型」 | 即时（未调 LLM） |
| 2 | 「你现在运行在哪个模型上？」 | 「我当前运行在 **GPT-5** 上。」 | **66.8s** |
| 3 | `退出专家模式` | 「已退出专家模式，之后的对话恢复默认模型。」 | 即时 |
| 4 | 同一个问题（对照） | 「**不确定**。」 | **6.3s** |

两条硬证据：

1. **路由真的生效**：同一个用户、同一个问题，开关前后的回答内容与耗时都出现
   数量级差异（67s/自称 GPT-5 ↔ 6s/不确定）。这是运行时证据，不是读代码推断。
2. **订阅键接对了**：`/data/expert-mode.json` 写出的键是
   `o9cq80wXtSkIXBJDDLCggTI4WQPY@im.wechat`，即**稳定租户键**（ADR-0004）而不是
   浏览器 id `u_1a0c9651-ea5`——这正是这类功能最容易接错、且错了以后在微信侧
   静默失效（网页能切、微信切不动）的地方。`退出专家模式` 后文件回到 `{}`，
   证明清理路径也对。

容器 `WorkingDir` 为空（cwd = `/`），`data/expert-mode.json` 如预期解析到持久卷
上的 `/data/expert-mode.json`。

> 副作用如实记录：这组验证在 Z.俊 的真实助手会话里留下了 4 轮无害对话。

**仍然敞开的**：

- **只验过"能跑通"，没验过"答得更好"**：探针证明的是链路可用（工具调用 + 多轮
  回传 + 无 400），不是 `gpt-5.6-sol` 在真实用户问题上的回答质量确实优于
  `deepseek-v4-flash`。"专家模式更强"目前是选型假设，没有对照评测支撑。
- **微信侧（iLink）真实收发未走过**：上面的生产实测走的是 `/api/chat`，与微信
  私聊共用同一个 `ModelRoutingAgent` 实例和同一个稳定租户键，但
  `MessageRouter` → iLink 真实收发那一段没有真人跑过。剩余风险很小（两条路径
  在 `agent.respond` 之后完全相同），但不等于零。
- **群聊里的快捷命令行为未实测**：`GroupCommandWatcher` 共用同一个 agent，因此
  群里 @助手 说「专家模式」也会切换**说话人自己**的模式。这是设计意图（见
  §决策1），但没有在真实群里验证过。
- **记忆/摘要侧仍走默认模型**：`AgentsSdkAgent` 的 `#memoryComplete` 用的是
  `process.env.OPENAI_MODEL || model`，所以专家实例的记忆抽取/摘要仍然是便宜的
  默认模型。这是**有意**的（记忆抽取是结构化单轮任务，不需要强模型，也不该按
  专家模式的价格计费），但它意味着"切到专家模式"并不是"这个用户的一切都变强了"。
- **一个被本次改动顺手暴露、但刻意未修的既有事实**：
  `wrapClientForDeepSeek` 是**原地改写** `client.chat.completions.create` 的，
  而 `agents-sdk-agent.mjs` 里 `rawClient` 和被包装的 `modelClient` 是**同一个
  对象**。所以那句"memory/summarize calls keep the raw client"的注释对 DeepSeek
  路径其实**不成立**——记忆调用一直也走着包装层。本次没有动它：改它会改变
  DeepSeek 路径的现有行为，而那正是本记录承诺不碰的部分。**登记为独立待办。**
  （ADR-0033 之后，非 DeepSeek 模型下这句注释反而变成真的了。）
- **专家模式对定时任务不生效这件事没有对用户暴露**：用户在专家模式期间订阅的
  日报仍由默认模型生成，助手不会主动说明。暂时接受（日报是系统侧产物，用户对它
  用什么模型没有预期），但如果有人问起，模型没有任何上下文可以据实回答。

## 遗留风险

- **成本**：`gpt-5.6-sol` 的单价大概率显著高于 `deepseek-v4-flash`（具体倍数本
  仓库不掌握）。当前**没有任何用量统计、配额或限流**——一个用户可以每 59 分钟
  刷新一次，无限期停在强模型上。按需求明确要求，本次不实现。方向（按优先级）：
  ① 复用 ADR-0020 的 `guide_events` 形状，给 `ExpertModeStore` 的开启动作打一条
  埋点，先拿到"到底有多少人在用、用多久"的真实数据；② 再决定要不要加每日累计
  时长上限或每用户白名单。**先量再限**，现在拍的任何阈值都是猜的。
- **延迟**：实测同一探针两次分别 205.6s / 44.0s（默认模型同类交互是秒级）。用户
  在专家模式下会明显变慢，且慢得不稳定；一次带多轮工具调用的复杂提问有可能长到
  让人以为助手挂了。当前**没有任何超时、进度提示或自动降级**。方向：先复用
  ADR-0023 的「长任务反馈」思路给主回合加一个"还在想"的中途提示，再考虑超过阈值
  自动回落默认模型（回落会让同一个问题前后用两个模型，语义上要想清楚才做）。
- **模型能力差异导致的行为不一致**：两个模型的工具调用倾向、中文措辞风格、遵守
  `PACE_RULES` 的程度都可能不同。同一个用户在同一段对话里切换模型，可能感到
  "助手性格变了"。session/记忆是连续的（本记录保证的部分），但语气不是。
- **两个 `AgentsSdkAgent` 实例 = 两条独立串行队列**：同一个用户在切换瞬间前后
  发的两条消息会落在两条不同的队列上，理论上可能乱序完成。实际影响很小（用户
  切换时通常在等确认），且 session 的 `append` 是各自 run 结束后才写，不会互相
  覆盖结构；但这不是被测试覆盖的路径。
- **`EXPERT_MODEL` 配错一个字母不会在启动时被发现**：服务照常起来，用户切过去
  之后第一条消息才 404/400。条件启用只检查"配没配"，没有检查"配的这个存不存
  在"。可以在启动时打一次 `/models` 做校验——本次没做（会给启动路径增加一个网络
  依赖），登记为可选改进。
- **状态文件与 session/memory 不在同一个存储里**（JSON vs SQLite）：单机没问题，
  但如果以后上多实例，这个 JSON 会成为第一个不一致点。届时应跟着
  ARCHITECTURE.md §8 的路线一起迁到外部 store，而不是单独给它做同步。
