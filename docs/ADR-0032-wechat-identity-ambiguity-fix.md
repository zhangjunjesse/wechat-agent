# ADR-0032: 微信身份匹配从"并列 OR"改成"分级+同名歧义拒绝"

- 状态：Accepted
- 类型：Bug fix / Security / Privacy
- 日期：2026-09-16
- 关联：ADR-0007（微信聊天记录检索技能——本记录修的就是它定义的 `accessibleChats`）、
  ADR-0022（群命令入口——同一根因的姊妹问题，一并修）、
  DESIGN-wechat-digest.md（微信日报/周报——把这个洞从"用户主动查才触发"变成
  "每天自动触发"的直接原因）

## 问题

### 1. 生产实测：同名用户能互相看到对方的全部群聊

`WechatLogStore.accessibleChats(identity)` 用 `{wxid, nickname}` 决定"这个用户能
看哪些聊天"，原 SQL：

```sql
SELECT chat_wxid, MAX(chat_name) AS chat_name FROM chat_roster
WHERE (? != '' AND member_wxid = ?) OR (? != '' AND member_display = ?)
GROUP BY chat_wxid ORDER BY chat_name
```

wxid 匹配与昵称匹配是**并列的 OR**，两条路等价可信——隐含假设是"wxid 通常有、
昵称只是兜底"。生产实测推翻了这个假设：

- `datadefender.cn` 上 `/opt/wechat-agent/data/profiles.json` 里，**全部 7 个
  真实已核验用户的 `wxid` 都是空字符串**。`member_wxid = ''` 那条路有
  `? != ''` 守卫不会误配，但也意味着线上**实际只有昵称这一条路在生效**。
- 同一份 `profiles.json` 里，**已有 4 条记录的 `nickname` 都是"Z.俊"**（不同
  `userId`，其中两条带同一个 `ilinkUserId`，另两条是更早的未绑定记录）。

后果：**任意两个微信昵称相同的用户会互相看到对方的全部群聊**（群列表 + 群消息
正文，经 `wechat_list_chats`/`wechat_search_chat`/`wechat_search_mentions`/
`wechat_search_my_messages` 四个工具）——跨用户隐私越界。

这个洞在 ADR-0007 引入 `wechat_*` 工具时就存在，但此前只在"用户主动发问触发某
个 wechat_* 工具"时才会被踩到；DESIGN-wechat-digest.md 的微信日报/周报上线后，
`WechatDigestRunner.generate` 会对**每个订阅者每天自动调用一次**
`accessibleChats`——同一个漏洞从"小概率、用户可感知"变成"每天自动、用户无感"。

### 2. 为什么 wxid 大面积缺失：验证码消息的 `sender_wxid` 在生产里经常是空的

核验链路（`VerificationService` → `RemoteWechatVerifier.checkTask` →
`findAssistantCode`）从"用户发到助手的验证码消息"里取 `sender_wxid` 当作这个人
的 wxid。但 `findAssistantCode` 只读消息**行本身**的 `sender_wxid` 字段——而
ADR-0007 自己的记录已经点出：1:1 私聊的身份标识本来就是**那个会话的
`chat_wxid`**（"用户自己的 wxid 本身就是他们私聊线程的标识"），消息级
`sender_wxid` 对 1:1 场景是冗余信息。据此推断（无法访问 `wechat-chatlog-dsh`
仓库源码验证，见"遗留风险"）：同步侧大概率只在**群聊**里认真解析每条消息的
`sender_wxid`（群里必须靠它区分发言人），1:1 场景则把这件事完全交给
`chat_wxid`，消息行的 `sender_wxid` 经常留空——这与生产 7/7 全空的实测完全吻合。

`messages` 表的 `chat_wxid` 列本身有明确、已用真实数据核对过的语义（ADR-0007
§1）：非群聊（`is_group=0`）的 `chat_wxid` 就是对方的真实 wxid。群聊
（`@chatroom` 后缀，`wechat-chatlog-dsh` 的既有约定，`tests/*.test.mjs` 里随处
可见）的 `chat_wxid` 则是群 id，绝不是任何个人的 wxid。

## 决策

### 1. `accessibleChats`：分级匹配，wxid 已知时昵称完全不参与

```js
if (wxid) {
  // 只按 wxid 查 chat_roster；昵称不参与——同名不同人不会被并进来
} else if (nickname) {
  // 降级：按昵称查 chat_roster，但先看这个昵称对应几个不同的 member_wxid
  // > 1 个 → 拒绝返回（[]），并通过 onAmbiguousNickname 回调报告原因
  // ≤ 1 个（0 或 1）→ 正常返回
}
```

