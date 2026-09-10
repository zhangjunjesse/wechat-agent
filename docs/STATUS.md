# Current status（会话接力文档，2026-09-10 更新）

> 任何新会话先读本文件 + 最新 ADR，即可无缝继续。本文件应保持"当前真相"，
> 每次开发后顺手更新。

## 项目

- 仓库：`C:\Users\Administrator\Desktop\wechat-agent`（git 干净）
- 目标：多租户微信个人助手——腾讯 iLink Bot 扫码绑定 + 消息通道，OpenAI Agents
  SDK（deepseek）Agent 对话，公网同步的微信聊天记录做用户资料核验与上下文。
- 公网入口：`https://datadefender.cn/wechat-agent/`
- 测试：`npm test`（node --test，当前 **112/112 全绿**）；启动 `npm start`

## 架构速览

- 通道：`src/providers/ilink-provider.mjs`（iLink 协议，逆向自
  `photon-hq/wechat-ilink-client`）；`src/providers/weixin-web-provider.mjs`、
  `mock-provider.mjs` 为备选。
- Agent：`src/llm/agents-sdk-agent.mjs` + `src/services/message-router.mjs`
  （把 `channel`/`userId` 透传给工具）；多租户（web + iLink 统一 tenant key）。
- 能力：记忆（MEMORY-SPEC.md）、会话压缩、沙箱 run_code、文件读写、聊天记录搜索
  skill、skill 系统（全局+私有+强制调用）、二进制文档生成、文件/图片/视频发送。
- 决策记录：`docs/ADR-0001` ~ `ADR-0012`，新增决策前先读 spec-loop 约定。

## 消息发送能力（ADR-0008/0009/0012）

- 文本：`sendText`（item.type=1）。
- 任意文件：`send_file` 工具按类型路由（`src/services/media-type.mjs`）：
  - 视频（.mp4/.mov/...）→ 原生视频消息（media_type=2，item.type=5，
    `video_item.video_size`=密文大小）
  - 图片（.jpg/.png/...）→ 原生图片消息（media_type=1，item.type=2，
    `image_item.mid_size`=密文大小）
  - 其余 → 文件附件（media_type=3，item.type=4，`file_item.len`=明文大小）
  - 上传管道统一：`getuploadurl`（`no_need_thumb=true`）→ AES-128-ECB → CDN
    → `sendmessage`；`src/services/ilink-cdn.mjs`
- 上限（env 可配）：普通文件 `SEND_FILE_MAX_MB`=20，媒体 `SEND_MEDIA_MAX_MB`=100。
- 网页渠道兜底：`write_file`/`run_code` 的下载链接（ADR-0008，`PUBLIC_BASE_URL`）。

## 未验证 / 待办（诚实边界）

- **iLink 真实发送效果需要用户在微信里跟 bot 实测**（协议是逆向的，单测只证明
  字段拼对了）：① 视频是否以原生可播放消息送达 ② 图片是否原生图片消息 ③ 100MB
  上限是否接近真实限制（超大文件可能被服务器拒绝）。
- bindings 仍是 JSON 文件存储（`data/bindings.json`），未做加密 + 未迁移真实数据库。
- Agent 是否已部署/更新到 `datadefender.cn/wechat-agent` 以服务器为准；本地改完
  需重新构建部署。
- 语音消息（VOICE 通道）未实现专门发送，音频走文件附件（用户未要求）。
