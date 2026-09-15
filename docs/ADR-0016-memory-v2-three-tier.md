# ADR-0016: 记忆系统 v2——三层压缩 + 档案层

- 状态：Accepted（已实现、已部署、已用真实数据回放验证）
- 类型：Feature / Architecture
- 日期：2026-09-15
- 关联：[MEMORY-SPEC.md](MEMORY-SPEC.md)（权威规格）、[DESIGN-memory-lifecycle.md](DESIGN-memory-lifecycle.md)（设计与实施记录）、ADR-0003（提示词分层）、ADR-0015（会话时间感知）

## 问题

记忆系统此前只有「每轮 LLM 提取 → 原子卡片落库 → 全量分节注入」一条直线，
MEMORY-SPEC 承诺的**三层压缩与整理机制**一层未实现，产生四个可观测缺陷：

1. **写入质量失控**：一次性流水账进记忆（线上真实数据里 4 条「查看XX群图片」todo 存活
   20 天未清、「群里 L 发图片和文件」类事实快照）；偏好（preference）类别 0 条。
2. **只增不减**：`MemoryStore.delete()` 全仓库零调用；无过期、无归档、无合并、无泛化。
3. **token 效率低**：每条卡片携带叙事背景字段，6000 token 召回额度装不下多少信息；
   低价值卡片与「姓名/住址」这类核心事实**等权竞争**同一预算。
4. **矛盾并存**：「此前配置了每日 08:00 提醒」与「当前没有任何定时任务」并存；
   83 轮真实对话回放实测 `action=update` **0 次触发**。

根因：记忆没有生命周期——入口不过滤、存量不整理、出口不区分。

## 决策

按 MEMORY-SPEC 落实三层压缩，并新增 WorkBuddy 式档案层。**真相源与派生视图分离**：

| 层 | 实现 | 职责 |
|---|---|---|
| 第一层 重要性评分 | `src/services/memory-importance.mjs` | 五因子加权（类别基线 0.30 / 访问频率 0.20 / 时间衰减 0.20 / 情感强度 0.10 / 信息独特性 0.20），按类别分半衰期（identity·preference 不衰减、fact 180 天、episodic 45 天）+ `DECAY_FLOOR 0.35`；阈值 **0.30**（可达性推导后的取值）；命中者归档（不物理删除） |
| 第二层 聚类压缩 | `src/llm/memory-cluster.mjs` | **种子扩张聚类**（与种子 ≥0.35 且簇内平均 ≥0.30，簇上限 12；刻意不用连通分量）+ LLM 打包判定（PACK_MAX 6 组/批）+ 三重安全网（同簇约束 / 信息保留校验 / 只标记不删除） |
| 第三层 抽象泛化 | `src/llm/memory-generalize.mjs` | 样本门槛 ≥3 条且时间跨度 ≥3 个北京时间日历天 → semantic/procedural（`kind='generalized'`、`type='semantic'`、`source_ids` 可追溯）+ **反空泛校验**（与来源事实 ≥2 个 3-gram 重叠或命中字母词） |
| 档案层（派生视图） | `src/llm/memory-profile.mjs` | 四段档案（工作背景/个人背景/当前关注/近期动态），由 active 卡片重建、可随时丢弃、version 递增；≤1100 字；不足 5 张卡不生成；不含助手自称名 |
| 生命周期与清理 | `src/services/memory-pruner.mjs`、`src/services/memory-maintenance.mjs` | todo 过期（>7 天）/老化（>15 天）归档；轻量路径挂 `absorb()`（无 LLM）；重量路径 tick 每 6h，活跃 24h / 不活跃 **7 天**兜底，**档案漂移 ≥8 条提前重建**（带 1h 冷却） |

**重量维护的步骤顺序（真实验证后修正）**：评分 → 归档 → **泛化 → 聚类** → 档案。
泛化必须早于聚类——两层吃同一批原料（同 category+subject 的相似事件），先聚类会把样本
合并掉、让泛化永远凑不齐 ≥3 条门槛（线上副本实测：原顺序 `generalized=0`，调整后 `=1`）。

**四条硬约束**（实施与后续维护都必须遵守）：

