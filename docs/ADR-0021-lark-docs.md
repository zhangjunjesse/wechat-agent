# ADR-0021: 飞书文档读写能力（用户级 OAuth + 工具 + 动态技能）

- 状态：Accepted
- 类型：Architecture / Feature
- 日期：2026-09-15
- 关联：ADR-0013（渐进式技能，lark-docs 技能动态加载）、ADR-0003（system prompt 分层）、
  本机 lark-cli（飞书 API 协议参考）

## 问题

用户希望能在微信对话里让 AI 帮忙读写自己的飞书文档。约束：飞书 bot 身份（仅 app_id/
secret）**无法访问用户的个人云空间文档**——必须用户级授权（OAuth），且多租户下每个用户
的 token 严格隔离；能力必须以现有架构方式接入（条件注册、技能动态加载），未配置时零影响。

## 决策

### 1. 授权模型：用户级 OAuth（per-user token）

- 新增 `LarkTokenStore`（SQLite `data/larks.db`，`lark_tokens` 表按 `user_id` 主键）：
  存 access/refresh token 与过期时间；`ensureToken` 调用前自动检查过期并刷新
  （refresh 过期 → 提示用户重新授权）。
- 授权链路（对齐微信绑定体验）：用户说"连接飞书" → `lark_auth` 返回授权 URL
  （`state` 绑定 `user_id` 防 CSRF）→ 微信里点开授权 → `GET /lark/auth/callback`
  （兼容 `/wechat-agent` 子路径）用 code 换 token 入库。

### 2. API 客户端 `src/services/lark-client.mjs`

飞书开放平台直连（零新 npm 依赖，复用 fetch）：网页授权 URL、code 换 token、刷新、
读文档（`docx/v1/.../raw_content` → markdown）、搜索文档（`suite/docs-api/search/object`）、
新建 docx（`docx/v1/documents`）、追加子块（`docx/v1/documents/{id}/blocks/{parent}/children`）。
`fetchImpl` 可注入（测试 mock）。

### 3. 工具集 `src/tools/lark-tools.mjs`（条件注册）

- `lark_auth` / `lark_auth_status` / `lark_search_docs` / `lark_read_doc`（P0）；
- `lark_create_doc` / `lark_edit_doc`（P1，**写前必须 ask_user 复述确认**，产品约定）。
- **条件注册**（仿 `wechatLogStore` 模式）：仅在配置 `LARK_APP_ID`+`LARK_APP_SECRET`
  时由 `buildTools` 注册；未配置 → 整套不注册、`/lark/*` 路由 404、启动仅一条
  `lark docs disabled` warn——**生产行为零变化**（红线：现有 289 用例全绿）。

### 4. 技能动态加载（ADR-0013，不写死）

- `skills/lark-docs/SKILL.md`（frontmatter）随仓库分发 → 进 `SkillRegistry` 全局目录；
  agent 对话时 `use_skill` 目录**每轮动态携带**一句话简介，全文按需加载；不写进
  `buildBaseInstructions`/system prompt（分层不破坏）。
- 与工具分工：`lark_*` 是原子 API 工具，`lark-docs` 是编排 SOP（授权检查 → 定位 →
  读 → 写前三连确认）——与 wechat-gzh-research/gzh_* 同构。

## 备选（不选的理由）

- **bot 身份（tenant token）**：访问不了用户个人文档，与需求不符。
- **服务器上装 lark-cli 子进程**：引入外部二进制与部署复杂度；wechat-agent 直接
  HTTP 调开放平台（协议同源）更轻、可单测。
- **技能全文写进 system prompt**：违背 ADR-0013 渐进式加载，catalog 每轮动态才是现状。

## 后果

- 每个用户授权自己的飞书，token 独立存储、工具按 user_id 取用，互不串。
- 写操作（新建/编辑）强制先经 `ask_user` 确认，避免 AI 未经同意改动文档。
- 生产未配 LARK 凭证前功能休眠（条件注册 + 路由 404），配好凭证（飞书开放平台创建
  自建应用、开通 docx/drive 相关 scope、填 `LARK_APP_ID`/`LARK_APP_SECRET`、回调
  `https://datadefender.cn/wechat-agent/lark/auth/callback`）即启用，无需改代码。

## 验收证据

- `npm test`：**289/289 全绿**（279 基线回归 + 新增 10：
  lark-client 6——authUrl/extractDocId/换 token/自动刷新/readDoc/search/create/append；
  lark-tools 3——未配置休眠提示、授权 URL 绑定 state、授权状态；
  app 回调路由 1——未配置 404 / 配置 200 换 token / 缺参 400 / 前缀兼容；
  skills 1——真实仓库 lark-docs 技能可发现可加载（动态加载路径验证））。
- 红线：现有能力全部回归通过（289 中 279 为既有用例）。

## 遗留（诚实边界）

- 未配置 LARK 凭证的生产暂不启用；启用需飞书开发者后台配置（应用创建 + scope +
  回调 URL），步骤待落地时补充部署文档。
- token 明文存储（与 bindings.json 同水平），加密留后续统一做。
- 仅覆盖 docx 云文档；旧版 doc / bitable / wiki 未支持（工具如实提示）。
- 编辑能力当前为"追加子块"；按块精确修改/替换待 P2（依赖读块结构）。
