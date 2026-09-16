# Current status（会话接力文档，2026-09-10 更新）

> 任何新会话先读本文件 + 最新 ADR，即可无缝继续。本文件应保持"当前真相"，
> 每次开发后顺手更新。

## 项目

- 仓库：`C:\Users\Administrator\Desktop\wechat-agent`（git 干净，已 push GitHub
  zhangjunjesse/wechat-agent）
- 目标：多租户微信个人助手——腾讯 iLink Bot 扫码绑定 + 消息通道，OpenAI Agents
  SDK（deepseek）Agent 对话，公网同步的微信聊天记录做用户资料核验与上下文。
- 公网入口：`https://datadefender.cn/wechat-agent/`
- 测试：`npm test`（node --test，当前 **364/364 全绿**）；启动 `npm start`

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
- **主题订阅（ADR-0019 per-user 隔离 + ADR-0027 按主题独立成篇）**：用户可对自己的
  公共任务设置关注主题（`update_report_topics`/`list_report_topics` 工具；对话里说
  「订阅 AI 主题」即完成；上限 `MAX_REPORT_TOPICS=5`，与工具文案一致）。
  到点生成 = 公共版一次（无主题订阅者共享）+ 有主题用户**每个主题各自独立生成**一份
  （不合并）：各自 prompt、各自去重窗口（`{userId, topic}` 双维度）、各自海报（标题
  只显示自己那一个主题）、各自一条推送——订阅 N 个主题 = 当天收到 N 条独立推送。
  一个主题生成失败不连累同一用户的其他主题。`get_daily_report`/`resend_daily_report`
  不传 `topic` 时默认覆盖当天全部主题（追问列全部/补发发全部），传了只处理那一份。
  设置主题的确认话术如实告知"这 N 个主题会各自独立推送"，不再暗示"合并成一份"。
  主动引导三入口：订阅回执提示、海报底部引导行、推送短描述。
  触发：用户反馈"订阅了多个主题，为什么每天还是只有一份日报"——三个方案（保持
  1 份+保底名额 / 每主题独立 / 1 份但分区展示）当面征询后用户选择"每主题独立"。
- **引导效果度量（ADR-0020）**：`guide_events` 埋点（曝光 `guide_shown`：subscribe/push；
  转化 `guide_converted`：chat）+ `scripts/guide-stats.mjs` 统计脚本（漏斗/入口分布/
  平均转化耗时/7 天趋势；生产 `TASKS_FILE=/data/tasks.db node scripts/guide-stats.mjs`）。

## 飞书文档读写（ADR-0021，用户级 OAuth + 动态技能）

- **授权**：用户级 OAuth（bot 身份访问不了用户个人文档）——`LarkTokenStore`
  （`data/larks.db`，per-user token 自动刷新）+ `lark_auth`（授权链接，state 防 CSRF）
  + `GET /lark/auth/callback` 回调换 token。
- **工具**：`lark_auth` / `lark_auth_status` / `lark_search_docs` / `lark_read_doc` /
  `lark_create_doc` / `lark_edit_doc`（写前 ask_user 确认）；`src/services/lark-client.mjs`
  直连飞书开放平台（零新 npm 依赖）。
- **技能**：`skills/lark-docs/SKILL.md` 走 ADR-0013 动态加载（use_skill 按需，不写死 prompt）。
- **休眠开关**：条件注册——未配置 `LARK_APP_ID`/`LARK_APP_SECRET` 时整套不启用
  （工具不注册、路由 404、行为零变化）；配好即用，需飞书后台配回调
  `https://datadefender.cn/wechat-agent/lark/auth/callback`。
- 决策：`docs/ADR-0021-lark-docs.md`。

## 微信群命令入口（ADR-0022，收走 wechat-sync / 发走 iLink 私聊）

- iLink bot 收不到群消息（实测），但公网 wechat-sync 实时收集用户所在群的聊天记录
  （含引用消息完整内容 `attachment.kind=quote → quoted_text`）。
- `GroupCommandWatcher` 轮询 sync 库「@助手 的新消息」：按 sender 匹配已验证档案
  （选有私聊通道的那个）→ 解析引用 → 构造入站提示（场景+引用+指令+出处+能力提示）→
  agent 处理（userId = profile.ilinkUserId，**与私聊同一会话键**）→ iLink 私聊推送。
- 只响应 @助手 + 已绑定用户；msg_id 去重 + ts 游标落盘；首次启动不追溯历史。
- 生产实测：群引用飞书链接 @助手 → 私聊收到回复 ✓。决策：`docs/ADR-0022-group-commands.md`。