`onAmbiguousNickname({ nickname, memberWxids })` 默认实现是 `console.error`——
拒绝路径必须**可观测**（运维能在日志里看到"某用户被挡在降级路径上"），而不是
一个查无实据的"我怎么突然看不到群了"。调用方（目前没有）可以传自定义回调接到
真正的告警系统。

宁可让这个用户暂时看不到自己的群，也不能让他看到别人的群——同 ADR-0007 定的
基本立场（"访问范围仅限用户实际参与的群组"）在歧义场景下唯一站得住的解读。

### 2. 核验链路：验证码消息反查不到 `sender_wxid` 时，用 `chat_wxid` 兜底

`profile-verifier.mjs` 的 `findAssistantCode` 新增可选 `chatWxid` 参数：消息行
自身的 `sender_wxid` 优先；缺失且调用方告知这条消息来自哪个 1:1 会话（不是
`@chatroom` 群）时，用该会话的 `chat_wxid` 当 wxid 兜底。

`RemoteWechatVerifier.checkTask` 只在**候选循环**（`chats.chats` 里逐个搜索验证
码的那一段）里传 `chatWxid`——那里的每个 `candidate` 确实是"这条验证码消息所在
的那个具体会话"。**故意不**在第一次查找（`chat_display === '助手'` 那个共享的、
所有用户核验都会先查一遍的会话）里传：那个会话不是某个用户专属的，把它的
`chat_wxid` 当成"用户的 wxid"会把所有验证码恰好命中那一步的用户全部错配成同一
个假身份——比"不知道"更糟。

### 3. 姊妹问题：`GroupCommandWatcher` 的群消息发送者识别是同一个 OR 坑，风险更高

排查过程中发现 `group-command-watcher.mjs`（ADR-0022，群里 @助手 → 私聊推送结
果）用的是完全相同形状的并列 OR：

```js
const matched = profiles.filter((p) =>
  (p?.nickname && sender && p.nickname === sender) ||
  (p?.wxid && senderWxid && p.wxid === senderWxid))
```

这里的风险方向更严重：命中的不是"读到不该读的群"，而是**把 agent 处理结果
（可能包含私有内容，如取回的飞书文档正文）私聊推给同名的另一个人**。群消息的
`sender_wxid` 通常可信（群花名册本就是为了让真实 wxid 消歧义而建的，ADR-0007
§1），所以修法是：`sender_wxid` 存在且能在已核验档案里找到匹配时**只**认它；
缺失或没有任何档案匹配时才降级到昵称，降级路径同样在昵称对应多个不同 `wxid`
时拒绝（不响应），不再"挑第一个有私聊通道的同名档案"。

一并修是因为这不是"顺便"——同一次生产事故调查里发现的同一个根因，放着不修等
于只堵了读路径、没堵写/推送路径，报告不完整。

### 4. 存量数据回填：`scripts/backfill-wechat-wxid.mjs`

代码修好只影响**以后**的核验；已经核验过的 7 个生产用户 profile 里 wxid 已经
落定为空，服务不会重放历史核验。新增一次性脚本，反查方法与核验链路本身同源：
每条 profile 在核验成功时就记录了 `code`（验证码原文）+ `messageTs`（命中消息
的 ts，与聊天库 `messages.ts` 同单位同来源）——拿这两个字段回聊天库精确反查回
当年那条消息，取它的 `sender_wxid`（非空则用）或 `chat_wxid`（1:1 会话本身即
对方 wxid）。

- **默认 dry-run**，只打印计划改什么、依据是什么（命中的 `chat_wxid`/
  `sender_wxid`/时间戳/消息片段）；`--apply` 才真的写 `profiles.json`。
- 只处理**恰好命中 1 条候选消息**的 profile；0 条（消息已超出保留窗口/被清
  理）或 >1 条（罕见但存在，比如两次核验凑巧在同一容差窗口内出现同一 6 位
  数字）一律跳过并如实打印原因，不猜。
- 只信 `is_group=0` 的候选（群消息里出现的验证码文本不能当任何人的个人 wxid），
  且排除 `chat_wxid='filehelper'`（微信内置"文件传输助手"自聊，是开发者自测
  通道，不代表任何外部用户）。
- **不在服务启动时自动跑**——这是一次性、有歧义风险的手工操作。

## 备选方案（否掉的）

1. **继续并列 OR，但对结果去重**：去重解决不了问题——去重只能合并"同一个人在
   多处被认出"的重复记录，两个不同真实人的群集合本来就该是两个不相交的结果集，
   "去重"这个动作本身预设了"这是同一个人"，正是要否掉的假设。
2. **降级路径按昵称匹配到多个人时，返回两人群聊的并集**：这正是当前生产事故的
   行为，直接否决。
