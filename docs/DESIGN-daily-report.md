# DESIGN：日报类公共任务——「生成一次、处处发布」管道（working proposal）

- 状态：Working（待实施；实施并验证后收敛为稳定决策 ADR-0017）
- 关联：ADR-0014（定时任务）、ADR-0003（system prompt 分层）、ADR-0008（公网下载链接）、
  ADR-0009（iLink 发送）、DESIGN-timed-tasks.md（任务模型）
- 日期：2026-09-16
- 作者：wechat-agent 开发会话

## 问题（与具体方案无关）

公共任务「每日早报」（`deploy/global-tasks.json`）当前只是一条自然语言指令，到点由
`TaskScheduler` 对**每个订阅者各跑一轮完整 agent** 并原样推送。由此产生五个真实痛点：

1. **资讯范围无定义**：模型临场发挥，今天推 AI 明天推财经，内容漂移。
2. **内容重复**：同一热点可以连续几天重复推送，没有"近 N 天已报道"的去重记忆。
3. **详略不可控**：没有固定栏目和长度约束，或罗嗦或单薄；用户想深入了解时没有途径。
4. **呈现单一**：只有纯文本，图片能力（image-studio/TOAPIS）没有用到日报上。
5. **无公网出口**：内容不可回看、不可点击展开、移动端无良好体验；也没有"追问详情"的机制。

## 提案

把日报类公共任务（`kind: 'report'`）从"每人跑一轮、文本直推"改造成一条
**生成一次、处处发布**的管道：

```
到点 → ① 一次 agent 生成（结构化 JSON，注入去重清单与范围约束）
     → ② 机械去重过滤（指纹比对近 7 天）
     → ③ 报告入库（SQLite report_store）+ 可选封面图
     → ④ 渲染三态：微信摘要文本 / 响应式公网页面 / （可选）封面图消息
     → ⑤ 向所有有效订阅者扇出投递（同一内容 + 昵称问候）
```

### 1. 任务模型扩展

`deploy/global-tasks.json` 中公共任务可带：

```json
{
  "name": "每日早报",
  "schedule": "daily@08:00",
  "kind": "report",
  "cover": true,
  "instruction": "……（生成范围/条数/输出格式说明）"
}
```

- `kind: 'report'`：走本管道的报告类公共任务（默认 `'plain'`，保持 ADR-0014 逐订阅者行为）。
- `cover: true`：让 agent 在生成日报的同一次执行里用 **image-studio 技能**出一张无文字
  封面图（可选；技能不可用/未配置 key 时降级为纯文字）。
- `TaskStore` 增加 `kind` 列（迁移：`PRAGMA table_info` 检查后 `ALTER TABLE ADD COLUMN`，
  兼容线上已有 `data/tasks.db`），`loadGlobalTasks` 同步 `kind`/`cover`。

### 2. 报告归档库 `src/services/report-store.mjs`

SQLite `data/reports.db`（node:sqlite，与 tasks/sessions 一致），两张表：

```
reports(id TEXT PK, task_id, name, run_at INTEGER, focus TEXT, raw_text TEXT,
        cover_path TEXT, items_count INTEGER, created_at)
report_items(report_id, idx, title, summary, source, url, fingerprint,
             PRIMARY KEY(report_id, idx))
```

- `id = rp-<sha1(task_id) 前 8 位>-<yyyymmdd 北京时间>`：**同一任务同一天幂等**（重跑覆盖），
  公网 URL 稳定可分享。
- `fingerprint = sha1(归一化标题)`：小写、去空白与中英文标点、保留字母数字与汉字。
- API：`saveReport`（upsert）/ `getReport` / `recentFingerprints(taskId, days=7)`
  / `listReports(taskId, limit)` / `close`。

### 3. 生成与结构化解析 `src/services/daily-report.mjs`

- **prompt 包装** `buildReportPrompt(task, recentTitles, { cover })`：保留 ADR-0014 的
  `【定时任务「name」】` 标记，追加：今日日期（北京时间）、资讯范围约束（AI/大模型/芯片/
  智能硬件为主 + 当天重要科技商业新闻，只选今/昨日新发布）、条数 5-8、**近 7 天已报道标题
  清单（去重要求，上限 20 条）**、严格 JSON 输出 schema：

  ```json
  { "focus": "今日关注点一句话", "cover": "images/xxx.png（封面相对路径）", "items": [
    { "title": "≤60字", "summary": "≤80字", "source": "来源公众号", "url": "https://…" }
  ] }
  ```

