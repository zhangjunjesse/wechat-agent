# ADR-0007: 微信聊天记录检索技能——真实群成员权限 + 只读直连 SQLite

- 状态：Accepted
- 类型：Feature / Architecture / Security
- 日期：2026-08-25
- 相关：ADR-0005（技能隔离机制）——本记录是"阶段 A：技能绑定自己的工具"的第一个落地案例

## 问题

用户需要一个"微信聊天记录检索"能力：查自己在哪些群、按群+时间查对话、查"被@"的消息、查自己发过的消息，以及与助手的私聊。核心约束：

1. **只做检索，不做分析**——检索结果如实转述，不归纳不评价。
2. **访问范围仅限用户实际参与的群组**——不在的群不能看，这是真实的多租户数据边界，不是可选项。
3. 数据来自另一个已有系统（`wechat-chatlog-dsh` 仓库）：本地 WeChat 客户端 → `sync_push.py` 守护进程 → 服务器 `wechat-sync` 容器的 SQLite（`server/receiver.py`，`messages` 表）。

## 决策

### 1. 访问控制：真实群成员数据，不是消息内容推断

最初设计过"从消息里猜成员"（发言过 / 被@过 = 算群成员）的启发式方案，用户指出这是错的方向：WeChat 本地库本身就能读到真实花名册（`wechat-chatlog-dsh/py/api.py` 已有的 `chatroom_member`/`chat_room` 联表 / `ChatRoom.UserNameList` 解析逻辑，此前只用于反查"某几个人共同在哪些群"）。

因此改为：`api.py` 新增 `dump_chatroom_rosters()`，导出每个群的完整真实花名册；`sync_push.py` 在同一个同步循环里按 `roster_interval_seconds`（默认 300 秒）节流推送（花名义变化远没有消息频繁，没必要每 5 秒全量扫一次 `contact.db`）；`receiver.py` 新增 `chat_roster` 表，**整块替换式写入**（花名册是快照不是追加日志——退群的人必须能消失，纯 UPSERT 做不到）。这部分实现、测试、部署记录在 `wechat-chatlog-dsh` 仓库自己的提交里（`f24c5cb`、`d23dadb`），本记录只记 wechat-agent 这一侧如何使用它。

访问判定规则（`WechatLogStore.accessibleChats`）：

- **群聊**：`chat_roster` 里该用户的 wxid 或昵称是某个 `chat_wxid` 的成员。
- **与助手的私聊**：从被同步账号（即"助手"本体）的视角看，"我和用户 X 的私聊" 在 `messages` 表里就是 `chat_wxid === X 自己的 wxid`——所以用户自己的 wxid 本身就是他们私聊线程的标识，不需要花名册，也不需要额外配置。这一点用真实数据核对过（服务器上 `chat_wxid='zj391504704'` 对应昵称"Z.俊"的私聊，`sender_wxid` 与之一致）。

### 2. 不走 HTTP API，直接只读挂载 SQLite

`wechat-agent` 和 `wechat-sync` 是同一台服务器上的两个容器。给 `wechat-agent` 容器加一条只读 bind mount 指向 `wechat-sync` 的数据目录，`WechatLogStore`（`node:sqlite`，`readOnly: true`）直接对 `messages`/`chat_roster` 跑带索引的 SQL，零网络往返、零额外 HTTP 层要维护。原有 `/wechat-api/*` HTTP 接口保留给网页查看器和身份验证流程，不受影响。

不用 MCP：消费方只有 wechat-agent 自己，不是"多宿主接第三方服务"的场景，跟 `get_weather` 直连 Open-Meteo、`RemoteWechatVerifier` 直连内部 API 是同一类判断（MCP 之前已确认后置，这里没有新的理由推翻它）。

### 3. 时间精确到分钟

`YYYY-MM-DD HH:mm`（东八区）；新增 `services/time.mjs` 的 `beijingParse()`。底层 `messages.ts` 本来就是 unix 秒级精度，JS 侧统一用 epoch ms，边界处 `Math.floor(ms/1000)` 转换。

### 4. limit：由 token 预算决定，不是由查询性能决定

直连索引查询已经是毫秒级，哪怕 limit=5000 也秒回——但把 5000 条消息塞进 LLM 对话上下文会直接打爆 128K 预算。所以默认 **50** 条、上限 **300** 条，超出时明确告知"已截断，建议缩小时间范围"，而不是静默丢数据或无限增大。

### 5. 4 个工具收敛，不是 6 个

用户最初列了 6 个检索场景（群组清单/按群查/被@我/我发的/被@助手/发给助手），其中"被@助手"是"被@查"的 target 参数取值之一，"发给助手"是"按群查"里 `chat="助手"` 的特殊值。收敛为 4 个工具：`wechat_list_chats`、`wechat_search_chat`、`wechat_search_mentions`（`target` 默认"我"，可传"助手"）、`wechat_search_my_messages`。

## 备选方案

1. **消息内容启发式推断群成员**：已否决（见上，用户明确要求真实数据）。
2. **wechat-agent 通过 HTTP API 查询**（复用 `/wechat-api/messages`）：可行但要么每群一次请求（慢，对话历史长的群尤其明显），要么给 receiver.py 加更多带过滤条件的接口——重复造一层网络+鉴权，直连挂载更简单直接，选直连。
3. **给每个检索场景一个工具（6 个）**：更直白但有冗余（被@助手 vs 被@我本质同一操作），收敛成 4 个更好维护、模型选择工具时也更不容易选错。

## 后果

- `wechat-agent` 容器需要加一条只读 bind mount 才能让这组工具生效（infra 变更，见部署记录）；挂载前 `WECHAT_LOG_DB` 未配置或文件不存在时，`wechat_*` 工具直接不注册，其余功能不受影响。
- 依赖另一个仓库（`wechat-chatlog-dsh`）的 schema 稳定性——如果它改了 `messages`/`chat_roster` 的字段名，这里会静默出错而不是编译期报错。这是直连 SQLite 换来简单性的代价，目前接受，后续如需要可以加一个启动期 schema 校验。
- 检索结果里的时间戳、群名、发送人都是真实原文，不做任何总结/改写，符合"只检索不分析"的边界；SKILL.md 和工具描述里都重复强调了这一点。

## 验收证据

- `tests/wechat-log-store.test.mjs`（11 条）：跨用户群组隔离（真实 accessibleChats）、拒绝非成员访问且不泄露群是否存在、"助手"关键字解析到调用者自己的私聊线程、@提及检索、本人消息检索、时间范围过滤（秒级 ts ↔ ms 边界转换）、非文本消息类型标注、limit 封顶与截断上报、未验证身份不报错但拒绝检索。
- `tests/wechat-tools.test.mjs`（8 条）：身份从 run context 正确传递、结果格式化（时间/群名/发送人/原文）、拒绝访问的提示语、时间参数正确转换为东八区 epoch ms、截断提示透传、空结果/无身份场景处理。
- `tests/time.test.mjs`（3 条）：`beijingParse` 分钟精度、日期缺省时分的两种边界（00:00 / 23:59）、非法输入返回 null 而不是猜测。
- `npm test`：69/69 通过。
- `wechat-chatlog-dsh` 侧（另一仓库自己的提交里）：真实本地 WeChat 数据验证 14 个群花名册、真实端到端推送到生产 `wechat-sync` 容器、`messages` 表 712 条数据在 schema 迁移后完好无损。