## 长任务进度反馈（ADR-0023，通用体验）

- 问题：指派任务后要等几分钟才响应，期间零反馈 → 用户不安/焦虑。
- `createProgressNotifier`（入口层共用，不依赖模型）：**8 秒延迟 ack**（短任务不打扰）
  + **40 秒心跳**（最多 5 条）+ **失败必告知**（不再静默）；私聊 `MessageRouter` 与群
  命令 `GroupCommandWatcher` 共用。
- agent 侧新增 `notify_user` 工具（多步任务主动汇报进度，一次最多 2-3 次）+
  `PACE_RULES` 第 4 条长任务节奏规则。
- 决策：`docs/ADR-0023-long-task-feedback.md`。

## 任务委派（ADR-0024，主 agent 秒回 + 后台子 agent）

- 主 agent 用 `delegate_task` 把「自包含+多步+耗时」任务派给后台子 agent，**工具立即返回**
  「已派发任务 #N」→ 主 agent 秒回用户、继续接待其他消息；子任务结算时**无条件通知用户**
  （成功/失败/超时都通知，`notified` 位防重）。
- 关键实现：每子 agent **独立 AgentsSdkAgent 实例**（各自 thinking 缓存，避免 400）、
  `ephemeral` 执行（不污染用户 session/记忆）、**受限工具集**（有 `send_file`/`notify_user`，
  无 delegate/task 工具防递归）、每用户并发 2 + 队列排队、单任务超时 300s（env 可配）。
- 任务管理：`TaskRunStore`（SQLite `data/task-runs.db`；状态机 pending→running→
  done|failed|timeout|cancelled，首次结果优先、终态 7 天归档）+ 工具 `list_tasks`/
  `task_status`/`retry_task`；与用户 `todo`（记忆系统）职责分离（"要做什么" vs "做到哪了"）。
- 判断力三层：~~四条硬判据（工具描述 + `skills/task-delegation` 技能 SOP，ADR-0013 动态加载）~~
  → **已被 ADR-0025 重构：判据 = 操作类型清单，写进 `delegate_task` 工具描述 + `PACE_RULES`
  第 4/5/6 条（每轮必然可见）；skill 降级为细节手册（goal 模板/汇报话术/反例）**
  + **校准**（`stats()` 短任务派发率/失败率、用户纠正写记忆、并发/超时 env）。
- 依据 DSH 真实实现（三份研究报告 `docs/research-dsh-*.md`）；与 DSH 的有意偏离（落库/队列/
  禁递归/通知带摘要）见 ADR-0024。ADR-0023 的定期心跳收敛为"兜底 ack + 失败必告知"。
- 决策：`docs/DESIGN-task-delegation.md` → `docs/ADR-0024-task-delegation.md`。

## 委派判据重构（ADR-0025，2026-09-16）

- 事故：用户"把这个飞书文档下载给我" → 主 agent 没派发，自己在主对话里等 `lark_export_doc`
  （异步导出 10–60 秒），用户连问"在吗/好了吗"。agent 自述"只有一次工具调用，不算多步"。
- 根因：① 判据用错代理指标（"≥3 次工具调用 / ≥30 秒"漏判**单步但慢**的操作）；
  ② 判据放在按需加载的 skill 里 = 默认缺席，而每轮在场的工具描述里没判据；
  ③ 没有"动手前先 `list_tasks`"的规则 → 任务多轮长大时每轮重复自己干；
  ④ 派发路径可见性低于自己动手 → 用户压力把 agent 逼回自己做。
- 改法：判据改为**操作类型清单**（导出/下载文件、批量处理、生成文档图片、多篇抓取汇总、
  等外部异步接口）；判据搬进 `delegate_task` 工具描述 + `PACE_RULES` 第 4/5/6 条；
  `lark_export_doc`/`image_generate` 自声明"慢工具，单次调用也卡对话"；
  `list_tasks` 双用途（派发前查重）；`list_tasks`/`task_status` 输出**已用秒数**；
  `DELEGATE_MIN_SECONDS` 删除。
- 验证：`node --test tests/delegate-tools.test.mjs` **7/7**（新增 2 条防回归断言）。
- 决策：`docs/ADR-0025-delegation-criteria.md`（部分取代 ADR-0024 的判断力条款）。
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

## 日报可靠性修复（ADR-0026，2026-09-16）

