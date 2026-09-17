# DESIGN：微信日报 / 周报——替用户读完他读不完的群（working proposal）

- 状态：Working（已实施并上线生产。**真实 LLM + 真实群数据已验证**：2026-09-17 以
  Z.俊 真实账号手动触发，日报 143s / 17 群、周报 506s / 16 条，产出见下文「实跑产出」。
  **仍未验证：定时触发下的 iLink 真实推送**——`tasks.db` 实测 `微信日报.last_run_at=0`、
  `微信周报.last_run_at=0`，即截至 2026-09-17 14:22 CST 两者一次都没有真正触发过；
  日报首次触发为当晚 21:30，周报为 2026-09-20 20:00。待该轮验证通过后收敛为 ADR）
- 关联：ADR-0007（微信聊天记录只读访问与权限边界）、ADR-0014（定时任务）、
  ADR-0016 / DESIGN-memory-lifecycle（记忆与派生画像）、ADR-0017 / DESIGN-daily-report
  （"生成一次、处处发布"管道——本设计**刻意不复用**它的扇出模型，见 §3）、
  ADR-0018（海报长图）、ADR-0026 / ADR-0028（失败重试与单元级跟踪，原样复用）、
  ADR-0029（历史聊天附件）、ADR-0031（公共任务改名迁移 + 注册默认订阅）
- 日期：2026-09-16
- 作者：wechat-agent 开发会话

## 问题（与具体方案无关）

用户的微信里有几十个群。他每天真正需要从里面得到的东西大概三五条：某个群里有人
@他要个答复、家里人定了周末的就医时间、小区通知明天停水、一个他关心的话题今天被
讨论得很热。这三五条散在几千条消息里，而他**没有时间读完**。

现有能力解决不了这件事：

1. `wechat_*` 工具（ADR-0007）是**检索**——用户得先知道自己要找什么才能问。
   "我不知道我错过了什么"这个问题，检索工具天然答不了。
2. 群命令入口（ADR-0022）是**被动**的——用户要主动 @助手才会触发。
3. 每日资讯（ADR-0017）是**公共新闻**——和用户自己的生活工作毫无关系。

一个显而易见但**错误**的方案是"群聊摘要"：每天把每个群的内容摘要一遍推给用户。
它错在三处：(a) 输出量随群数线性增长，用户从"读不完群"变成"读不完摘要"；
(b) 摘要的是"群里发生了什么"，而用户要的是"**跟我有关**的是什么"，这两件事的
重合度很低；(c) 不同性质的群该捞的东西完全不同——工作群里的 deadline 和家人群里
的转发养生文，用同一套摘要规则处理，结果必然是两边都不对。

## 提案

新增任务类型 `kind: 'wechat-digest'`，两条公共任务：

> **2026-09-17 更新**：产品直接指示"所有人默认订阅微信日报和微信周报"，
> 下面两条任务已经从"不默认订阅、需要用户自己 `subscribe_task`"改为默认订阅
> （新用户核验通过即订，存量用户由一次性脚本回填）。决策与量级评估记在
> ADR-0031 的"2026-09-17 变更"一节，本文档不重复；`subscribe_task`/
> `unsubscribe_task` 仍然存在，用户随时可以退订——"默认"只是初始值，不是
> 强制状态。

```json
{ "name": "微信日报", "schedule": "daily@21:30",   "kind": "wechat-digest", "instruction": "…" }
{ "name": "微信周报", "schedule": "weekly@7@20:00", "kind": "wechat-digest", "instruction": "…" }
```

`weekly@D` 的 `D` 语义以 `src/services/schedule.mjs` 的实现为准：**1=周一 … 7=周日**
（`schedule.mjs` 的 `nextRunAt` 把 JS 的 `0=Sun..6=Sat` 转成 `((weekday+6)%7)+1`）。
周日晚 = `weekly@7@20:00`。取数窗口由调度表达式推导（`digestWindowDays`：
weekly → 7 天，其余 → 1 天），**不在配置里另写一个"周期"字段**——两个真相源迟早
会改一个忘一个。

