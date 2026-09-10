# Current status（会话接力文档，2026-09-10 更新）

> 任何新会话先读本文件 + 最新 ADR，即可无缝继续。本文件应保持"当前真相"，
> 每次开发后顺手更新。

## 项目

- 仓库：`C:\Users\Administrator\Desktop\wechat-agent`（git 干净，已 push GitHub
  zhangjunjesse/wechat-agent）
- 目标：多租户微信个人助手——腾讯 iLink Bot 扫码绑定 + 消息通道，OpenAI Agents
  SDK（deepseek）Agent 对话，公网同步的微信聊天记录做用户资料核验与上下文。
- 公网入口：`https://datadefender.cn/wechat-agent/`
- 测试：`npm test`（node --test，当前 **131/131 全绿**）；启动 `npm start`

## 架构速览

- 通道：`src/providers/ilink-provider.mjs`（iLink 协议，逆向自
  `photon-hq/wechat-ilink-client`）；`src/providers/weixin-web-provider.mjs`、
  `mock-provider.mjs` 为备选。
- Agent：`src/llm/agents-sdk-agent.mjs` + `src/services/message-router.mjs`
  （把 `channel`/`userId` 透传给工具）；多租户（web + iLink 统一 tenant key）。
- 能力：记忆（MEMORY-SPEC.md）、会话压缩、沙箱 run_code、文件读写、聊天记录搜索
  skill、渐进式动态技能系统、二进制文档生成、文件/图片/视频发送、公众号调研。
- 决策记录：`docs/ADR-0001` ~ `ADR-0013`，新增决策前先读 spec-loop 约定。

## 技能系统（ADR-0005/0006/0013，渐进式动态管理）

- 技能 = `skills/<name>/SKILL.md`（frontmatter：name/description/version/author/
  updated_at + 指令正文）；全局（`SKILLS_DIR`，随仓库分发）+ 用户私有
  （`data/user-skills/<userId>/`，物理隔离），per-user enable（profile.enabledSkills）。
- **渐进式加载**：system prompt 只有一行引导；`use_skill` 工具描述每轮动态携带当前
  用户技能目录（名称+一句话+版本，私有标记，cap 25 条，`name=list` 查完整目录）；
  全文按需加载，本轮去重。
- **动态管理**：`manage_skill` 工具（`ADMIN_SKILLS=1` 时注册）热增删改，校验 name/
  frontmatter/大小；放文件即生效无需重启。
- **发布路径**：L1 仓库内置（现状）→ L2 技能仓库 git 同步（`SKILLS_REPO`，未实现）
  → L3 运行时 manage_skill（已实现）。
- 已接入技能：`wechat-gzh-research`（公众号调研 SOP，编排 `gzh_search`/`gzh_content`
  两个 Node 工具直连 RedFoxHub API，`REDFOX_API_KEY` 或 `~/.qoder/apis/redfox.json`）、
  `image-studio`（图片处理 SOP：文生图/图生图/编辑/局部重绘，`image_generate` 工具，
  经 `src/services/image-api.mjs` Node 封装异步任务流程；服务器网络需用国内域名
  `TOAPIS_BASE_URL=https://toapis.cn`，直连 toapis.com 超时；key=`TOAPIS_API_KEY`）。

## 定时任务（ADR-0014，私有 + 公共订阅）

- 模型：私有任务（用户 create_task/delete_task，owner 独享）+ 公共任务
  （`deploy/global-tasks.json` 预置，`subscribe_task`/`unsubscribe_task` 订阅）。
- 调度：极简表达式 `daily@HH:MM` / `weekly@D@HH:MM` / `hourly@MM`（北京时间，
  零依赖）；`TaskScheduler` 30s tick，anchor 模型到期判定（创建/上次执行起算，
  不补跑历史周期）。
- 投递：到点 agent 执行指令（复用全部工具/技能）→ iLink 推微信；依赖
  `ContextTokenCache`（入站消息更新，落盘重启恢复）。无 token/未验证用户跳过。
- 存储：`data/tasks.db`（SQLite）。

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

- **已部署**：2026-09-10 部署到 `datadefender.cn/wechat-agent`（tgz 打包 →
  `/opt/wechat-agent/app` 挂载运行，`docker run --env-file server.env`；重建容器
  必须 `docker rm + docker run`，`docker restart` 不会重读 env-file）。
  模型 `deepseek-flash`（API 实测：可用模型仅 `deepseek-flash` / `deepseek-v4-pro`），
  `REDFOX_API_KEY` 已配置，gzh 搜索/抓正文线上实测连通。
- **DeepSeek thinking 兼容**（关键）：deepseek-flash 默认思考模式，带 tools 的多轮
  请求必须回传 `reasoning_content`（否则 400）。`src/llm/deepseek-thinking-client.mjs`
  包装 OpenAI client 按 assistant 消息顺序缓存/回填；`agents-sdk-agent` 每次 run
  前 reset，记忆/摘要用原始 client 不受影响。实测"搜苹果发布会"多轮工具调用 + 9 篇
  正文抓取全链路正常（54s）。
- **iLink 真实发送效果需要用户在微信里跟 bot 实测**（协议是逆向的，单测只证明
  字段拼对了）：① 视频是否以原生可播放消息送达 ② 图片是否原生图片消息 ③ 100MB
  上限是否接近真实限制（超大文件可能被服务器拒绝）。
- L2 技能仓库同步、技能脚本执行器抽象、用户私有技能上传接口为后续工作。
- bindings 仍是 JSON 文件存储（`data/bindings.json`），未做加密 + 未迁移真实数据库。
- 语音消息（VOICE 通道）未实现专门发送，音频走文件附件（用户未要求）。