3. **降级路径按昵称匹配到多个人时，任选其一（如"最近核验的那个"）**：比并集
   好，但仍然是把 A 的群聊给了 B（只是给错的概率从 100% 降到 50%）——错误的
   隐私事故没有"更小的错误"这个安慰奖，拒绝返回是唯一不会泄露的选项。
4. **回填脚本按 `chat_roster` 昵称反查**（"这个昵称在哪个群里，就把那个群的
   `member_wxid` 当成他的 wxid"）：考虑过，否决。这条路会重新踩进本记录正要
   解决的同一个坑——昵称本身不唯一，回填脚本站在和线上服务完全相同的信息位置
   上，没有更多证据去打破同名平局。验证码反查是全局唯一（6 位数字）+ 窄时间窗
   的强证据，能绕开这个歧义；昵称查询不能。
5. **`GroupCommandWatcher` 的姊妹问题留到下一次单独修**：也考虑过——但这是同一
   次调查、同一个根因（wxid/昵称并列 OR）在另一个模块的重现，且风险方向更严重
   （误投私聊消息 vs 误读群聊），没有理由现在只修一半。

## 验收标准

- `tests/wechat-log-store.test.mjs`：wxid 已知时昵称完全不参与（同名不同人不
  会被并入结果）、昵称降级路径在唯一时正常工作、昵称降级路径在歧义
  （chat_roster 里 >1 个不同 `member_wxid`）时拒绝返回且 `onAmbiguousNickname`
  可观测、`chat_roster` 里的空字符串 `member_wxid` 不会被误算进歧义判定。
- `tests/profile-verifier.test.mjs`：`chatWxid` 兜底在 `sender_wxid` 缺失且是
  1:1 会话时生效、`sender_wxid` 存在时仍然优先、群聊（`@chatroom`）的
  `chatWxid` 绝不被当成个人 wxid、不传 `chatWxid`（`LocalWechatVerifier` 的调
  用形态）时行为与改动前完全一致。
- `tests/remote-wechat-verifier.test.mjs`：候选循环命中时用该候选的
  `chat_wxid` 兜底、第一次查找命中的共享"助手"会话**不会**把自己的
  `chat_wxid` 当成任何人的 wxid。
- `tests/wechat-digest-runner.test.mjs`：昵称歧义的用户拿到的是管道已有的
  "没有可读的群" empty 结果（`ok:true, empty:true, report:null`），零 LLM
  调用——见下方"为什么是 empty 而不是新错误分支"。
- `tests/group-command-watcher.test.mjs`：已知 `sender_wxid` 时按 wxid 精确路
  由（即使同名的另一个档案排在数组前面、也有私聊通道）、`sender_wxid` 缺失且
  昵称唯一时行为不变（不回归现有功能）、`sender_wxid` 缺失且昵称歧义时拒绝
  响应（不再"挑第一个有通道的同名档案"）。
- `tests/backfill-wechat-wxid.test.mjs`：`sender_wxid` 优先/`chat_wxid` 兜底、
  已有 wxid 的 profile 跳过、缺 `code`/`messageTs` 时诚实跳过、消息找不到时诚
  实跳过、多条候选时拒绝、群聊候选被过滤掉、`filehelper` 被排除、时间容差窗口
  生效。
- 全量 `node --test "tests/*.test.mjs"`：见"未验证边界"。

### 为什么 digest 管道的拒绝路径是"正常空结果"而不是新的错误分支

`WechatDigestRunner.generate` 已经把"这个用户没有可读的群"当成正常的
`{ok:true, empty:true, report:null}`（不是订阅者的群本来就该有内容——群里没消
息/群里没有值得提取的候选，本来就是常态）。昵称歧义时 `accessibleChats` 返回
`[]`，管道在 `groups.length` 这一步就自然落进同一条路径，**不需要新代码去特判
它**。这是有意的产品判断，不只是省事：

- 对订阅者来说，"你的昵称撞车了，我们拒绝猜"和"你确实不在任何群里"应该呈现成
  同一种体验——安静地没有今天的日报，而不是一条用户自己既看不懂也处理不了的
  错误提示（"昵称歧义"对普通用户没有可操作的含义）。
- 真正需要被看到这条"拒绝"的是运维，不是订阅者——那个信号在 `WechatLogStore`
  层通过 `onAmbiguousNickname`（默认 `console.error`）已经给出，日报管道再重复
  一份只是噪音，且容易在管道层又长出一套新的错误码需要维护。
