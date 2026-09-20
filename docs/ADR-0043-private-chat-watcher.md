# ADR-0043: 私聊消息定时巡检入口——"用户给助手发消息 = 给 agent 发消息"

- 状态：已采纳（2026-09-20）
- 关联：ADR-0022（群 @助手 入口，本机制骨架的出处）、ADR-0007（聊天记录检索与身份判定）、
  ADR-0032（身份分级匹配）、ADR-0042（agent 落库行标记 `account='agent'`）、
  ADR-0004（会话键统一）

## 问题（与方案无关的那部分）

用户在微信里给「助手」发"你好"，agent 没有反应；但网页直接对话正常。

排查定论（生产实测，2026-09-20）：
- 用户微信里的「助手」联系人**本来就没有对应的 iLink bot**（用户确认）——所以消息
  不会进 iLink 事件流，`MessageRouter`/轮询收不到；
- 但这段私聊被公网 wechat-sync **采进了同步库**：`is_group=0`、`chat_wxid=用户wxid`、
  `chat_display=用户昵称`、用户发出的行 `sender='them'`（实测 Z.俊 私聊 117 条里就有）。
- iLink bot 会话还经常过期（-14，ADR-0022 已记录），即使有 bot 也不可靠。

即：**用户发给"助手"的话，唯一可靠来源是同步库的私聊记录**，而系统当时没有任何机制
去读它。

## 决定

**新增 `PrivateChatWatcher`（`src/services/private-chat-watcher.mjs`）**：照
`GroupCommandWatcher`（ADR-0022）的骨架，加一个定时器轮询同步库里的**私聊**消息，
当作用户给 agent 发消息处理，回复经 iLink 私聊推回。

与群版的三处差异（防错杀/防循环，均为本决定的核心）：
1. **检索面**：`is_group = 0 AND sender = 'them' AND (account IS NULL OR account != 'agent')`
   ——只处理用户发出的私聊，跳过 agent 自己的回复（`sender='me'`，否则回复会被再扫到、
   无限循环），跳过 agent 落库行（`account='agent'`，ADR-0042 写的已处理行）；
2. **双通道去重**：同一条用户消息可能 iLink 收过（已回复）又被同步库扫到——处理前查
   `account='agent'` 同 chat+同内容+±60s 的行，命中即跳过，避免重复回复；
3. **身份映射**：私聊的 `chat_wxid`/`sender_wxid` 就是用户 wxid，直接命中档案（wxid
   优先、昵称降级，ADR-0032 分级），不需要群花名册。

其余（ts 游标落盘 `data/private-chat-watcher-cursor.json`、msg_id 内存去重、进度反馈、
失败收口 `failure-messaging`）与群版完全一致。装配在 `server.mjs`，依赖
`WECHAT_LOG_DB + agent`，缺失时休眠（与群版同条件）。

### 为什么不是别的做法

- **靠 iLink bot 收私聊**：用户确认「助手」联系人没有对应 bot，且 bot 会话常过期
  （-14），不可依赖；
- **让用户在网页聊天**：网页对话只是另一个入口，用户要的是**在微信里跟"助手"说话
  就有反应**；
- **直接改 MessageRouter**：路由层收的是 iLink 事件，私聊记录在同步库，两套输入源
  ——在路由层加同步库轮询会让 iLink 主链路耦合巡检逻辑；独立 watcher 与群版对称。

### 已知代价（有意接受）

1. **回复延迟 = 采集延迟**：消息要等 PC 微信采集进同步库（秒级~分钟级）才被处理，
   比 iLink 实时略慢。这是"不依赖 bot"的固有代价。
2. **双通道去重依赖内容一致**：±60s + 内容完全一致才判重；若 iLink 与采集端对同一条
   消息的文本有差异（极少），可能重复回复一次。可接受，观察后再说。
3. **只覆盖有 iLink contextToken 的用户**：发不出回复的（无活 bot token）只推进游标，
   不打扰——用户重新绑定后自然恢复。

## 验收与证据

- `npm test`：新增 `tests/private-chat-watcher.test.mjs` 6 条（私聊用户消息被处理并回复、
  跳过 `sender='me'`/`account='agent'` 防死循环、双通道去重、无 token 跳过、游标推进
  不重放、昵称降级匹配）。
- 生产实测（待补）：向同步库插入一条用户私聊 → watcher 扫到 → agent 处理 → iLink 私聊
  收到回复。

## 未覆盖

- 回复本身（`sender='me'` 的行）**不**再进检索/处理——用户与"助手"的完整对话仍靠
  ADR-0042 的落库（iLink 通道）或同步库本身（采集通道）留存。
- 群命令入口（ADR-0022）行为不变。
