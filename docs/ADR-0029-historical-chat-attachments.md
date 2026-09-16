# ADR-0029: 历史聊天附件安全取回——按"会话+时间"定位，绝不接受裸 media_id

- 状态：Accepted
- 类型：Feature / Security boundary
- 日期：2026-09-16
- 关联：ADR-0007（wechat_search_chat 检索边界）、ADR-0010（入站附件下载与沙箱）、
  ADR-0012（媒体类型分类）、ADR-0022（群命令入口）、ADR-0030（看图理解，复用本记录的取回结果）
- 触发：用户反馈"agent 说看不到聊天记录里的文件内容，但公网浏览器（wechat-sync 自带页面）
  能看图、能下载"

## 问题

排查后确认三条完全独立的代码路径在读同一份数据（`wechat-sync` 的 `sync_inbox.db`），
但只有一条把内容真正交给了模型：

| 路径 | 对附件做了什么 |
|---|---|
| `wechat-sync` 自带网页 `/wechat-view` | 读 `messages.attachment` JSON，按 kind 渲染 `<img>`/下载链接，图用全局密钥 `k` 直读磁盘解密后的原文件 |
| `WechatLogStore`（agent 检索工具的数据源） | SQL **没有 SELECT `attachment` 列**；非文本消息一律塌缩成写死占位符 `[图片]`/`[语音]`/`[分享/文件]` |
| `GroupCommandWatcher`（群 @助手 入口） | 有读 `attachment`，但只处理 `kind==='quote'`；图片/文件/视频/分享链接一律静默忽略 |

数据从未缺失，只是检索层直接把它扔了。

## 决策

### 1. `WechatLogStore` 补上 attachment 解析

检索 SQL 加 `attachment` 列；新增导出函数 `parseAttachment(raw)`——白名单解析（未知字段丢弃、
非 JSON/缺 `kind` 一律返回 `null`，调用方回退占位符），按 kind 归一化字段：

- `image`/`file`/`video`/`voice`/`sticker` → `mediaId`/`ext`/`size`/`filename`/`available`/`reason`
- `link` → `title`/`url`；`quote` → `reply`/`quotedName`/`quotedText`；`merged` → `title`/`preview`

`formatResult` 渲染改为有意义的描述（`[文件 季度总结.pdf 2.3MB]`、未同步时如实说明原因），
不再是死板占位符。

### 2. 新工具 `wechat_fetch_chat_file`：按"会话 + 消息时间"定位，不接受裸 media_id

这是本 ADR 的核心安全设计：**工具参数是 `chat`（会话名）+ `time`（消息时间戳），不是
`media_id`**。执行时重新走一遍 `WechatLogStore.searchChat`（与检索工具同一套
`accessibleChats` 租户校验），只有校验通过后、agent 自己确实能看到的那条消息里解析出的
`media_id` 才会被用来定位文件。media_id 本身是全局命名空间（不分用户），如果工具直接接受
模型传来的裸 id，等于绕开"用户只能看自己所在会话"这层边界——这正是不选"暴露
`wechat-sync` 全局密钥链接"方案的同一个理由（见下）。

同一分钟内最多取回 5 个附件（可用 `filename` 过滤）；`link` 直接把 URL 递出（本来就是公开
信息，不用落盘）；`available:false`（还没同步完成）如实说明原因，不假装成功。

### 3. 新服务 `wechat-media.mjs`：本地只读文件拷贝，不新增任何挂载/接口

`fetchChatMedia()` 的数据源是宿主机 `/opt/wechat-sync/data/media/<media_id>.<ext>`——
与 `sync_inbox.db` **同一个早就挂载好的只读目录**（`deploy/docker-compose.yml` 的
`/wechat-sync-data:ro`）。本次改动 wechat-sync 仓库一行未动、没有新增挂载、没有新增
HTTP 往返、没有用 wechat-sync 的全局访问密钥——直接 `fs.copyFile` 到当前用户的沙箱。

落盘目标复用 **ADR-0010 入站附件的同一个 `inbox/` 目录**：`MAX_INBOUND_FILE_BYTES`（50MB）
与文件名清洗逻辑从 `ilink-media.mjs` 提取为导出函数（`sanitizeInboundName`），两条入口
（用户刚发的附件 / 历史聊天取回的附件）共用同一套边界，落地后 `read_file`/
`image_generate`/`send_file` 天然可用，不需要新增任何"这个文件从哪来"的分支逻辑。

