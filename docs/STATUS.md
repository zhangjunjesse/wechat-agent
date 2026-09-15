# Current status（会话接力文档，2026-09-10 更新）

> 任何新会话先读本文件 + 最新 ADR，即可无缝继续。本文件应保持"当前真相"，
> 每次开发后顺手更新。

## 项目

- 仓库：`C:\Users\Administrator\Desktop\wechat-agent`（git 干净，已 push GitHub
  zhangjunjesse/wechat-agent）
- 目标：多租户微信个人助手——腾讯 iLink Bot 扫码绑定 + 消息通道，OpenAI Agents
  SDK（deepseek）Agent 对话，公网同步的微信聊天记录做用户资料核验与上下文。
- 公网入口：`https://datadefender.cn/wechat-agent/`
- 测试：`npm test`（node --test，当前 **278/278 全绿**）；启动 `npm start`

## 架构速览

- 通道：`src/providers/ilink-provider.mjs`（iLink 协议，逆向自
  `photon-hq/wechat-ilink-client`）；`src/providers/weixin-web-provider.mjs`、
  `mock-provider.mjs` 为备选。
- Agent：`src/llm/agents-sdk-agent.mjs` + `src/services/message-router.mjs`
  （把 `channel`/`userId` 透传给工具）；多租户（web + iLink 统一 tenant key）。
- 能力：记忆（MEMORY-SPEC.md）、会话压缩、沙箱 run_code、文件读写、聊天记录搜索
  skill、渐进式动态技能系统、二进制文档生成、文件/图片/视频发送、公众号调研。
- 决策记录：`docs/ADR-0001` ~ `ADR-0016`，新增决策前先读 spec-loop 约定。

## 记忆系统 v2（DESIGN-memory-lifecycle.md：三层压缩 + 档案层）

- **设计已定稿**：完整 proposal（自评审 1 blocker + 8 major 已修订）、13 条验收、P0-P5 分期；
  参数已拍板（活跃 24h / 不活跃 7 天维护、归档阈值 7/15 天、档案 ≤800 字）。
- **P0 已完成**（192/192 全绿）：
  - `buildExtractPrompt` v2：3 天重要性门槛 / episodic 收紧（流水账不提取）/ todo 门槛
    （明确要求才提）/ 交互偏好引导（结构化回复、要多选项与证据、诚实说明边界）/ 称呼去重 /
    新增 `emotion`（0-1 情感强度，供第一层评分）。
  - `memory-store` v2：**逐列迁移**（7 新列）+ 3 新表（`archived_memories` 二级存储 /
    `memory_profiles` 派生档案 / `memory_maintenance` 脏标记）+ 归档/恢复/合并/档案/访问统计 API。
  - `memory-pruner`：todo 过期（due 超期 >7 天）与老化（无 due 且 >15 天未更新）→ **归档**
    （不物理删除，可回滚）；identity/preference/fact 永不自动清理。
  - `delete_todo` 工具：用户显式删除 → 物理删除（隐私优先），与 pruner 的归档语义区分。
- **P1 已完成**（208/208 全绿）：
  - `memory-importance`：**四因子评分**——类别基线（identity 1.0/preference 0.9/todo 0.8/
    fact 0.6）+ 访问频率（5 次饱和）+ 时间衰减（**按类别分半衰期**：identity/preference 不衰减、
    fact 180 天、episodic 45 天，加 `DECAY_FLOOR=0.35`）+ 情感强度（缺失按 0.3 中性基线）+
    信息独特性（3-gram Jaccard，按码点切分）；归档路径 `archiveLowImportance`（保护栏 +
    14 天最小年龄 + 归档可回滚）。
  - **重要修正**：归档阈值由 0.25 改为 **0.30**——可达性推导发现 fact 的最低可达分是 0.28，
    原阈值配 `<` 判断**永不触发**（首层形同虚设）。推导表见 DESIGN §4.2。
  - recall：只注入 active 卡（归档/合并卡不再出现）+ **回写访问统计**（frequency 因子的唯一来源）。
