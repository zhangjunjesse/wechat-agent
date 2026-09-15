# ADR-0018: 日报图文一体海报——HTML 渲染长图 + poster-render 技能

- 状态：Accepted
- 类型：Architecture / Feature
- 日期：2026-09-15
- 关联：ADR-0017（日报管道，本记录**部分替换**其封面/推送条款）、ADR-0013（技能系统）、
  ADR-0014（定时任务）
- 前身：ADR-0017 的「封面走 image-studio 技能」与「微信摘要文本」条款

## 问题（ADR-0017 上线实测的反馈）

1. 微信推送形态是「一张 AI 封面图 + 一堆摘要文本 + 裸 URL」——**图片与文字分离**、
   URL 原文直接展示，用户体验差（用户明确不满："图片意义是什么？文字格式乱七八糟"）。
2. 用户要的是**图文一体的日报海报**：文字在图片上，微信一张图看完；「想看更多」走
   公网页链接（图片没有超链接，链接放推送的短描述文本里）。

## 决策

### 1. 海报 = HTML 排版 → 无头浏览器截图（不是 AI 生图）

- 新增 `renderReportPoster(report)`（`src/services/daily-report.mjs`）：750px 宽海报
  HTML，纯 CSS 科技风头图（渐变+网格+光效，无外部图片）、关注点横幅、新闻卡片
  （序号/标题/摘要/**来源公众号名，不出现裸 URL**）、底部居中提示。
- 新增 `src/services/poster-render.mjs`：HTML → PNG 长图渲染服务，用 **CDP**
  （Chrome DevTools Protocol）：spawn 无头浏览器 `--remote-debugging-port=0` →
  `Target.attachToTarget(flatten)` → `Emulation` 设宽度 → `Runtime.evaluate` 量内容
  高度 → `Page.captureScreenshot(captureBeyondViewport=true)` 全页截图（自动量高，
  无截断/空白）。**不依赖 `--dump-dom`/`--screenshot` 命令行开关**（headless shell
  上不可靠，实测踩坑）。
- 浏览器探测顺序：`CHROME_PATH` > 系统 chromium/chrome/edge（Windows 开发机）>
  **`@sparticuz/chromium`**（Linux 容器兜底：serverless 无头 chromium，npm 包自带
  运行库）。容器内 root 运行需 `--no-sandbox`。

### 2. 微信推送 = 海报长图 + 短描述

- 推送改为：`sendImage`（海报 PNG，原生图片消息）+ `sendText`（短描述：报告名已送达 +
  公网 URL + 「第 N 条展开讲讲」提示）。**摘要正文只出现在海报里，文本不再复述**。
- 解析失败降级：直推 agent 原文（不静默丢失），`lastError` 记 `report_unparsable`。
- 海报渲染失败（无浏览器等）：降级为纯文本短描述，任务不失败（非致命）。
- 废弃 ADR-0017 的「封面走 image-studio 技能」（agent JSON 不再带 cover；
  `TaskScheduler` 不再解析 cover；prompt 不再要求出封面图）。

### 3. 海报渲染技能化（用户明确要求）

- 新增技能 `skills/poster-render/SKILL.md`（随仓库分发）+ 工具 `render_poster`
  （`src/tools/poster-tools.mjs`）：任意 agent 对话可把 HTML 渲染成海报 PNG
  （输出到用户沙箱 + `send_file` 交付）。
- 技能与 `image-studio` 分工：信息排版图（文字必须清楚）→ poster-render；
  视觉插画/抽象封面 → image-studio。

### 4. 运行时依赖与持久化

- 服务器容器（Debian bookworm）需要：`@sparticuz/chromium`（npm，装进 app/
  node_modules）+ 其运行系统库（libnss3/libnspr4/…，apt）+ **中文字体**
  `fonts-noto-cjk`（apt）——无字体则中文渲染为豆腐块（生产实测踩坑）。
  已 `docker commit wechat-agent:chromium` 固化（重建容器须用该镜像或重装依赖+字体）。
- `ReportStore.reports` 新增 `poster_path` 列（自动迁移），存海报 PNG 绝对路径
  （`/data/reports/<id>.png`，落持久卷）；新路由 `GET /reports/<id>/poster` 可回看海报。
- env 零改动（WORKDIR=/ 使 `data/reports` 落 `/data` 持久卷）。

## 备选（不选的理由）

- **AI 生图直接产出图文海报**：CJK 文字渲染不可靠（乱码/豆腐块），无法精确排版与转义。
- **wkhtmltoimage**：几 MB 但老 WebKit 不支持 flex/grid，海报布局会乱。
- **命令行 `--screenshot`/`--dump-dom`**：完整版 Chrome 可用，但 headless shell
  （@sparticuz/chromium）实测 `--dump-dom` 无输出、相对截图路径解析失败——改 CDP 一次解决。
- **容器装完整 chromium（apt）**：Debian bookworm 已移除 chromium 包；@sparticuz/chromium
  是轻量替代（自带 headless shell + 运行库，只需补系统库与字体）。

## 后果

- 微信日报形态 = 一张图文一体海报 + 一条短描述：信息密度高、无裸 URL、可点公网页深读。
- 海报渲染依赖无头浏览器与中文字体：缺失时降级纯文本（可观测），不影响报告生成与入库。
- 渲染成本：每天一次，CDP 一次性进程几秒，空闲零占用；磁盘 ~372KB/天。
- `get_daily_report`/公网页/去重/幂等机制不变（ADR-0017 保留条款）。

## 验收证据

- `npm test`：**274/274 全绿**（新增 poster-render 真实渲染集成测试——本机 Chrome
  走 CDP 出 PNG 并校验尺寸/魔数；renderReportPoster 断言无裸 URL/无完整版字样/无 AI
  图/转义；调度器海报用例 sendImage 先于 sendText、渲染失败降级；report-store poster
  列迁移）。
- 生产实测（2026-09-15）：报告生成 → CDP 渲染海报（750×2618 PNG）→ `sendImage` +
  `sendText` 推送 Z.俊 成功（`lastError` 空）；公网 `GET /reports/<id>/poster`
  HTTP 200 image/png；去重机制实测生效（同任务同日重跑，条目与上一轮不重复）。
- 踩坑记录（已修复）：容器无中文字体 → 中文豆腐块 → apt 装 `fonts-noto-cjk` + commit
  镜像；headless shell `--dump-dom` 无输出 → 改 CDP；browser 级 ws 无 Page 域 →
  `Target.attachToTarget(flatten)` + sessionId；root 需 `--no-sandbox`；相对截图路径
  解析失败 → `path.resolve`。

## 遗留（诚实边界）

- 海报含 emoji（📰/🎯）在容器缺 emoji 字体时显示为方框 → 已改纯文字/CSS 图标
  （明天 08:00 轮生效；今日已发海报主体正常，两个小方框可接受）。
- 重建容器须用 `wechat-agent:chromium` 镜像（含字体+依赖）或重新 apt 安装——已写入
  `deploy/DEPLOY-daily-report.md`。
- `render_poster` 工具面向 agent 对话的生成效果待真实对话实测。
- 服务器重启后 `docker commit` 的镜像若丢失需重做；长期建议改为 Dockerfile 固化依赖。