### 1. 群画像 `group_profiles`（`data/digest.db`）

```
group_profiles(user_id, chat_wxid, chat_name, tag, confidence, source, updated_at)
PRIMARY KEY (user_id, chat_wxid)
```

- `tag ∈ work | family | friends | hobby | notice | deal | dead`
- `source ∈ 'auto' | 'user'`，**不变量：auto 永不覆盖 user**（在
  `GroupProfileStore.put` 里兜底，不依赖调用方自觉）。
- **按用户隔离**：同一个群对不同人可以是不同性质。
- 独立库而不是塞进 `tasks.db`：按功能域分库是既有惯例（reports.db 也是独立的），
  各自建表迁移互不牵连。

**自动分类时机**：每次为某用户生成 digest 前，对"该用户可见、且还没有画像"的群
批量跑一次打标——取每群近 7 天的消息样本（每群 ≤30 条、单条 ≤200 字）+ 群名，
**一次** agent 调用批量打标。批量而非逐群是刻意的：群性质靠互相对比最好判
（"哪个是工作群哪个是通知群"一起看比孤立看准），且省 N-1 次调用。

**用户纠正**：agent 工具 `set_group_tag` / `list_group_tags`。用户说
"XX群是工作群""XX群已经死了不用看"即写入 `source='user'`。群只能从
`accessibleChats` 里解析（ADR-0007 的同一套边界），无法给自己不在的群打标。

打标失败/未打标时走 `DEFAULT_TAG = 'friends'`（不落库）。刻意不选 `work`：
猜成工作群会把闲聊当决策捞上来（假阳性，用户要花注意力去否定），猜成朋友群最多
少捞一点（假阴性，用户无感）。**宁可漏，不可吵。**

### 2. 提取侧重按群性质分化（`TAG_FOCUS`）

这是本功能真正的产品逻辑，不是摘要规则，是"什么东西对这个用户值得被拎出来"：

| tag | 捞什么 |
|---|---|
| `work` | @我/点名我、决策与结论、deadline/排期/责任人、文件与链接、我缺席时的关键讨论 |
| `family` | 健康就医、出行接送、生日节日聚会、需要我出钱出力或到场的事 |
| `friends` / `hobby` | 高热度话题（回复密集）、直接叫到我的邀约、与我画像重合的内容、干货与线下召集 |
| `notice` | 结构化通知（时间/地点/对象/要交什么/截止）→ 按**待办候选**形式抽出 |
| `deal` | 与我的订单/服务/维修相关的进展与要我配合的动作 |
| `dead` | 跳过，不调用 LLM |

### 3. 生成管道：per-user，**刻意不复用**日报的扇出模型

每日资讯（ADR-0017）是"一次生成、全员扇出"——因为它是公共新闻，所有人的内容
可以是同一份。digest 的内容**完全来自该用户自己的群**，没有任何可共享的部分，
那个模型在这里根本不成立。所以是 per-user 管道：

```
对每个订阅者（串行）：
  ① 边界    accessibleChats(identity) → 只要群（1:1 与助手的对话排除）
  ② 活跃    周期内有消息的群才算数（顺便拿到消息供 map 复用，不重复查库）
  ③ 打标    还没画像的群 → 一次批量 agent 调用 → group_profiles
  ④ map     每个活跃群（tag≠dead）→ 一次 agent 调用 → 候选条目 JSON（带溯源）
  ⑤ reduce  全部候选 + memory_profiles 画像 + preference 记忆 → 三节 JSON
  ⑥ 入库    ReportStore（kind='wechat-digest'）+ 海报渲染
  ⑦ 投递    provider.sendImage + sendText（复用 ContextTokenCache 与 #fanoutReport）
```

**输出的三节**（空节省略）：

