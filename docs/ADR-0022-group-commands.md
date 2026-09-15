# ADR-0022: 微信群命令入口——收走 wechat-sync，发走 iLink 私聊

- 状态：Accepted
- 类型：Architecture / Feature
- 日期：2026-09-15
- 关联：ADR-0007（wechat 聊天记录只读访问）、ADR-0018（日报推送，iLink 私聊通道）、
  ADR-0021（飞书文档）

## 问题

用户希望：在微信群里**引用一条消息**（如飞书文档链接）→ **@助手** → 给指令（"把这个
飞书文档下载给我"）→ bot 处理并把结果发给用户。

实测发现：iLink bot **收不到群消息**（poll 对群消息无输出；多 bot 会话还会过期），
但公网 wechat-sync 服务**实时收集用户所在群的聊天记录**（`sync_inbox.db` 只读挂载），
引用消息的完整内容就存在 `messages.attachment` 的 `{kind:'quote', quoted_text}` 里。

## 决策

### 架构：群消息入口走 sync，回复走 iLink 私聊

```
群消息（引用 + @助手）→ wechat-sync 实时入库
→ GroupCommandWatcher 轮询「已验证用户所在群、content LIKE %@助手% 的新消息」
→ 按 sender_display/sender_wxid 匹配档案（跳过无有效私聊通道的档案）
→ 解析引用（attachment.kind=quote → quoted_text）
→ 构造入站提示：场景 + 📌引用内容 + 🗣指令 + 📍出处 + 能力提示
   （引导 agent 需要时用 wechat_search_chat 自取群历史、lark_* 处理文档）
→ agent.respond（userId = profile.ilinkUserId，**与私聊同一会话键**）
→ iLink 私聊 sendText 推送给该用户
```

关键决策点：

1. **会话键统一**：群消息路径的 `userId = profile.ilinkUserId`（= 私聊的
   `providerUserId`）——群消息处理与私聊**共用同一 SessionStore/MemoryStore**，
   不会分裂成两套上下文（实测发现的问题：浏览器档案 id 与 iLink 用户 id 不同键）。
2. **身份选择策略**：同名档案可能有多个（含测试残留、无 token 的），匹配后**选第一个
   有有效私聊通道（contextToken）的档案**。
3. **只响应 @助手 + 已绑定用户**：`content LIKE '%@助手%'` 过滤；sender 未命中档案或
   无推送通道则跳过（不打扰群里所有人、不响应陌生人）。
4. **防重**：msg_id 内存去重 + ts 游标落盘；**首次启动不追溯历史**（游标=启动时刻，
   不把 8 月的"今天礼拜几"重新处理一遍）。
5. **不预取群历史**：引用内容 + 指令喂给 agent，群上下文由 agent 用 `wechat_search_chat`
   按需自取（省 token、灵活）。

## 备选（不选的理由）

- **iLink 群消息接收**：实测收不到群消息（协议/会话限制），不可行。
- **预取群历史拼入入站**：费 token、噪音大；agent 有 wechat_search_chat 工具可自取。

## 后果

- 群聊「引用 + @助手 + 指令」场景打通：收（sync）→ 解析 → agent → 私聊回复。
- 依赖：wechat-sync 正常运行（实时收集）+ iLink 私聊通道有效（contextToken）。
- 引用内容为文本链接（如飞书 docx 链接）可完整解析；引用文件/图片只有类型标签，
  无法取到文件本体（如实说明，后续可扩展）。

## 验收证据

- `npm test`：**298/298 全绿**（group-command-watcher 5 个用例：引用解析+私聊推送、
  陌生人/非@过滤、无 token 跳过、同名档案选有通道的、游标持久化不重处理）。
- 生产实测：用户在群引用飞书链接 @助手 → 私聊收到回复（链路通）。
- 会话键修复实测：群消息处理与私聊共用上下文。

## 遗留（诚实边界）

- 引用文件/图片的下载解析未支持（sync 只有类型标签）。
- 多 bot 会话过期问题仍在（iLink 协议约束，用户需重新绑定后私聊才通）。
- 回复为纯文本；"下载飞书文档为文件"依赖飞书导出 API（后续轮）。