- **踩坑记录**：
  1. 老库迁移时 `idx_memories_active`（引用 `status` 新列）必须在补列之后再建，
     否则 `CREATE TABLE IF NOT EXISTS` 阶段直接 `no such column: status` 启动失败。
  2. 评分阈值/权重必须做「可达性推导」，否则规则静默失效（已加参数回归守卫测试）。
  3. 测试涉及时间的用例一律以 `Date.now()` 为基准做相对偏移，硬编码日期会在 7/15 天边界假失败。
- **P2 已完成**（223/223 全绿）：
  - `memory-cluster`：**种子扩张聚类**（与种子 Jaccard ≥0.35 且簇内平均 ≥0.30，簇上限 12）
    ——刻意不用连通分量（会在 `subject='用户'` 下因传递性连成巨型簇）；LLM 打包判定
    （`<group>` 分隔，PACK_MAX 6 组/批）；**三重安全网**：cardIds 必须落在同一预聚簇 +
    信息保留校验（日期归一化 / 数字 / 字母词 / 跨卡共享 3-4 字中文实体覆盖率 ≥50%）+
    合并只标记不动原文；幂等（原卡 merged 后自动退出候选）。
  - 实施期修正：原设计的「≥3 字中文串 + 覆盖率 80%」实测两处都不对（整串会因改写失配；
    2 字片段会把「需要」当实体导致抖动）→ 改 3-4 字片段 + 通用字过滤 + 阈值 0.5。
- **P3 已完成**（234/234 全绿）：
  - `memory-generalize`：**第三层抽象泛化**——候选簇要求 ≥3 条同类 episodic 且时间跨度
    ≥3 个北京时间日历天（同一天的重复不算"多次经历"）；LLM 提炼 semantic/procedural
    （procedural 落库带「流程：」前缀、只是知识不是指令）；产物 `kind='generalized'`、
    `type='semantic'`、`category` 沿用来源、`source_ids` 完整可追溯；**反空泛校验**
    （与来源事实 ≥2 个 3-gram 重叠，或命中字母词），拦住「用户关注工作」式空话；
    低价值来源卡（importance<0.4）归档为 `generalized_source`，高价值来源保留。
  - 实施期修正：反空泛校验原设计复用"实体片段覆盖率"，实测会杀掉**合格**的抽象泛化
    （泛化本就要改写措辞）→ 改 3-gram 重叠计数。
- **P4 已完成**（243/243 全绿）：
  - `memory-profile`：**四段式档案**（工作背景/个人背景/当前关注/近期动态，对齐 WorkBuddy 的
    「时间稳定性 + 用途」分块）——**派生视图**（删掉可重建，version 递增）；生成前排除助手
    自称名（单一来源 = `assistantName()`）；active 卡片 <5 条不生成；总长 ≤800 字。
  - recall **分层注入**：`[用户档案]`（≤1200 token）→【泛化】（≤800）→【待办】（上限 20 条 +
    溢出提示）→【新近】（**档案生成时间之后**的增量，与档案零重叠）；无档案时回退到旧的
    分节行为（灰度/回滚安全）。
  - 实施期修正：**档案独立于卡片**——active 卡片为空但档案存在时仍注入档案（原实现直接
    返回空串，会把档案丢掉）。
- **P5 已完成 → 记忆系统 v2 全部落地（ADR-0016 Accepted）**（249/249 全绿）：
  - `memory-maintenance`：轻量路径挂 `absorb()`（本轮评分 + todo 归档 + 脏标记，无 LLM）；
    重量路径 tick 每 6h → **活跃 24h / 不活跃 7 天兜底** → 评分刷新 → 归档 → 聚类 → 泛化 →
    档案重建；单用户串行（`#running`）、步骤间失败隔离、结果写 `memory_maintenance.last_result`。
  - `server.mjs` 接线（`MEMORY_MAINTENANCE=0` 可关）；`SIGTERM/SIGINT` 停维护器。
  - **真实数据端到端回放**（线上 `memories.db` 副本，不碰生产数据）：19 条 → 评分 19 /
    归档 0 / 合并 0 / 泛化 0 / **档案 978 字四段齐全**（`profile: ok`）。0 动作是正确的
    「宁缺毋滥」——Z.俊 那 13 条非 todo 卡片主题各异，确无重复可合。
  - **已部署**：2026-09-15 部署到 `datadefender.cn/wechat-agent`（旧版备份
    `/opt/wechat-agent/app.bak-20260915-memv2`）。