- 事故（双重）：① 8:00 报告因 `402 Insufficient Balance`（切模型网关前的旧账号
  欠费）失败，调度器把失败也当结算处理，`last_run_at` 推进到"今天"，模型切换
  修好问题后**没有任何机制推动重试**，用户当天彻底没收到早报；② 用户说"日报
  补发一下"，agent 把它路由到为"追问细节"设计的 `get_daily_report`（纯文本工具），
  模型自己现编了一整段回复——旧日期内容、夹 Markdown（微信不渲染，裸符号见客）、
  每条带原文裸链接，"图+短描述"设计被完全绕开。
- 修法 1（调度失败重试）：`TaskStore` 新增 `attempt_count`/`last_attempt_at`，
  `markRun`（结算：推进锚点+归零计数）与 `markAttemptFailed`（只记尝试，不结算，
  任务仍"到期"）分离；调度器按 `retryIntervalMs`（默认 20 分钟）节流、当天最多
  `retryMax`（默认 3）次重试，全失败才放弃等明天；区分**生成失败**（值得重试）与
  **投递失败**如会话过期（重试没用，不占预算，直接结算，省无意义的 LLM 调用）；
  失败话术如实反映"会自动重试"或"今天放弃、明天再来"，不再是没人会照做的
  "请稍后重试"。
- 修法 2（补发不给模型现编的机会）：新增 `resend_daily_report` 工具，直接调
  `provider.sendImage`+`sendText` 重发**真实存过的海报文件+标准短描述**；短
  描述提取为共享纯函数 `renderPushText(report,{reportUrl,topics,resend})`，原始
  推送与补发共用同一份措辞，不再各写一套。`get_daily_report` 收窄为"只答细节"，
  去掉条目原文裸链接，description 里明确指向 `resend_daily_report`。
- 验证：`node --test tests/*.test.mjs` → **336/336 全绿**（新增 6：失败重试到
  放弃结算的完整生命周期、重试中途成功即结算、生成/投递失败区分、
  `resend_daily_report` 真发图+文、降级/拒绝分支、`renderPushText` 两种变体）。
- 决策：`docs/ADR-0026-report-reliability.md`。
- 遗留：9/16 当天报告的旧失败记录发生在新代码部署前，新的重试逻辑不会自动
  追溯重跑，需要一次手动触发补齐（见部署记录）。

## 日报按主题独立成篇（ADR-0027，2026-09-16）

- 触发：用户提问"订阅了多个主题，每天还是只会有一个日报？？？我理解订阅几个
  就有几个啊"——ADR-0019 的"多主题"其实是合并进**一次**生成，由模型自行权衡
  各主题名额，没有保底，用户订阅了却感觉不到区别。
- 这是产品判断（直接决定用户每天收到几条推送、系统成本涨几倍），当面给了三个
  方案（1 份+保底 / 每主题独立 / 1 份分区展示）征询，用户选**方案 2：每主题独立**。
- 改法：调度器对有主题的用户，从"1 次调用带全部主题"改为"每个主题各自 1 次独立
  调用"（各自 prompt/去重窗口/海报/推送，一个主题失败不连累其他主题）；
  `ReportStore` 加 `topic` 维度（`reports.topic` 列 + `reportIdOf`/`recentFingerprints`/
  `recentTitles`/`listReports` 全部按 `{userId, topic}` 双维度隔离，不传 topic 时哈希
  与 ADR-0019 时代完全一致，老数据不受影响）；`get_daily_report`/`resend_daily_report`
  新增可选 `topic` 参数，不传时默认覆盖当天全部主题；主题上限从代码里实际的 10
  收紧到工具文案早就承诺的 5（`MAX_REPORT_TOPICS`）；`update_report_topics` 确认话术
  改为如实告知"这 N 个主题会各自独立推送，你每天收到 N 条"，不再暗示"合并成一份"。
- 验证：`node --test tests/*.test.mjs` → **342/342 全绿**（基线 336 + 新增 6：
  report-store 2、task-scheduler 2、task-tools 1、task-store 1；另有对既有测试
  追加的确认话术/主题徽标断言，不计入新增用例数）。
- 决策：`docs/ADR-0027-per-topic-reports.md`（延伸 ADR-0019 的 per-user 隔离到
  per-user-per-topic）。
- 遗留：效果未经生产实测；没有做"多主题但合并成一份"的中间态退路。

## 日报调度可靠性（ADR-0028，2026-09-16）

- 触发：用户问"很多人都订阅、都在 8 点执行，会不会崩溃"——排查确认不会因
  并发/内存崩溃（tick 串行、LLM 单实例串行队列、海报渲染一次性子进程，三处
  天然把并发钳死在 1），但顺藤摸出两个真问题。