- 如果以后要把"同名歧义卡住的用户"单独运营（比如主动提醒他们联系管理员），
  该做的是订阅 `onAmbiguousNickname` 的信号做统计，而不是让每个消费方
  （digest、群命令、检索工具……）各自再判断一次"是不是歧义"。

## 遗留风险（诚实声明）

- **反查不到 wxid 的用户会一直停在降级路径上**：`scripts/backfill-wechat-wxid.mjs`
  依赖聊天库还留着当年那条验证码消息（有保留窗口/清理策略，具体多久本仓库不
  掌握）。查不到就只能停在昵称降级——如果这个昵称后来又撞上了别的新核验用户，
  会从"能看自己的群"退化成"拒绝返回"。这是本记录明确接受的代价：宁可退化成
  拒绝，也不做无凭据的猜测。
- **`sender_wxid` 在 1:1 场景经常为空的具体原因，是根据 ADR-0007 已有记录 +
  生产实测数据反推的，未能拿到 `wechat-chatlog-dsh` 仓库的 `receiver.py`/
  `sync_push.py` 源码逐行核实**（本次改动的实施环境无法访问该仓库）。如果
  未来接触到那个仓库、发现真实原因不同（比如是某个版本的回归 bug，而不是设计
  如此），`chatWxid` 兜底仍然成立（`chat_wxid` 语义是 ADR-0007 已用真实数据核
  对过的独立结论），但"为什么生产是这样"这条推断需要重新核实。
- **`GroupCommandWatcher` 的修复同样依赖 `profiles.wxid` 被正确填充**：在回填
  脚本实际跑过生产数据之前，群消息的 `sender_wxid` 匹配大概率因为
  `profile.wxid` 仍是空字符串而落不到 `byWxid` 分支，行为等价于全员走昵称降级
  路径——不是回归（不比改动前更差，改动前也是这些用户），但也意味着"wxid 精确
  路由"这条新逻辑在回填跑之前基本不会被生产流量实际命中。
- **回填脚本没有在生产数据上跑过**（本仓库本地 checkout 没有真实
  `profiles.json`/聊天库文件）：dry-run 逻辑靠单元测试（合成 sqlite fixture）
  验证，`--apply` 真实写 `data/profiles.json` 的路径未经真实数据验证。上生产前
  应该先 dry-run 跑一遍、人工核对打印的"依据"（chat_wxid/时间戳/消息片段）再
  决定是否 `--apply`。
- **核验链路的 `chatWxid` 兜底未经生产端到端验证**：`RemoteWechatVerifier`
  连的是远端 HTTP API（`/wechat-api/messages`），本记录假设该接口返回的消息行
  字段形状与聊天库 `messages` 表一致（含 `sender_wxid` 可能为空的行为）——这个
  假设基于同一个 `receiver.py` 是两者共同的权威来源（ADR-0007 已有的架构结论），
  但没有对生产 API 实际发一次新用户核验去验证下一个新核验的 profile 真的会带
  上非空 wxid。
- **`node --test "tests/*.test.mjs"` 的执行情况**：已实跑，
  `node --test --test-concurrency=1 "tests/*.test.mjs"` → **449/449 通过，
  exit 0，36s**。注意必须加 `--test-concurrency=1`：默认并行下
  `tests/poster-render.test.mjs`（真实启动 chromium 渲染）会被 60s 超时掐成
  `cancelled`；该文件单独跑 0.78s 通过，是并行争抢导致的环境性抖动，与本记录
  的改动无关。

## 上线前的生产歧义实测（2026-09-16）

本记录的收紧会让"昵称歧义"的用户从"能看到群"变成"拒绝返回"，所以上线前在
`datadefender.cn` 的真实 `chat_roster`（`/opt/wechat-sync/data/sync_inbox.db`）
上实测了歧义的实际范围：

```sql
SELECT member_display, COUNT(DISTINCT member_wxid) n FROM chat_roster
GROUP BY member_display HAVING n > 1;
-- 全库唯一命中： L | 4
```

- **全库只有一个昵称有歧义**：`L`，对应 4 个不同的 `member_wxid`。这正是本记录
  要堵的洞的真身——任何昵称为 `L` 的人核验后都会看到另外 3 个人的群。
- **三个真实已核验用户（Z.俊 / LYan_w / 老管）在 `chat_roster` 里各自唯一**
  （`COUNT(DISTINCT member_wxid) = 1`），因此收紧后**全部继续走昵称降级路径并
  正常返回群列表，无人因这次改动而失去可见性**。

即：这次收紧堵洞但不误伤存量。注意这个结论是**当前时点**的数据快照——随着新用户
核验、新群同步进来，任何昵称都可能在未来变成歧义；那时的正确解法是跑回填脚本补
上 wxid，而不是放宽匹配。
