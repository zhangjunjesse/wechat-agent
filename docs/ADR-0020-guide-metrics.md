# ADR-0020: 引导话术效果度量——guide_events 埋点 + 统计脚本

- 状态：Accepted
- 类型：Observability / Tooling
- 日期：2026-09-15
- 关联：ADR-0019（主题订阅与主动引导，本记录为其效果度量）

## 问题

ADR-0019 在三个入口（订阅回执、海报底部、推送短描述）放了"订阅感兴趣主题"的引导话术，
但**无法度量效果**：只能看到最终有没有人设置主题，看不到"谁收到了引导 → 多少人转化 →
哪个入口有效 → 转化花了多久"。

## 决策

### 1. 埋点：`TaskStore.guide_events` 表

- `guide_events(id, user_id, event, entry, task_name, created_at)`。
- 事件语义：
  - `guide_shown`（引导曝光）：订阅成功回执（entry=`subscribe`）、海报/短描述推送成功
    （entry=`push`，每个订阅用户每次推送记一次）；
  - `guide_converted`（主题转化）：用户通过对话设置主题成功（entry=`chat`，
    `update_report_topics` 执行处）。
- 记录方法 `recordGuideEvent`；聚合方法 `guideStats()`（漏斗 + 入口分布 + 平均转化耗时）。

### 2. 统计脚本 `scripts/guide-stats.mjs`

零依赖、可复用：
- `node scripts/guide-stats.mjs`（本地 `data/tasks.db`）；
- `TASKS_FILE=/data/tasks.db node scripts/guide-stats.mjs`（生产）。
- 输出：订阅/曝光/转化漏斗、曝光→转化与订阅→转化率、各入口曝光量、转化用户明细、
  近 7 天趋势（北京时间）。空库/旧库优雅降级（表不存在提示暂无数据，不崩）。

## 备选（不选的理由）

- **第三方分析（GA/自建埋点服务）**：量级极小（个人助手），本地 SQLite 足够，零新增依赖。
- **只查日志**：推送/回执分散在多个模块，无结构化事件，无法聚合转化漏斗与耗时。

## 后果

- 每用户每次推送多一条 `guide_shown` 写入（表极小，无性能影响）。
- 转化归因粗粒度：`chat` 入口无法区分用户是被哪个引导（回执/海报/短描述）触发的——
  当前口径"曝光（任意入口）→ 转化"足够回答总转化率与平均耗时；入口级归因需后续
  在对话层加来源标记（未做，记录为遗留）。

## 验收证据

- `npm test`：**279/279 全绿**（新增 task-store 用例：guide_events 记录 +
  guideStats 漏斗聚合：2 订阅、2 曝光用户、1 转化、入口分布 {subscribe:1, push:2}、
  转化耗时 ≥0）。
- 生产部署后 `TASKS_FILE=/data/tasks.db node scripts/guide-stats.mjs` 输出漏斗。

## 遗留（诚实边界）

- 入口级转化归因未做（对话层无法区分引导来源）；后续可在 update_report_topics 调用前
  提示用户"你是在哪里看到主题定制功能的"（成本高），或用会话上下文推断，暂缓。
- 未做文案 A/B：当前三入口共用一套文案，度量工具就绪后可按转化率迭代文案版本。