- **封面图走技能链路**（`cover: true` 时）：prompt 指示 agent 用 **image-studio 技能**
  （`use_skill` → `image_generate`，generate 模式、16:9、无文字科技感封面）在本次执行中
  出图，把工具返回的相对路径**原样**填进 JSON 的 `cover` 字段；调度器解析为沙箱绝对路径
  并确认文件存在（缺失/越界 → 纯文字降级，非致命）。不另起独立生图通道——技能链路的
  提示词与交付链路已验证，出图质量有保证（用户明确要求）。
- `parseReportJson(text)`：抽取首个 `{...}` 块 → `JSON.parse` → 校验（items 0~12 条、
  title/summary 必填且限长、url 若存在必须 http 开头、cover 为字符串）。失败返回 `ok:false`（走降级）。
- `dedupeItems(items, fingerprints)`：指纹在近 7 天集合中的条目直接删除；
  **删后不足 3 条则保留原样**（宁可有少量延续报道，不可空报）。
- `renderWeChatDigest(...)`：标题行 + 5-8 条「序号. 标题 — 摘要（来源｜链接）」+
  今日关注点 + 完整版链接 + 「可回复我追问某条详情」提示。
- `renderReportPage(report)`：移动优先的响应式 HTML（内联 CSS 零依赖，风格对齐 ui-page），
  含封面图（如有）、日期、关注点、条目卡片（完整摘要 + 可点原文链接）、底部页脚。

### 4. 调度器改造 `src/services/task-scheduler.mjs`

- 构造函数新增可选依赖：`reportStore`、`reportUrl(reportId) => string`、`reportRoot`（用户沙箱根，封面路径解析用）。
- `#runTask`：`scope==='global' && kind==='report' && reportStore` → `#runReportTask`，
  其余保持 ADR-0014 行为不变。
- `#runReportTask(task)`：
  1. `recentTitles = reportStore.recentTitles(task.id, 7, 20)` → 构造 prompt（含封面指令）；
  2. **一次** `agent.respond({ userId: 'task-'+task.id, profile: { nickname: task.name, wxid: 'task-'+task.id }, ephemeral: true, text: prompt })`
     —— `ephemeral` 新选项（见 §5）：不读写该合成用户的 session/memory，零副作用；
     合成 userId 用 `task-<id>`（无冒号，Windows 目录名安全），技能产物落盘
     `<reportRoot>/task-<id>/images/…`；
  3. 解析 → 去重 → 封面路径解析（`resolveUserPath(reportRoot, runUserId, parsed.cover)` +
     `fs.existsSync` 校验）→ `saveReport`（幂等 upsert）；
  4. 渲染一份微信摘要文本（含公网 URL）；
  5. 对每个有效订阅者（已验证 + 有 contextToken）：有封面先 `provider.sendImage`
     再 `sendText`（文本带 `greeting`：`早上好，{nickname||朋友}`）；
  6. `markRun(task.id, now, errors)` 一次；解析失败 → 降级：把原始 agent 文本直推订阅者，
     `lastError` 记 `report_unparsable`。
- **行为变更（有意为之）**：报告类公共任务从"每订阅者各跑一轮（可个性化）"变为
  "生成一次 + 扇出投递（共享内容）"。省去 N 倍 token/时间；代价是放弃逐用户内容个性化
  （作为 v2：per-user 关注领域 + 重排）。

### 5. agent 零副作用运行 `src/llm/agents-sdk-agent.mjs`

`respond()` 增加可选 `ephemeral = false`：为 true 时跳过 `sessionStore.get/append/fold`
与 `memory.absorb`，本轮 transcript 用空数组。报告生成用它，避免给 `task-*` 合成用户
留下垃圾 session/记忆。主对话路径不受影响。

### 6. 公网页面 `src/app.mjs`

- `createApp` 新增可选 `reportStore`。
- 路由（同时兼容 `/reports/<id>` 与 `/wechat-agent/reports/<id>` 前缀，同 files 路由）：
  - `GET /reports/<id>` → `renderReportPage(report)`（404 当无此报告/未配置）
  - `GET /reports/<id>/cover` → 封面图片二进制（404 当无封面）

### 7. 追问机制 `src/tools/task-tools.mjs`

新增 `get_daily_report` 工具（`taskTools` 增加 `reportStore` 依赖）：输入 `{ name?, date? }`，
默认返回该用户已订阅任务的最近一份报告（items 含完整摘要与原文链接）；agent 可据此
"展开讲讲第 3 条"（再配合现有 `gzh_content` 抓原文）。