1. **单一真相源**：档案是派生投影，删掉 `memory_profiles` 行不损失信息；卡片（含泛化卡）才是真相源。
2. **可追溯**：合并/归档/泛化都留下来源（`source_ids` 或 `archived_memories.payload`）。
3. **可回滚**：归档 = `status='archived'` + 原文进二级存储，可 `restore()`；只有用户显式 `delete_todo` 才物理删除。
4. **保护栏**：identity/preference 永不自动归档；todo 只由 pruner 按时间规则处理，不参与聚类/泛化；generalized 不参与再泛化。

**召回分层**（`MemoryManager.recall`）：`[用户档案]`（≤1200 token）→【泛化】（≤800）→【待办】
（上限 20 条 + 溢出提示）→【新近】（档案生成时间之后的增量，与档案零重叠）；无档案时回退到
旧的按类别分节行为（灰度与回滚安全），档案在 active 卡片为空时**仍然注入**。

## 备选方案（否决）

| 备选 | 否决理由 |
|---|---|
| 只优化提取 prompt，不做生命周期 | 存量垃圾永远清不掉（真实数据里 todo 存活 20 天为证） |
| embedding + 向量库做相似度 | 引入新依赖，tgz 部署链路需重装；单用户量级下 3-gram Jaccard + LLM 判定足够 |
| 档案层取代卡片层 | 丢失可审计性、精准增删、结构化消歧（subject/relation）；档案出错无法回溯 |
| 归档改为物理删除 | 丢失可回滚与审计能力，误判不可逆 |
| 用规则（正则/关键词）做泛化 | 泛化需要语义归纳，规则做不到 |
| 重量维护挂在 TaskScheduler | 语义不同（用户任务 vs 系统维护），混用污染任务表与日志 |
| 聚类用连通分量 | 多数卡片 `subject='用户'`，传递性会把不相关卡片连成巨型簇，爆 token 且诱导幻觉合并 |

## 后果

- **写入质量**：新 prompt 在 83 轮真实对话回放中把记忆从 19 条收敛到 8 条——垃圾 todo 与
  流水账清零、preference 从 0 → 3 条、敏感信息（cos 密钥）不再入库、居住/工作地自动合并。
- **存量可整理**：三层压缩 + pruner 让记忆首次具备生命周期；Z.俊 真实数据回放（副本）实测
  `scored=19, archived=0, merged=0, generalized=0, profile=ok`——数据本身无重复可合，
  系统**不动作**（宁缺毋滥）而非乱改。
- **召回效率**：档案（978 字实测）替代了"全量卡片拼接"，信息密度显著提升且时效分层清晰。
- **成本**：每活跃用户每日 3-5 次记忆侧 LLM 调用；非活跃用户 7 天一次。
- **重要运维发现（必须记住）**：`deepseek-flash` **默认思考模式且思考计入 `max_tokens`**——
  真实长 prompt 一次思考消耗 1600-1800 tokens，`max_tokens` 不足时返回
  `finish_reason=length` 且 **content 为空**（表面症状是"档案 unparsable""提取什么都没提出来"）。
  顶层参数 **`reasoning_effort: 'none'` 可关闭思考**（同一任务 reasoning 261 → 0、
  completion 24 tokens，约省 10 倍；`extra_body` 里的 `chat_template_kwargs`/`thinking`/
  `reasoning_effort` 均无效）。记忆侧所有调用统一走 `src/llm/memory-complete.mjs`（关闭思考 +
  网关不认该参数时自动回退），主对话仍保留思考能力。
- **放弃的能力**：不做程序性记忆的自动执行（procedural 只作为流程知识召回）；
  不做跨用户共享记忆；不做记忆管理 UI（工具通道足够）。

## 验收证据