| section | 含义 |
|---|---|
| `action_items` | 需要你行动（**含没人明说、但实际得你去办的隐性待办**） |
| `work_updates` | 你该知道，但不用动手 |
| `fun` | 值得一看（硬上限 3 条——多了就成噪音，反而稀释前两节） |

**溯源**：每条都带"来自 XX 群 · 09-16 14:30"。群名由**我们自己查库的那一侧回填**，
不信模型自报的群名——模型一旦串群，用户会被指到错误的出处，那比不给出处更糟。

**空是正常结果**：三节全空不是失败。默认发一句"今天各群平静"的短文本、不发海报
（`DIGEST_QUIET_PUSH=0` 则彻底静默），并**直接算作已处理**、不占重试预算。把"没内容"
当失败重试，会让每个安静的日子都触发 3 轮无谓的 LLM 调用和一条"生成失败"话术。
同理，候选为零时**不调 reduce**——空是确定的，再花一次调用让模型确认一遍是浪费。

**周报的额外动作**：窗口 7 天，且把上一期（近 14 天）的条目标题注入 reduce prompt，
要求做趋势对比（反复出现的关切、与上周相比的热度变化），并明确要求不要原样重复。

**重试**：原样复用 ADR-0026/0028 的单元级机制，单元定义改为"**每个订阅者一个单元**"
（key 沿用 `{userId, topic:''}`，与既有 `retry_units` 形状兼容，不新增列）。单群 map
失败不毁掉整期（记 onError 后继续下一个群）；单用户失败不影响其他用户。

**LLM 调用**走调度器专属 agent 实例（ADR-0028 的独立队列），`ephemeral: true` +
合成 userId（`task-<id>-<user>-<stage>`）——不污染用户真实 session/记忆，也不让
某个群的 map 上下文串进另一个群。

### 4. 渲染与发布（复用既有通道）

- 海报：`renderDigestPoster` → `poster-render`（HTML→PNG，ADR-0018 的同一条通道）。
  视觉刻意与每日资讯**区分**：那份是深色科技风新闻海报，这份是浅色纸感私人简报，
  分节卡片 + 每条带出处徽标，一眼能看出"这是我的群，不是新闻"。
- H5 页：`/reports/<id>` 同一条路由，按 `report.kind` 选模板。
- 存储：复用 `ReportStore`，新增两列（沿用 `PRAGMA table_info` + `ALTER TABLE` 的
  既有迁移风格）：`reports.kind`（默认 `'report'`，老数据行为不变）、
  `report_items.section`（digest 的三节归属）。

### 5. 反馈闭环（不需要新机制）

推送文案末尾固定引导：「哪条没用？直接回我（比如「以后别给我推 XX 群的闲聊」），
下次就不给你了。」

这句话落到数据上**不需要任何新机制**：用户的回复走的是主 agent 的正常对话链路，
主 agent 本来就会把这类表达写成 `category='preference'` 的记忆
（MemoryExtractor → MemoryStore，ADR-0016）；而 `preference` 与 `identity` 一样
**永不自动归档**（`memory-importance.mjs`），所以说过一次就一直有效。
本设计要做的只有一件事：**reduce prompt 里把 preference 记忆读出来并声明为硬约束**
（"与他的偏好冲突、或他明确说过不想看的 → 直接丢掉，不要保留但降权"）。

同理，用户说"XX群是工作群"时主 agent 会调 `set_group_tag`——这是反馈闭环的另一半：
一条是"别给我这类内容"（preference），一条是"这个群你判错了"（group_profiles）。

### 6. 待办落地

`action_items` 里用户确认要记的，**复用现有 `add_todo` 工具**（`src/tools/todo-tools.mjs`，
写 `memories` 表 `category='todo'` + `due`）。用户在对话里说"第一条帮我记下来"，
主 agent 调 `add_todo` 即可，本期**不做**从 digest 自动写 todo（见 non-goals）。

## 备选方案（不选的理由）

- **群聊摘要（每群一份摘要推给用户）**：见 §问题。输出量随群数线性增长、摘要的是
  "群里发生了什么"而不是"跟我有关的是什么"、不同性质的群用同一套规则必然两边都不对。