- **⚠️ 关键运维发现（记忆侧 LLM 必须关闭思考）**：`deepseek-flash` **默认思考模式且思考计入
  `max_tokens`**——真实长 prompt（19 条记忆）一次思考消耗 **1600-1800 tokens**，`max_tokens`
  不足时返回 `finish_reason=length` 且 **content 为空**（表面症状："档案 unparsable"、
  "提取什么都没提取到"，极易误判为 prompt 问题）。顶层参数 **`reasoning_effort: 'none'`
  确实关闭思考**（实测 reasoning 261 → 0、completion 24 tokens，省约 10 倍；`extra_body` 里的
  `chat_template_kwargs` / `thinking` / `reasoning_effort` **均无效**）。记忆侧所有调用已统一走
  `src/llm/memory-complete.mjs`（关思考 + 网关不认该参数时自动回退），主对话保留思考能力。
- **P5 后自审补强（2026-09-15，253/253 全绿）**——自审发现设计写了但实现缺失的三处，已补齐：
  - **A1 档案漂移检测**：`source_count` 原先只写不读 → `isDue()` 增加漂移判定
    （卡片变化 ≥`MEMORY_PROFILE_DRIFT`(8) → 提前重建，1h 冷却）。
  - **A2 快照语义**：`runUser()` 显式取快照并记录 `snapshotSize`；补验收 13 的测试
    （维护运行期间写入的新卡保持 active、不被归档/合并——走真实 `MemoryClusterer` + await 间隙插入）。
  - **A3 维护日志**：`last_result` 从纯计数改为 JSON（summary + 归档/合并/泛化各前 3 条明细 +
    跳过原因 + errors），出问题可回溯「具体动了哪几条」。
  - **顺序修正（重要）**：重量维护步骤改为 **评分 → 归档 → 泛化 → 聚类 → 档案**——原顺序
    聚类在前，会把泛化要用的同类事件样本先合并掉，**第三层被第二层饿死**（线上副本实测
    `generalized` 0 → 调整后 1）。
- **三层压缩真实验证**（线上库副本 + 造三类场景数据）：归档 2（500 天前重复卡，importance 0.28）/
  合并 2（3 条同类事件→1 条且**保留全部日期**；2 条近似重复 fact→1 条）/ 泛化 1
  （「用户需要持续跟进昆山农商项目群中 ZK 发布的"行员信息同步模板"相关消息与文件」，sources=3）/
  档案 ok。提取侧同时验证：emotion **0.8**（过敏）、due **2026-09-23**（下周三）、
  category **preference**（"习惯先看摘要再看全文"）。
- **仍未自然触发的边界（诚实记录）**：Z.俊 的真实卡片主题各异，归档/合并/泛化在日常数据里
  **没有自然发生**（0 动作是正确的 no-op）；三层压缩的真实验证依赖造场景数据。长期行为需
  在日常使用中观察。
- **后续可调优（非决策变更，参数即可）**：评分权重/半衰期、归档阈值 0.30、todo 7/15 天、
  维护 24h/7 天、漂移阈值 8 条、档案 1100 字——全部集中为常量 + env 可覆盖，按真实反馈微调。
- **仍待用户实测**：iLink 真实对话下的长期行为（记忆是否被过度归档、泛化产出质量随时间的
  变化）；Z.俊 存量垃圾 todo（8/25 那批）会在其下次对话时由 pruner 自动归档。

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

## 日报管道（ADR-0017 + ADR-0018，图文一体海报化）

- 公共任务新增 `kind: 'report'`（默认 `'plain'` 保持旧行为）；`TaskStore` 自动补列迁移，
  旧库启动不崩。
- 报告任务执行 = **一次** agent 生成（ephemeral 零副作用执行，合成用户 `task-<id>`）
  → 结构化 JSON（`focus`/`items`）→ 近 7 天指纹机械去重（删后 <3 条保底不删）→ 入库
  `data/reports.db`（`ReportStore`，id 按任务+日期幂等）→ **海报渲染**（ADR-0018）→
  向订阅者推送「海报长图 + 短描述（含公网 URL）」。
