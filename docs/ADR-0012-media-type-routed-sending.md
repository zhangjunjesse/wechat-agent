# ADR-0012: 按媒体类型路由的任意文件发送（视频/图片原生消息通道）

- 状态：Accepted
- 类型：Feature / Architecture
- 日期：2026-09-10

## 问题

ADR-0009 实现的 `send_file` 把所有文件都走 FILE 附件通道（`media_type=3`、
`item.type=4`），且工具层有 20MB 硬上限。用户在微信里实测的感受是"agent 只能发
txt 文件"：视频（通常远大于 20MB）直接触顶被拒；即使小于 20MB 的视频作为 FILE
附件发出，微信里也只是"文件"而不是可播放的视频卡片。需求是**任意文件都能发，
包括视频**。

## 研究

`photon-hq/wechat-ilink-client`（ADR-0009 同一个可信参考源）在
`src/media/send.ts` + `src/media/upload.ts` 里给出了完整的媒体路由实现，与我们
已实现的 FILE 通道共用同一套上传管道（`getuploadurl` → AES-128-ECB 加密 → CDN
POST → `sendmessage`）：

- **视频**：`getuploadurl` 用 `media_type=2`（VIDEO）；`sendmessage` 的 item 用
  `type=5` + `video_item: { media: {encrypt_query_param, aes_key,
  encrypt_type:1}, video_size: <AES 填充后的密文大小> }`。
- **图片**：`getuploadurl` 用 `media_type=1`（IMAGE）；`sendmessage` 的 item 用
  `type=2` + `image_item: { media: {...}, mid_size: <密文大小> }`。
- **不需要缩略图**：参考实现的 `getuploadurl` 请求传 `no_need_thumb: true`，
  `video_item`/`image_item` 里都不带 `thumb_media`。ADR-0009 里"视频/图片需要
  额外缩略图字段、收益不确定"的推测不成立——管道本身已经通用，只差按类型分流。

路由规则（参考实现 `sendMediaFile`）：`video/*` → 视频消息；`image/*` → 图片
消息；其余 → 文件附件。

## 决策

### 1. `ILinkProvider` 拆出公共媒体上传管道，新增 `sendVideo` / `sendImage`

`sendFile` 的公开签名和行为不变（仍发 FILE 附件）。内部提取一个私有
`#uploadMedia({mediaType, ...})`（`getuploadurl` + CDN 上传，返回
`{downloadParam, filesize}`），三个公开方法各自构造 item：

- `sendFile` → `media_type=3`、`item.type=4`、`file_item.len=明文大小`（现状不动）
- `sendVideo` → `media_type=2`、`item.type=5`、`video_item.video_size=密文大小`
- `sendImage` → `media_type=1`、`item.type=2`、`image_item.mid_size=密文大小`

`aes_key` 一律 `base64(hex 密钥)`、`encrypt_type=1`、`no_need_thumb=true`，与
ADR-0009 完全一致。视频/图片/文件的 `media` 字段形状相同，只有
`video_size`/`mid_size`/`len` 的取值（密文 vs 明文）和所在 item 不同——这是
参考实现逐字段核对的结果，不是猜测。

### 2. `send_file` 工具按文件名类型路由

新增纯函数模块 `src/services/media-type.mjs`：
`classifyMediaType(fileName) → 'image' | 'video' | 'file'`（按扩展名白名单，
`file` 为兜底）。`send_file` 执行时按结果调用 `provider.sendImage` /
`provider.sendVideo` / `provider.sendFile`；provider 缺对应方法时降级为
`sendFile`（保证旧 mock / 兼容性）。

### 3. 分类型大小上限（可配置）

- 普通文件：保持 20MB 默认（`SEND_FILE_MAX_MB`，ADR-0009 已验证通道，文档类
  极少超限，维持保守值）。
- 视频/图片：默认 100MB（`SEND_MEDIA_MAX_MB`）——媒体天然大，20MB 会让视频
  功能名存实亡；100MB 对齐微信生态常见文件上限。仍是逆向协议，超限返回明确
  错误并引导用 `write_file` 下载链接兜底，不静默失败。

### 4. 工具描述同步更新

`send_file` 的 description 明确"视频会以微信视频消息（可直接播放）发送、图片
以图片消息发送、其余以文件附件发送"，让模型知道该工具现在能交付视频。

## 后果

- 微信侧：视频收到的是原生视频消息（可播放/转发），图片是原生图片消息，文档
  仍是文件附件。
- 网页侧无变化：仍走 `write_file` 下载链接（ADR-0008），`send_file` 在非微信
  渠道的行为不变。
- 上限提高带来的风险是"接近真实线上限制时发送失败"——失败是显式错误返回，可
  提示改用下载链接，不会损坏数据。
- 语音（VOICE 通道）仍以文件附件发送，未实现专门语音消息（用户未要求；参考
  实现也未实现 VOICE 发送，留待需要时再加）。

## 验收证据

- `tests/media-type.test.mjs`（新）：扩展名分类表（视频/图片/其他）。
- `tests/ilink-provider.test.mjs`（增）：`sendVideo` / `sendImage` 完整请求链路
  核对——`media_type`、`item.type`、`video_size`/`mid_size` 等于 AES 填充后的
  密文大小、`aes_key` base64、`encrypt_type=1`；`sendFile` 既有用例不变仍通过。
- `tests/wechat-send-tools.test.mjs`（增）：`.mp4` 路由到 `sendVideo`、`.png`
  路由到 `sendImage`、`.csv` 仍走 `sendFile`；视频超过 100MB 拒绝；provider 缺
  `sendVideo` 时降级 `sendFile`。
- `npm test` 全绿。

## 遗留（诚实边界）

- 与 ADR-0009 相同：协议字段来自可信参考源 + 单测，**真实视频/图片发送效果需要
  用户在微信里跟 bot 实测确认**（视频是否原生播放、100MB 上限是否接近真实限制）。
- 视频时长/编码转码、缩略图生成不在本次范围。