- **复用日报的"一次生成、全员扇出"**：digest 的内容 100% 来自用户自己的群，
  没有可共享的部分，扇出模型不成立。硬套只会得到一份"所有人的群混在一起"的东西。
- **不做群画像，让模型每次自己判断群性质**：每期每群都要重判一次（token 翻倍），
  且**用户的纠正无处安放**——"XX群是工作群"这句话说了也不算数，是这类功能最快
  失去信任的方式。画像表的真正价值不是省 token，是给用户的纠正一个落点。
- **群画像存 `tasks.db`**：功能域不同，混在一起两边的建表迁移互相牵连；仓库既有
  惯例就是按域分库（tasks/reports/sessions/memories 各一个）。
- **用规则（关键词/正则）代替 LLM 做提取**：`@我` 可以用规则，但"隐性待办"
  （没人明说但得你去办）、"我缺席时的关键讨论"、"与我画像重合"都不是规则能表达的，
  而那恰恰是这份简报唯一的价值所在。
- **候选为零时仍调一次 reduce**：纯浪费——空是确定的。
- **"空"走失败重试路径**：安静的日子会触发 3 轮无谓 LLM 调用 + 一条虚假的
  "生成失败"话术（ADR-0026 刚修完同类问题）。
- **digest 也记 ADR-0020 的 `guide_shown` 埋点**：digest 没有主题概念、推送文案里
  也没有主题定制引导，记了只会把转化率的分母灌水成"曝光了但永远不会转化"。
- **新建独立的 DigestStore 而不复用 ReportStore**：归档、公网页、海报路径、按
  `task_id/user_id` 的查询全都一样，复制一套只为多两个列，不换任何能力。

## 验收标准（可观察、可证伪）

| # | 验收 | 直接证据 |
|---|---|---|
| D1 | `group_profiles` 存取正确；**`source='auto'` 不覆盖 `source='user'`**，`user` 可覆盖 `auto`/`user`；非法 tag 抛错 | `tests/group-profile-store.test.mjs` |
| D2 | `kind='wechat-digest'` 的全局任务被路由到 digest 管道，不走 report/plain 分支；未配置 digestRunner 时跳过而非推空文本 | `tests/wechat-digest-scheduler.test.mjs` |
| D3 | map/reduce 管道用 mock agent 返回固定 JSON，能走通到 ReportStore 入库 + `sendImage`+`sendText` 投递；条目带"来自 XX 群 · 时间"溯源 | `tests/wechat-digest-runner.test.mjs` + `tests/wechat-digest-scheduler.test.mjs` |
| D4 | 三节全空 → 默认发一句"今天各群平静"短文本、**不发海报**、不进 `retry_units`；`digestQuietPush:false` → 一条都不发 | `tests/wechat-digest-scheduler.test.mjs` |
| D5 | 周报取 7 天窗口、日报取 1 天（`digestWindowDays` + runner 实际查询的 `sinceMs`） | `tests/wechat-digest.test.mjs` + `tests/wechat-digest-runner.test.mjs` |
| D6 | **权限边界**：只查 `accessibleChats` 返回的群；不在该用户群里的会话绝不进入候选 | `tests/wechat-digest-runner.test.mjs`（真实 `WechatLogStore` + 真实 sqlite fixture） |
| D7 | `set_group_tag` 无法给用户不在的群打标；打标后 `source='user'` | `tests/group-tag-tools.test.mjs` |
| D8 | `ReportStore` 新增列对老库幂等迁移，老数据 `kind` 默认 `'report'`、行为不变 | `tests/report-store.test.mjs` |
| D9 | `/reports/<id>` 按 kind 路由到 digest 模板（分节 + 溯源） | `tests/app.test.mjs` |
| D10 | 全量 `node --test tests/` 全绿 | 见本文 §未验证边界 |

## 风险与未决