- 问题 1（正确性 bug）：ADR-0026 的重试判定是任务级全有全无（"一份都没成功"
  才重试），而 ADR-0027 之后一个任务一轮有多个独立生成单元（公共版 + 每个
  (用户,主题)）——部分成功部分失败时，任何一个单元成功就整任务结算，失败
  单元既不重试，其用户还收到过"系统会自动重试"的**虚假承诺**。修法：重试
  判定下沉到单元级——`TaskStore` 新增 `retry_units` 列（JSON 数组，记录还在等
  重试的单元及各自尝试次数，公共版用 `userId=''/topic=''` 表示，跨 tick 落库），
  首轮跑全部单元、重试轮**只重跑挂着的单元**（已成功的用户绝不重复推送），
  所有最初尝试过的单元都成功或耗尽后任务才整体结算（`markRun` 一并清空单元
  状态）；失败话术按该单元自己的重试余量措辞，不拿别的单元的命运替它承诺。
- 问题 2（延迟风险）：`TaskScheduler` 与私聊 `MessageRouter`/群命令
  `GroupCommandWatcher` 共用主 `AgentsSdkAgent` 实例 = 共用一条串行执行队列，
  8 点批量日报生成会把实时聊天堵在队列后面（订阅规模上去后忙碌窗口分钟级）。
  修法：调度器独享一个 `AgentsSdkAgent` 实例（隔离手法同 ADR-0024 的委派
  子 agent，但语义不同：**全量工具集** + 同一份 `sessionStore`/`memoryStore`
  ——`#runForUser` 写用户真实会话历史，数据源必须一致，分开的只有队列）。
- 验证：`node --test tests/*.test.mjs` → **345/345 全绿**（基线 342 + 新增 3：
  task-scheduler 2——部分失败只重试失败单元且已送达用户不被重复推送、单元
  连续失败到耗尽收到"今天不再重试"并整体结算；task-store 1——`retry_units`
  状态机）。ADR-0027 那条"部分失败"测试的结算断言随语义修正（原断言锁的
  正是本次要修的 bug 行为）。
- 决策：`docs/ADR-0028-report-scheduler-reliability.md`。
- 遗留：忙碌窗口只是被隔离没有被缩短（生成总量仍随订阅数线性涨）；投递失败
  仍不重试（维持 ADR-0026 区分）；队列隔离效果未经生产高峰实测。

## 历史聊天附件安全取回（ADR-0029，2026-09-16）

- 触发：用户反馈"agent 说看不到聊天记录里的文件，但公网浏览器能看图/能下载"——排查发现
  数据从未缺失：`WechatLogStore` 检索 SQL 压根没 SELECT `attachment` 列，非文本消息一律
  塌缩成写死占位符 `[图片]`；`GroupCommandWatcher` 只认 `kind==='quote'`，其余静默丢弃。
- 新增 `parseAttachment()`（`wechat-log-store.mjs`，白名单解析 image/file/video/voice/
  sticker/link/quote/merged 各自字段）+ 新工具 `wechat_fetch_chat_file`：**按"会话+消息
  时间"定位、绝不接受裸 media_id**——重新过一遍 `searchChat` 的租户校验（`accessibleChats`），
  只有 agent 自己真能看到的那条消息里解析出的 media_id 才会被用来找文件，防止全局命名空间
  的 media_id 穿透"用户只能看自己所在会话"的边界。
- 新服务 `wechat-media.mjs` 直读 `/wechat-sync-data/media/<media_id>.<ext>`（与
  `sync_inbox.db` 同一早已挂载的只读目录，wechat-sync 仓库零改动、不新增挂载/接口/密钥），
  落盘到与 ADR-0010 入站附件**同一个** `inbox/` 沙箱（`MAX_INBOUND_FILE_BYTES`/
  `sanitizeInboundName` 从 `ilink-media.mjs` 提取为共享导出函数）。
- 明确不选"直接转发 wechat-sync 的 `/wechat-media/<id>?k=<全局密钥>` 链接"——那把密钥能看
  所有用户的所有聊天记录，转发等于把"看所有人聊天"的钥匙发给单个用户，与 ADR-0001/0005/
  0007 的多租户边界冲突。
- 验证：`node --test tests/*.test.mjs` → **364/364 全绿**（新增 9 条与本记录直接相关，含
  一条**用真实 `WechatLogStore` 验证跨租户访问被拒绝**的用例，非 mock 假通过）；生产
  `wechatMediaDir` 默认值（`WECHAT_LOG_DB` 同目录下的 `media/`）人工核对存在且有真实文件，
  **不需要新增任何 env 变量**即可生效。