### 8. 配置 `deploy/global-tasks.json`

「每日早报」升级为 `kind: 'report'` + `cover: true` + 结构化指令（范围/条数/JSON schema）。
`cover` 生效依赖 image-studio 技能可用的 TOAPIS key（`image_generate` 缺 key 时返回提示、
agent 填空 cover → 自动纯文字降级）。

## 备选方案（不选的理由）

- **保留"每订阅者各跑一轮"只为个性化**：成本/时间为 N 倍，且日报内容是公共新闻、
  个性化收益低；个性化作为 v2 独立做（per-user 偏好 + 内容重排）。
- **用独立 LLM 调用（不走 agent）生成**：失去 gzh_search/webFetch/技能等工具能力，
  产出质量与现状无异（ADR-0014 已论证过同类选择）。
- **图片承载正文（AI 生成长图）**：CJK 文本在 gpt-image-2 类模型渲染不可靠，
  且无法携带可点链接；图片只做封面，信息正文永远走文字。
- **服务端独立生图通道（server 直接调 image-api 生成封面）**：绕过 agent 技能链路，
  提示词质量与交付链路都弱于 image-studio 技能；封面统一交给 agent 在日报执行中
  用技能产出，调度器只做路径校验（用户明确要求走技能）。
- **cron/第三方渲染框架**：服务器零新依赖（tgz 部署不含 node_modules），响应式页面
  用内联 CSS 手写即可，不引入构建链。

## 验收标准（可观察、可证伪）

| # | 验收 | 直接证据（仓库命令/路径） |
|---|---|---|
| A1 | report 类全局任务一轮只跑**一次** agent（不是 N 次），所有订阅者收到同一份摘要 | `tests/task-scheduler.test.mjs` 新增用例：计数 agent 调用 + 断言发送文本一致 |
| A2 | 报告落库，id 按任务+日期幂等；近 7 天指纹可查 | `tests/report-store.test.mjs`（save/get/upsert/指纹/窗口） |
| A3 | 生成的摘要含公网 URL；`GET /reports/<id>` 返回含条目的响应式 HTML；无封面时 cover 路由 404 | `tests/daily-report.test.mjs`（渲染）、`tests/app.test.mjs`（路由） |
| A4 | 解析/去重：合法 JSON 入库、重复指纹被删、删后 <3 条保底不删、非法 JSON 降级直推 + `lastError` 记 `report_unparsable` | `tests/daily-report.test.mjs` + `tests/task-scheduler.test.mjs` 降级用例 |
| A5 | `cover: true` 且 agent JSON 带 cover 路径（文件存在）→ 先 sendImage 后 sendText；路径缺失/越界 → 纯文字继续 | `tests/task-scheduler.test.mjs` 封面用例（mock agent 返回 cover + 沙箱临时文件） |
| A6 | 用户任务（plain）与既有公共任务行为完全不变 | 既有 `tests/task-scheduler.test.mjs` 全部通过 |
| A7 | `get_daily_report` 返回已订阅任务的最近报告，agent 可据此追问 | `tests/task-tools.test.mjs` 新增用例 |
| A8 | 全量 `npm test` 全绿（基线 253 + 新增用例） | `npm test` |
| A9 | 线上旧 `data/tasks.db` 无 `kind` 列时启动不崩（迁移兜底） | `tests/task-store.test.mjs` 迁移用例（建旧表再 loadGlobalTasks） |

## 风险与未决

- **agent 输出不是合法 JSON**：deepseek 在复杂指令下偶发夹带文字/截断——解析失败走降级
  （直推原文），并把 `report_unparsable` 写进 `lastError` 可观测；后续可用带 schema 的
  response_format 强化（依赖网关能力，本期不做）。
- **扇出投递耗时**：N 个订阅者串行 sendText/sendImage，量大时可能拉长 tick；先串行
  （量小），量大再加并发上限（沿用 ADR-0014 的既定取舍）。
- **封面生成耗时/成本**：agent 在日报执行中经技能出图（异步任务可能数分钟、消耗额度）；
  技能失败/缺 key/路径校验不过 → 纯文字兜底，可通过 `cover:false` 关闭。
- **公网页面隐私**：报告为公共新闻内容、无个人信息；URL 用不可猜测 id。昵称问候只出现
  在微信推送文本，不进公网页面。
- **v2 明确不做**：per-user 关注领域个性化、报告订阅偏好管理、历史报告检索页。