- **LLM 输出不是合法 JSON**：与 ADR-0017 同源的老问题。map 阶段单群解析失败
  只丢那个群的候选（不影响其他群）；reduce 解析失败走
  `digest_unparsable` + 单元级重试（ADR-0026/0028）。
- **token 成本随群数线性增长**：一个用户一期 = 1 次打标（仅首次/有新群时）+ N 次 map
  + 1 次 reduce。护栏：单群 ≤120 条消息、单条 ≤200 字、单用户 ≤30 个群、`dead` 群跳过。
  超出 30 群时**如实写进 `rawText`**（"另有 N 个因数量上限未扫描"）——静默截断会让
  "我的群怎么没被读"变成查无实据的投诉。**但截断本身仍是真实的能力上限，未解决。**
- **总成本随订阅用户数线性增长（2026-09-17 起，风险等级从"理论"变"现实"）**：
  `#runDigestTask` 逐订阅者严格串行（ADR-0028 的调度器专属串行队列，无额外
  并发）。默认订阅生效前，这个成本只随"主动订阅的人数"增长；默认订阅之后，
  N = 全体已核验用户数。真实量级估算、周报/日报窗口相互挤占的风险、以及
  本次不实现的缓解方向（分片错峰、独立并发度）记在 ADR-0031 的"2026-09-17
  变更"一节，不在本文重复。
- **隐私**：digest 内容是用户私人群聊的提炼，落在 `data/reports.db` 与公网
  `/reports/<id>`（不可猜测 id）。这比每日资讯（公共新闻）的隐私等级高得多。
  当前依赖 id 不可猜测，**没有鉴权**——这是一个已知的、本期未解决的风险，
  上生产前应评估是否给 digest 类报告加访问控制（见 non-goals）。
- **同名用户跨租户越界（已修复，ADR-0032）**：生产实测发现 `accessibleChats`
  的 wxid/昵称并列 OR 匹配，在 wxid 大面积缺失（生产当时全部已核验用户皆如此）
  时会让**昵称相同的不同用户互相看到对方的全部群聊**——digest 每天自动跑一次，
  会把这个此前"只有用户主动查才触发"的洞变成每天自动触发。已改成分级匹配 +
  同名歧义拒绝返回，详见 ADR-0032；本文档 D6 的验收范围因此扩展到"同名歧义
  时也不能拿到并集"。
- **"隐性待办"的召回率完全依赖模型**：无法证伪，只能靠用户反馈迭代 prompt。
- **群画像会过期**：群的性质会变（项目群结项变死群）。当前只在"没有画像"时打标，
  没有重新评估机制；用户可以手动纠正，但系统不会自己发现。
- **明确不做（non-goals）**：
  - digest 自动写 todo（只复用 `add_todo` 由用户在对话里确认；自动写会把误判
    直接变成用户待办列表里的垃圾）；
  - digest 报告的访问鉴权（沿用现有不可猜测 id 的既有做法）；
  - 跨期机械去重（digest 是按周期切片的，跨期去重会掩盖"这件事还没闭环"）；
  - 群画像的自动重评估；
  - 群聊内容进入长期记忆（digest 只读不写 memories）。

## 未验证边界（诚实声明）

- **真实 LLM 端到端未验证**：所有测试用 mock agent 返回固定 JSON。真实模型在
  map/reduce prompt 下的 JSON 合规率、以及"隐性待办"的实际召回质量，**没有证据**。
- **iLink 真实发送未验证**：`sendImage`/`sendText` 在测试里是 mock。
- **海报渲染未验证**：`renderDigestPoster` 的 HTML 只做了字符串断言，没有真实
  跑过 headless 浏览器截图，**实际排版效果未知**（长标题换行、分节间距、超长
  简报的图片高度）。
- **`node --test tests/` 未执行**：实施会话的环境不允许执行 `node --test`
  （权限被拒，非代码问题）。全部测试为**静态编写、未运行**。见 ADR-0031 同款声明。