- 决策：`docs/ADR-0029-historical-chat-attachments.md`。
- 遗留：非图片文档（docx/pdf/视频/语音）能取回+转发但 agent 仍读不懂内容（图片这部分由
  ADR-0030 补齐）；合并转发消息只有标题/预览；取回操作暂无节流。

## 看图理解（ADR-0030，2026-09-16）

- 问题：agent 对图片只有转发（`send_file`）和变换（`image_generate` edit/inpaint），完全
  没有"看懂图里是什么"的能力——ADR-0010 时代就存在的缺口，这次因 ADR-0029 让"取历史图片"
  变容易了才被真正摸到。
- 新增独立 `VisionClient`（`src/services/vision-client.mjs`）：单轮、无工具、标准 OpenAI
  vision content block，直连 `${OPENAI_BASE_URL}/chat/completions`，**刻意不接
  `deepseek-thinking-client`/`AgentsSdkAgent` 主链路**（那条链路因 DeepSeek
  `reasoning_content` 强制回传已出过三次生产 400；视觉是一次性单轮问答，生产网关人工
  冒烟实测 `reasoning_tokens:0`，没理由沾那套复杂度）。60 秒超时、无重试、无 session。
- 新工具 `image_describe`（`image-tools.mjs`）：读用户沙箱图片（不区分入站收到的还是历史
  聊天取回的，同一个 `inbox/` 目录天然通用），先用 `classifyMediaType`（ADR-0012）拦非图片
  路径。**条件注册**（同 lark/wechat_* 的 fail-closed 模式）：未配置 `VISION_MODEL` 时
  `vision=null`，工具压根不出现在列表里，不是"存在但报错"。
- 模型选型依据：部署前对生产真实网关+key、`model=gpt-5.6-terra` 做了一次人工冒烟（自动化
  测试按项目纪律一律 mock fetch），真实图片（取自生产聊天记录）描述内容与上下文语义完全
  对得上，`usage.reasoning_tokens:0` 印证了"不需要 DeepSeek thinking 链路"的判断。
- 验证：`node --test tests/*.test.mjs` → **364/364 全绿**（新增 10 条与本记录直接相关，含
  请求体形状/超时/网关错误透传/空内容拒绝/非图片路径零调用/未配置时工具不存在）。
- 决策：`docs/ADR-0030-vision-image-understanding.md`。
- 遗留：只做静态图片，视频抽帧/语音转写/文档解析明确不做；不会被自动调用，需 agent 自己
  判断要不要看图；无结果缓存；生产 `VISION_MODEL` 启用与本次代码部署是否同批，见下方记录。

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
  `REDFOX_API_KEY` 已配置，gzh 搜索/抓正文线上实测连通。
- **模型切换（2026-09-16）**：生产 `OPENAI_BASE_URL`/`OPENAI_MODEL` 从官方
  DeepSeek API 切到内部网关 `http://120.78.77.32:4000/v1` + `deepseek-v4-flash`
  （`server.env` 已更新，容器已 `docker rm + docker run` 重建生效，`healthz` 200）。
  **真实验证**（不只是改配置）：`scripts/verify-deepseek-thinking.mjs` 改为读
  `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL`（原来硬编码官方端点+`DS_KEY`），
  首轮 `tool_choice: 'required'` 强制触发 `assistant(tool_calls)→tool→assistant`
  这条会 400 的路径，对新端点跑通：`reasoning_content` 正常返回（106/83 字符）、
  多轮回传无 400。`README.md`/`deploy/server.env.example` 同步改了默认值与注释。
  顺手修了一个**踩到时间边界的旧 bug**：`ReportStore.recentFingerprints`/
  `recentTitles` 内部硬用真实 `Date.now()` 算 7 天窗口，而 `TaskScheduler` 自己的
  `now()` 虽可注入却没往下传——`tests/task-scheduler.test.mjs` 的固定日期 fixture
  （2026-09-10 附近）跑到真实日期满 7 天后（今天 2026-09-16）窗口对不上、假失败。
  改法：两个方法加 `now`（默认 `Date.now()`，生产行为不变）选项，`task-scheduler.mjs`
  把自己已有的 `now` 传下去；新增回归测试锁死"传 now 与不传 now 窗口基准不同"。
  `node --test tests/*.test.mjs` → **330/330 全绿**。
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