| 期 | 证据 |
|---|---|
| P0 写入质量 + 清理 | `tests/memory-pruner.test.mjs`、`tests/todo-tools.test.mjs`、`tests/memory-store.test.mjs`（迁移/归档/恢复/合并/档案）、`tests/memory-extractor.test.mjs`（prompt 门槛 + emotion） |
| P1 重要性评分 | `tests/memory-importance.test.mjs`（四因子、饱和、半衰期、阈值可达性守卫、保护栏、"模型忘掉住址"回归） |
| P2 聚类压缩 | `tests/memory-cluster.test.mjs`（传递性反例、簇上限、三重安全网、幂等、LLM 失败隔离） |
| P3 抽象泛化 | `tests/memory-generalize.test.mjs`（样本/跨度门槛、反空泛、来源归属、procedural 前缀） |
| P4 档案 + 召回分层 | `tests/memory-profile.test.mjs`（四段解析、重试、分层顺序、待办上限、档案独立于卡片） |
| P5 编排 | `tests/memory-maintenance.test.mjs`（流水线、失败隔离、到期判定、串行、无 LLM 步骤） |
| 全量回归 | `npm test` → **253/253 全绿** |
| 设计 §7 逐条验收 1-10 | 各期单测（见上表）逐条覆盖 |
| 设计 §7 验收 11-13 | 11 迁移兼容老库、12 归档可回滚 → `tests/memory-store.test.mjs`；13 并发快照语义 → `tests/memory-maintenance.test.mjs`（维护运行期间写入的新卡不被本轮触碰） |
| 真实数据端到端（无造数据） | 线上 `memories.db` **副本**回放：19 条 → 评分 19 / 归档 0 / 合并 0 / 泛化 0 / 档案 978 字四段齐全（`profile: ok`）——0 动作是正确的「宁缺毋滥」 |
| 真实数据端到端（造场景数据） | 同上副本 + 造三类数据：**归档 2**（500 天前重复卡，importance 0.28）/ **合并 2**（3 条同类事件→1 条且保留全部日期；2 条近似重复 fact→1 条）/ **泛化 1**（3 条同类事件 → 「用户需要持续跟进昆山农商项目群中 ZK 发布的"行员信息同步模板"相关消息与文件」，source_ids 3 条）/ 档案 ok |
| 提取质量（真实模型） | 「花生过敏」→ emotion **0.8**；「下周三交房租」→ due **2026-09-23**（时间解析正确）；「习惯先看摘要再看全文」→ category **preference**（交互偏好识别生效） |
| 部署 | 2026-09-15 部署到 `datadefender.cn/wechat-agent`（容器重启后服务正常，5 个新模块在位） |

## 实施后自审与补强（2026-09-15）

P5 完成后做了一次自我审查，发现设计里写了但实现缺失的三处，已全部补齐：

| 项 | 问题 | 补强 |
|---|---|---|
| **A1** | 档案漂移检测（设计 §4.5「卡片变更数 ≥8 触发重建」）**完全没实现**——`source_count` 只写不读 | `memory-maintenance.isDue()` 增加漂移判定 + 1h 冷却；测试 `profile drift triggers an early rebuild` |
| **A2** | 设计 §4.6 的「维护开始时对卡片做快照」**没有显式机制**，且验收 13 **没有测试** | `runUser()` 显式取快照并在结果里记录 `snapshotSize`；补测试「维护期间写入的新卡保持 active、不被归档/合并」（走真实 `MemoryClusterer` + await 间隙插入） |
| **A3** | 维护日志只有计数（`merged=2`），**不记录「合并了什么」**——出问题无法回溯 | `last_result` 改为 JSON：`summary` + 归档/合并/泛化各前 3 条明细 + 跳过原因 + errors；两条新测试 |
| **（额外）** | **第三层被第二层饿死**：聚类先跑会把泛化样本合并掉 | 步骤顺序改为「泛化 → 聚类」，并用真实验证确认（`generalized` 0 → 1） |

自审同时确认的**未在真实数据触发**的边界（诚实记录）：自然对话数据里 Z.俊 的卡片主题各异，
归档/合并/泛化都**没有自然发生**（0 动作是正确的 no-op）；三层压缩的真实验证依赖上面的
**造场景数据**。真实长期行为仍需用户在日常使用中观察。

**未验证边界**：iLink 真实对话下的长期行为（阈值是否过松/过严、泛化产出质量随时间的变化）
需要用户在真实使用中观察；参数全部集中为常量 + env 可覆盖，属调优而非决策变更。
