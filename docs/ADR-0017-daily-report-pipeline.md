# ADR-0017: 日报类公共任务——「生成一次、处处发布」管道

- 状态：Accepted
- 类型：Architecture / Feature
- 日期：2026-09-16
- 前身：`docs/DESIGN-daily-report.md`（working proposal，已实现，本记录为稳定决策）
- 关联：ADR-0014（定时任务）、ADR-0003（system prompt 分层）、ADR-0008（公网链接）、
  ADR-0009（iLink 发送）、ADR-0013（渐进式技能，封面走 image-studio 技能）

## 问题

公共任务「每日早报」此前只是 `deploy/global-tasks.json` 里的一句话自然语言指令，
`TaskScheduler` 到点对**每个订阅者各跑一轮完整 agent** 并原样推送。五个真实痛点：
资讯范围无定义（内容漂移）、同一热点连续多天重复推送、详略不可控且无深度出口、
呈现只有纯文本、内容不可回看/展开。

## 决策

### 1. 任务模型扩展

- 公共任务配置新增 `kind`（`'report'` 走本管道；默认 `'plain'` 保持 ADR-0014 行为）与
  `cover`（布尔，是否让 agent 生成无文字封面图）。
- `TaskStore.tasks` 增加 `kind`/`cover` 列；构造时 `PRAGMA table_info` 检查后
  `ALTER TABLE ADD COLUMN` 补齐，**线上旧库（无此二列）启动不崩**。

### 2. 报告归档库 `src/services/report-store.mjs`

SQLite `data/reports.db`：`reports` + `report_items` 两表。报告 id =
`rp-<sha1(taskId)[:8]>-<yyyymmdd北京时间>`，**同一任务同一天幂等 upsert**（重跑覆盖），
公网 URL 稳定可分享。条目带标题指纹（小写 + 去空白/标点 + sha1），支撑跨天去重。

### 3. 生成与结构化（`src/services/daily-report.mjs`）

- 报告类任务一次生成：prompt 注入今日日期（北京时间）、资讯范围约束（AI/大模型/芯片/
  智能硬件为主 + 当天重要科技商业新闻、只选今/昨日新发布）、条数 5-8、**近 7 天已报道
  标题清单（上限 20，要求回避）**、严格 JSON schema（`focus`/`cover`/`items[title,
  summary, source, url]`）。
- **封面走技能链路**：`cover:true` 时 prompt 指示 agent 用 image-studio 技能
  （`use_skill` → `image_generate`，generate、16:9、无文字）出图，把工具返回的相对路径
  放进 JSON `cover` 字段；调度器解析为沙箱绝对路径并 `fs.existsSync` 校验，缺失/越界
  → 纯文字降级（非致命）。不另起独立生图通道（技能链路出图质量已验证）。
- 机械去重：生成后按指纹删除近 7 天已报道条目；**删后不足 3 条则保留原样**（不可空报）。
- 解析失败（非 JSON/空 items）→ 降级：把 agent 原始文本直推订阅者，`lastError` 记
  `report_unparsable`（可观测）。

### 4. 调度与投递（`src/services/task-scheduler.mjs`）

- `scope='global' && kind='report' && reportStore` → `#runReportTask`：
  **一次** `agent.respond({ userId: 'task-'+task.id, profile: 合成, ephemeral: true })`
  → 去重 → 入库 → 渲染一份微信摘要（含公网 URL）→ 对每个有效订阅者
  （已验证 + 有 contextToken）扇出同一份内容（昵称问候 + 有封面先 `sendImage` 后
  `sendText`）。
- `agent.respond` 新增 `ephemeral` 选项：跳过 session 读写/折叠与 memory 吸收，
  **系统侧单轮执行零副作用**（不给 `task-*` 合成用户留下垃圾 session/记忆）。
- 合成 userId 用 `task-<id>`（无冒号，Windows 目录名安全），技能产物落盘
  `<userFilesRoot>/task-<id>/images/…`。
- 用户任务与 `plain` 公共任务行为不变（逐 owner/逐订阅者各跑一轮）。

### 5. 公网出口与追问

- 新路由（兼容 `/reports/<id>` 与 `/wechat-agent/reports/<id>`）：`GET /reports/<id>`
  返回移动优先的响应式 HTML（内联 CSS 零依赖，含封面/日期/关注点/条目卡片/可点原文链接）；
  `GET /reports/<id>/cover` 返回封面图片。报告为公共新闻内容、无个人信息，URL 用
  不可猜测 id。
- 新工具 `get_daily_report`：仅返回**该用户已订阅/已创建任务**的最近报告完整条目，
  agent 可据此展开"第 N 条"（配合现有 `gzh_content` 抓原文）。

### 6. 配置

`deploy/global-tasks.json` 的「每日早报」升级为 `kind: 'report'` + `cover: true` +
结构化指令。`cover` 生效依赖 image-studio 技能可用（TOAPIS key），缺 key 时 agent
填空 cover → 自动纯文字降级。

## 备选（不选的理由）

- **保留"每订阅者各跑一轮"只为个性化**：成本/时间为 N 倍，且日报是公共新闻、个性化
  收益低；个性化作为 v2（per-user 关注领域 + 内容重排）。
- **独立 LLM 调用（不走 agent）生成**：失去 gzh_search/webFetch/技能等工具能力。
- **图片承载正文（AI 生成长图）**：CJK 文本渲染不可靠、无法携带可点链接；图片只做封面。
- **服务端独立生图通道**：绕过 agent 技能链路，提示词/交付弱于 image-studio；封面统一
  由 agent 用技能产出（用户明确要求）。
- **cron/第三方渲染框架**：零新依赖（tgz 部署不含 node_modules），页面手写内联 CSS。

## 后果

- 报告类公共任务从"N 次 agent 运行"变为"一次生成 + 扇出"：省去 N 倍 token/时间；
  代价是**放弃逐用户内容个性化**（v2 再做）。
- 输出从自由文本变为结构化 JSON + 确定性渲染：格式稳定、可入库、可去重、可公网回看。
- 封面图质量依赖 image-studio 技能链路；技能不可用时纯文字兜底，无失败路径。
- 扇出投递串行（量小）；量大时需并发上限（沿用 ADR-0014 取舍）。

## 验收证据

- `npm test`：**270/270 全绿**（基线 253 + 新增 17：report-store 4、daily-report 5、
  调度器报告管道 4、task-store kind/迁移 2、task-tools 追问 1、app 公网路由 1）。
- 关键断言（tests/）：agent 每轮只调一次并扇出同一摘要（含公网 URL）；prompt 携带
  近 7 天去重清单；解析失败降级直推 + `lastError=report_unparsable`；封面文件存在时
  sendImage 先于 sendText、缺失时纯文字；`/reports/<id>` 页面与 cover 路由 200/404；
  旧 schema 库迁移后 `kind/cover` 生效；`get_daily_report` 仅对已订阅任务可见。

## 遗留（诚实边界）

- 服务器实测定时任务触发一轮（观察真实 agent 执行 + 微信推送 + 公网页），待部署后验证。
- iLink `sendImage` 原生图片消息的真实送达效果待微信实测（协议逆向，单测只证明字段）。
- 结构化 JSON 依赖模型遵守输出格式；deepseek 偶发夹带文字时走降级直推（可观测），
  后续可用网关 response_format/schema 强化（依赖网关能力，未做）。
- 合成用户 `task-*` 沙箱里每天留一张封面图，暂不清扫（量小）。
- v2 明确不做：per-user 关注领域个性化、报告订阅偏好管理、历史报告检索页。