### 4. `GroupCommandWatcher` 补齐附件识别

此前只认 `kind==='quote'`，其余静默丢弃。现在 `image`/`file`/`video`/`voice`/`sticker`/`link`
都会在入站 prompt 里如实描述"这条消息带了一个 xx 附件"，并附上 `wechat_fetch_chat_file`
所需的 `chat`/`time` 参数提示——**要不要真的取回由 agent 自己判断**，watcher 只负责让
agent 知道"这里有个东西"，不强制调用。

## 为什么不直接把 wechat-sync 的 `/wechat-media/<id>?k=<全局密钥>` 链接发给用户

那个 `k` 是 wechat-sync 的**账号级主密钥**，能看到**所有用户的所有聊天记录**，不区分租户
（wechat-agent 自己调 `/wechat-api/*` 时也是用这同一把密钥）。把它拼进聊天回复发出去，
等于把"看所有人聊天记录"的钥匙交给了这一个用户——与 ADR-0001/0005/0007 反复强调的多租户
边界（"用户只能看自己所在会话"）直接冲突，不能这么做。

## 备选（不选的理由）

- **让 wechat-sync 新增一个按用户签发 token 的接口**：wechat-sync 是通用归档服务，不该学
  wechat-agent 的租户模型；且 wechat-agent 已经能直接读同一个挂载的文件，没必要为此新增
  一层网络往返和另一个仓库的改动面（`wechat-chatlog-dsh`/`wechat-sync` 本机没有 checkout，
  不在这次改动范围内）。
- **让模型直接传 `media_id` 当参数**：media_id 是全局命名空间，会绕开租户边界，等于开天窗——
  这是本 ADR 明确拒绝的方案，不是疏漏。

## 验收证据

- `node --test tests/*.test.mjs` → **364/364 全绿**（基线 345 + 本次新增 19，其中与本 ADR
  直接相关 9 条：`wechat-tools.test.mjs` 5——`formatResult` 渲染有意义描述、`wechat_fetch_chat_file`
  取回文件落进调用者沙箱、**跨租户访问被真实拒绝**（用真实 `WechatLogStore` 验证 A 用户取不到
  B 用户群里的附件，不是 mock 出来的假通过）、未同步附件与 link 直通如实回应、非法时间格式
  与空结果窗口的清晰提示；`group-command-watcher.test.mjs` 2——媒体附件在 prompt 里带取回
  提示且不影响原有 quote 行为、未同步/link 场景如实处理；`wechat-log-store.test.mjs` 2——
  `parseAttachment` 按 kind 白名单解析、`available:false` 保留原因与不可解析时安全回退）。
  其余 10 条属于 ADR-0030（看图理解），一并列在该记录。
- 生产媒体挂载路径人工核对：`wechatMediaDir` 的计算默认值
  `path.dirname(WECHAT_LOG_DB) + '/media'` 在生产容器内解出 `/wechat-sync-data/media`，
  目录存在且有真实文件（如 `007f189bb818d4a205904fa9.png`）——**不需要新增任何 env 变量**
  即可在生产直接生效，`WECHAT_MEDIA_DIR` 仅作为可选覆盖项存在。

## 遗留（诚实边界）

- **非图片文档仍读不懂内容**：`wechat_fetch_chat_file` 能把 docx/pdf/视频/语音取回并转发
  （`send_file`），但 agent 自己依然读不懂里面写了什么——`read_file` 只按 UTF-8 文本读，
  二进制文档会是乱码。这是用户最初"帮用户处理所有聊天记录里面的文件"里明确没有兑现的一部分，
  参见 ADR-0030 的遗留说明（该记录只解决了"图片"这一类）。
- **合并转发消息（`kind:'merged'`）只有标题/预览**：内部消息列表未展开解析，用户要看完整
  内容仍需自己去 wechat-sync 网页查。
- **未取回操作没有用量上限**：`wechat_fetch_chat_file` 每次最多 5 个附件，但没有"这个用户
  今天已经取了多少次"的节流——目前风险可接受（单次拷贝是本地文件系统操作，成本极低），
  留作后续观察项。