- **海报 = HTML 排版 → CDP 无头浏览器截图**（`src/services/poster-render.mjs`）：
  纯 CSS 科技风头图、新闻卡片（只显示来源名不显示裸 URL）、自动量高全页截图。
  浏览器：系统 chromium/chrome/edge 或 `@sparticuz/chromium`（Linux 容器）。
- **技能化**：`skills/poster-render/SKILL.md` + 工具 `render_poster`（agent 对话可用，
  与 image-studio 分工：信息排版图 vs 视觉图）。
- 解析失败降级：直推 agent 原文 + `lastError=report_unparsable`；海报渲染失败降级纯文本。
- 公网页：`GET /reports/<id>`（响应式 HTML）+ `/poster`（海报 PNG）+ `/cover`（兼容旧封面），
  兼容 `/wechat-agent` 子路径。
- 追问：`get_daily_report` 工具（仅已订阅/已创建任务的最近报告）→ agent 可「第 N 条展开讲讲」。
- **主题订阅（ADR-0019，per-user 严格隔离）**：用户可对自己的公共任务设置关注主题
  （`update_report_topics`/`list_report_topics` 工具；对话里说「订阅 AI 主题」即完成）。
  到点生成 = 公共版一次（无主题订阅者共享）+ 每个有主题用户**单独生成**贴合自己主题
  的日报（prompt 注入主题、报告/去重按用户维度隔离、海报标题带主题徽标、公网链接独立）。
  主动引导三入口：订阅回执提示、海报底部引导行、推送短描述。
- 设计/决策：`docs/DESIGN-daily-report.md` → `docs/ADR-0017-daily-report-pipeline.md` +
  `docs/ADR-0018-poster-render.md` + `docs/ADR-0019-report-topics.md`。
- **已部署 + 实测**（2026-09-15，两轮）：生产 `datadefender.cn/wechat-agent` 已上线
  （源码挂载 `/opt/wechat-agent/app`，`docker restart` 生效，env 零改动）：
  - 第一轮：海报 750×2414（7 条 AI/科技要闻）→ 推送成功（`lastError` 空）；
  - 第二轮（字体重渲染）：**中文完美**（容器装 `fonts-noto-cjk` + commit 镜像
    `wechat-agent:chromium`），7 条全新新闻（科创板日报/TechWeb/财联社AI daily…，
    与第一轮不重复 = **去重生效**），`GET /reports/<id>/poster` HTTP 200；
  - 实测踩坑已修：容器无中文字体→豆腐块（装 fonts-noto-cjk）；headless shell
    `--dump-dom` 不可用→改 CDP；browser ws 无 Page 域→attachToTarget(flatten)；
    root 需 `--no-sandbox`。
  - 已知小瑕疵：海报曾含 emoji（📰/🎯）在容器缺 emoji 字体时为方框 → 已改纯文字/CSS
    图标，明天 08:00 轮生效；今日已发海报主体正常。

## 会话时间感知（ADR-0015）

- 问题：transcript 无时间戳，模型感知不到"距上次对话多久"，隔天对话生硬接续旧话题。
- 方案：信息 + 用法两层——动态层 `buildGapLine`（间隔 >2h 注入「距上次对话：4 天 3 小时。」，
  阈值 `GAP_THRESHOLD_MS` env 可配）+ 静态层 `PACE_RULES`（对话节奏规则）。
- **集中管理**：全部收敛在 `src/llm/conversation-pace.mjs`，改文案/阈值只动这一个文件；
  `humanizeGap` 在 `src/services/time.mjs`。时间源复用 `sessions.updated_at`，存储零改动。

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
- **日报管道待上线实测**：部署后验证——① 每日早报 08:00 真实触发一轮（agent 执行 +
  微信推送 + 公网页 `/reports/<id>` 可访问）② 封面图经 image-studio 技能的出图效果
  与 sendImage 送达 ③ 连续多天内容去重是否有效。
- L2 技能仓库同步、技能脚本执行器抽象、用户私有技能上传接口为后续工作。
- bindings 仍是 JSON 文件存储（`data/bindings.json`），未做加密 + 未迁移真实数据库。
- 语音消息（VOICE 通道）未实现专门发送，音频走文件附件（用户未要求）。
