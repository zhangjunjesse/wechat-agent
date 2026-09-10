# ADR-0009: iLink 真实文件发送（send_file）

- 状态：Accepted（协议字段已按可信参考源实现并单测验证；**真实线上发送效果待用户在微信里实测确认；getuploadurl 响应兼容 upload_full_url**，见下方"验证状态"）
- 类型：Architecture / Feature
- 日期：2026-08-26

## 问题

ADR-0008 里写"iLink 是否支持发文件/图片：未调研、未验证，仍是'不知道'"。用户明确指出这是
可以做到的，要求实现。之前 `sendText` 只用过 `item_list[].type===1`（文本），没有验证过
协议里是否存在图片/文件类型的消息项。

## 研究

没有凭空猜字段。搜到一个第三方逆向工程实现
[`photon-hq/wechat-ilink-client`](https://github.com/photon-hq/wechat-ilink-client)，
其 `src/api/types.ts` 注释明确写着"Reverse-engineered from
`@tencent-weixin/openclaw-weixin`"。这份实现里的鉴权方式和我们自己已经在跑的
`ilink-provider.mjs` **完全吻合**——同样的 `AuthorizationType: ilink_bot_token`、
同样的 `Authorization: Bearer <token>`、同样"随机 uint32 转十进制字符串再 base64"的
`X-WECHAT-UIN` 生成方式、同样的 `bot_type=3`、同样的 base URL。这种独立复现出一致的
底层签名细节，是这份参考资料可信度的有力佐证，不是随便一个网上教程。

参考实现揭示的协议关键点（`MessageItemType`）：`TEXT=1`（我们已用）、`IMAGE=2`、
`VOICE=3`、`FILE=4`、`VIDEO=5`；发送非文本消息前必须先把文件通过独立的 CDN host
（`novac2c.cdn.weixin.qq.com/c2c`）上传，上传前用 **AES-128-ECB**（PKCS7 填充）加密，
密钥和上传后拿到的下载凭证一起塞进 `sendmessage` 的 `file_item.media` 字段，接收端
凭这个密钥自行解密。完整流程：

```
1. 本地生成随机 16 字节 AES key + 16 字节 hex filekey
2. 计算明文 MD5、明文大小、密文大小（PKCS7 填充公式）
3. POST ilink/bot/getuploadurl（跟 sendmessage 同一套鉴权头）→ 拿 `upload_full_url`（当前协议优先）或兼容旧的 `upload_param`
4. AES-128-ECB 加密文件 → POST 到完整上传 URL（或旧 CDN `/upload` + upload_param+filekey）
   → 响应头 x-encrypted-param 就是接收端要用的下载凭证
5. POST ilink/bot/sendmessage，item_list: [{type:4, file_item:{media:{encrypt_query_param, aes_key(base64(hexKey)), encrypt_type:1}, file_name, len}}]
```

## 决策

### 1. 新增独立模块 `src/services/ilink-cdn.mjs`：AES 加密 + CDN 上传

纯函数，不依赖 `ILinkProvider` 的会话状态，可独立单测：`encryptAesEcb`、
`aesEcbPaddedSize`（PKCS7 填充后密文长度的预测公式——**已用真实加密结果逐一核对过**，
不是照抄公式就信了）、`uploadBufferToCdn`（POST 到 CDN，4xx 不重试直接失败，5xx 重试）。

### 2. `ILinkProvider` 新增 `sendFile()` 方法，不改动已在跑的 `sendText`

只增不改：`sendText` 一行代码没动。`sendFile({providerBotId, toProviderUserId,
contextToken, fileName, buffer})` 复用现有的私有 `#post`/`#find`（跟 `sendText` 同一套
鉴权和会话查找逻辑），只是多了 `getuploadurl` 和 CDN 上传两步。当前只实现了**通用文件
附件**（`media_type=FILE`、`item.type=FILE`）——WeChat 的"文件"类型不关心内容，docx/
xlsx/pdf/csv/zip 等任意类型都能发；**图片/视频的专门消息通道（`image_item`/
`video_item`）已由 ADR-0012 实现**，当时推测"需要缩略图等额外字段"不成立——
`no_need_thumb=true` 即可。

### 3. 新增 `send_file` 工具，按"当前对话渠道"决定能不能用

**架构缺口**：agent 的 `respond()` 之前完全不知道"这轮消息是从哪个 iLink 会话来的"——
`providerBotId`/`contextToken` 只在 `message-router.mjs` 路由层可见，从没往下传给
agent 或工具。这次补上：`message-router.mjs` 把 `channel: {type:'ilink', providerBotId,
toProviderUserId, contextToken}` 传进 `agent.respond()`，`agents-sdk-agent.mjs` 再透传进
`run(..., {context: {..., channel}})`；网页对话完全没有这个概念，`channel` 就是
`null`——`send_file` 工具据此判断能不能直接发。

`send_file` 只做"把已经用 write_file 写好的文件，通过当前微信会话发出去"这一件事：

- 不是微信对话（网页/`channel` 为空）→ 返回明确提示，引导改用 `write_file` 的下载链接
  （ADR-0008 已有，任何渠道都能用，是通用兜底）。
- 是微信对话 → 读取沙箱内文件（复用 `resolveUserPath`，跟 `write_file`/`read_file`
  同一套边界检查）→ 调 `provider.sendFile()`。
- 20MB 硬上限（保守值——这条通道是逆向出来的协议，没有官方文档给出真实上限，宁可
  保守，也不要在真实上限之外去试探）。

`write_file`/`run_code` 的下载链接（ADR-0008）**不废弃**：网页对话唯一的交付方式，
微信对话下也是 `send_file` 失败时的兜底。系统提示词更新为"微信优先 `send_file`，
其余场景用下载链接"。

## 验证状态（诚实说明，不要读成"已经在生产验证过"）

- **协议字段/请求形状**：`tests/ilink-cdn.test.mjs`（AES 加密解密互逆、填充公式和真实
  密文长度逐一核对、CDN 上传的 URL/header/重试策略）+ `tests/ilink-provider.test.mjs`
  新增的 `sendFile` 用例（mock fetch，核对 `getuploadurl`/CDN/`sendmessage` 三次调用的
  完整请求体，跟参考协议的字段名、`media_type=3`、`item.type=4` 逐一对上）——**这些都是
  针对 mock 的单测，不是真实网络请求**。
- **真实线上发送**：`contextToken` 只能从一次真实的 iLink 入站消息里拿到（当前实现
  没有像参考客户端那样缓存"最近一次 contextToken"），我这边没有可用的真实微信会话去
  独立触发一次真实调用。**这次功能是否真的能让对方在微信里收到文件，需要用户在微信
  里跟机器人实际对话一次来确认**——这不是走个形式，是因为这条路径依赖一个第三方逆向
  出来的、未经官方文档确认的协议，"字段拼对了"和"服务器真的接受并转发"是两回事。

## 备选方案（不选的理由）

- **让 `write_file` 自动在微信场景下也直接发送**：会让"写文件"和"发文件"这两个不同
  意图糊在一个工具里，模型没法只写不发（比如写中间数据）。拆成两个工具职责更清楚。
- **同时实现 image_item/video_item 的内联预览**：协议上是同一套上传管道，但要额外处理
  缩略图字段（`thumb_media`/`mid_size`），当前"发各种类型的文档"这个诉求用通用文件
  附件就能完整覆盖，先不做，需要内联图片预览时再加。

## 验收证据

- `tests/ilink-cdn.test.mjs`：6 条（AES 互逆、填充公式对真实密文校验、URL 构造、
  CDN 上传成功/4xx 不重试/5xx 重试耗尽）。
- `tests/ilink-provider.test.mjs`：新增 2 条（`sendFile` 完整请求链路字段核对、
  无绑定会话/无 contextToken 时的拒绝）。
- `tests/wechat-send-tools.test.mjs`：6 条（无渠道时的兜底提示、provider 不支持时的
  兜底提示、正常发送的参数透传、文件名覆盖、沙箱越界拒绝、超过 20MB 拒绝）。
- `tests/system-prompt.test.mjs`：工具使用规则更新为 3 条，覆盖 `send_file` 优先级。

## 遗留

- 真实发送效果需要用户在微信里实测确认（见上）。
- 仍然不能生成真正的二进制 `.docx`/`.xlsx` 文档（ADR-0005 就记录的缺口）——这次解决的
  是"文件能不能发出去"，不是"能不能生成真正的 Office 二进制格式"，两者是分开的问题。
- 图片/视频的内联消息通道（原生图片消息、可播放的视频消息）已由 **ADR-0012** 实现；
  ADR-0009 只负责通用文件附件通道。
