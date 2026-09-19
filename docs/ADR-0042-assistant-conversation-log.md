# ADR-0042: 助手把自己的对话落库——"用户跟助手的对话"要能被自己读到全量

- 状态：已采纳（2026-09-19）
- 关联：ADR-0007（聊天记录只读访问 + 私聊线程判定）、ADR-0025（工具失败不得破坏主流程）、
  ADR-0004（会话键统一）、ADR-0039（channel 透传）
- 取代：无。本文补充 ADR-0007 的**读侧数据来源**，不改变它的访问判定。

## 问题（与方案无关的那部分）

用户问"我跟助手说过什么"时，助手答不全。这不是理解问题，是数据问题：

| 来源 | 用户消息条数 |
|---|---|
| 助手侧会话记录（`sessions.db`，全量） | **191** |
| 微信侧同步库（`sync_inbox.db`，wechat-sync 写入） | **71** |

**差 120 条读不到**（生产实测，用户 Z.俊，2026-09-19）。

根因：采集账号是**副设备登录**（`account = wxid_6y9h8ldxbe2p22_5711`）。微信不给副设备
回补历史文字，PC 端只留本机实际收发过的消息——所以那条私聊在同步库里长期只有零星几条
（实测 118 条里绝大多数是分享的文件/链接，纯文字极少）。

两条外部来路都探过，都是死的：
- **微信侧回补历史**：副设备拿不到，见上。
- **iLink 侧取历史**：`ilink-provider.mjs` 只有 `pollEvents/sendText/sendFile/...`，
  **没有任何历史消息接口**。

## 决定

**由助手自己把往来对话写进 wechat-sync 的库**（同库同表，读侧零改动）。

数据本来就在助手手里——它逐条处理过每一句话。缺的只是它没把自己这段落库。

- 新增 `src/services/conversation-log.mjs`（`ConversationLog`）：`recordInbound()` /
  `recordOutbound()`，写成 `chat_wxid = 用户 wxid`、`chat_display = 用户昵称`、
  `sender = them|me`、`account = 'agent'`（与 wechat-sync 的行区分，便于单独统计/清理）。
  行格式与读侧判定完全对齐，所以 `wechat_search_chat("Z.俊")`／`("助手")` 直接就能读到。
- 埋点（`message-router.mjs`，三处，全部吞异常）：入站消息落一条；任务受理回执落一条；
  **真正发出去之后**才落助手回复（否则库里会出现用户从没收到过的"回复"）。
- 装配：`app.mjs` 的 `buildConversationLog()`，仅在配了 `WECHAT_LOG_DB` 时启用。
- 部署：`/opt/wechat-agent/app/deploy/docker-compose.yml` 里那条同步库挂载从 `:ro`
  改为可写（原注释写明"Read-only access … for the wechat-search skill"，现需写入，
  注释同步更新）。

### 为什么不是别的做法

- **让 wechat-sync 回补历史**：副设备物理上拿不到，做了也是空的。
- **让读侧同时读 `sessions.db`**：会话记录是滚动窗口的原始 transcript（`role/content`），
  没有时间戳、没有消息类型、没有附件引用；要它扮演"聊天记录"得先补一整套元数据，
  而且仍然绕不开"谁在什么时刻说的"这个只有消息通道才知道的事实。写进同步库反而更简单、
  且自动获得现成的检索/时间过滤/权限判定。
- **给 agent 单独开一张表 + 专用工具**：等于把"用户跟助手的对话"变成第二种形态，
  以后每个读侧功能（日报、检索、@提及）都要分叉。

### 已知代价（有意接受）

1. **只覆盖今后**。那 120 条历史补不回来（微信侧没有）。它们仍留在会话记录里，
   通过会话记忆参与对话，但不进检索。
2. **同步库从只读变可写**，两个写入方（wechat-sync + 助手）共用一个 SQLite。
   风险控制：单条 `INSERT OR IGNORE` + `busy_timeout=4000`；任何写失败只记一次日志，
   绝不外抛；库不可写（挂载忘了改、磁盘满）时整体退化为 no-op，功能消失而回复正常。
3. **测试里出现"同秒两条排序不稳"**：`ts` 是秒级精度，所以测试给显式时间戳。
   生产不受影响（一问一答天然跨秒；同秒内先用户后助手，靠 `msg_id` 去重而非排序）。

## 验收与证据

- `npm test` **538/538**（新增 `tests/conversation-log.test.mjs` 4 条：写入能被读侧按昵称
  与"助手"两条入口读到、同内容重复写只留一条、库不存在/只读/空内容都不抛、
  缺 `chatWxid` 时整体停用）。
- **生产端到端实测（2026-09-19）**：容器内 `ConversationLog` 写两条 → `enabled = true`、
  `recordInbound/recordOutbound` 均返回 `true` → `WechatLogStore.searchChat({chat:'Z.俊'})`
  立刻读回这两条（助手回复在列）。挂载确认 `/wechat-sync-data RW=true`；
  容器重建后 `wechat-agent listening on http://0.0.0.0:8789`、公共任务正常加载。
- 部署注意：该库原来由 `docker run` 手工起（容器无 compose 标签），本次也按原方式重建，
  `docker compose up` 会因 Dockerfile 的 `npm ci` 失败而不可用（与本改动无关）。

## 未覆盖

- 那 120 条历史（见代价 1）。
- 群命令入口（`group-command-watcher.mjs`）的往来目前不落库——群里 @助手 的对话
  已经在同步库里（wechat-sync 采得到），不重复写。若将来发现群里漏采，再按同一机制补。
