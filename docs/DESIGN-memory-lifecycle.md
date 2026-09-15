# DESIGN：记忆系统 v2——三层压缩 + 档案层（完整落实 MEMORY-SPEC）

- 状态：**Working proposal**（待评审 → 分阶段实施 → 收敛为稳定决策 ADR-0016）
- 关联：`MEMORY-SPEC.md`（权威规格）、ADR-0003（提示词分层）、ADR-0015（会话时间感知）；
  实现面：`memory-store` / `memory-manager` / `memory-extractor` / `agents-sdk-agent` / `server.mjs`
- 日期：2026-09-14
- 设计依据：Z.俊 线上真实记忆（19 条）实测 + 新 prompt 完整历史回放（83 轮 → 8 条）+ WorkBuddy 档案式记忆对照

---

## 一、问题（与实现无关）

当前记忆系统只有「每轮 LLM 提取 → 原子卡片落库 → 全量分节注入」这一条直线，
MEMORY-SPEC 承诺的**三层压缩与整理机制**一层未实现，由此产生四个可观测缺陷：

1. **写入质量失控**：一次性流水账进记忆。Z.俊 库中 4 条「查看XX群图片」todo（8/25 产生，
   至今 20 天未清）、「8月25日群里L发图片和文件」类事实快照；偏好（preference）类别
   19 条中 0 条。
2. **只增不减**：`MemoryStore.delete()` 全仓库零调用；无过期、无归档、无合并、无泛化。
3. **token 效率低**：每条卡片携带 `context` 叙事字段，6000 token 召回额度装不下多少信息；
   低价值卡片与「姓名/住址」这类核心事实**等权竞争**同一预算。
4. **矛盾并存**：「此前配置了每日 08:00 提醒」与「当前没有任何定时任务」两条并存；
   83 轮回放实测 `action=update` **0 次触发**。

根因不是某个 bug，而是**记忆没有生命周期**：入口不过滤（写入无门槛）、
存量不整理（无评分/聚类/泛化）、出口不区分（召回不分层）。

---

## 二、设计目标与非目标

**目标**（逐条对应 MEMORY-SPEC）：

| MEMORY-SPEC 条款 | 本设计落实为 |
|---|---|
| 第一层 重要性评分筛选（访问频率/时间衰减/情感强度/信息独特性） | 模块 `memory-importance`（四因子加权评分 + 归档阈值） |
| 第二层 聚类压缩（相似记忆分组 → 代表性摘要 → 原始记忆存档二级存储） | 模块 `memory-cluster` + `archived_memories` 表 |
| 第三层 抽象和泛化（情境记忆 → 语义/程序性记忆） | 模块 `memory-generalize`（kind=generalized） |
| Advanced JSON Cards（事实+情境背景+主体+关系+时间戳） | 保留并扩展（emotion/importance/source_ids/status） |
| 记忆读写按 user_id 隔离 | 沿用；所有新表带 user_id |
| 「新信息覆盖旧信息，保留可审计时间戳」 | update / merge / archive 三层可追溯（archive 表 + source_ids） |
| 工作记忆与长期记忆动态交互 | recall 分层注入 + access_count 反馈回重要性评分 |

**额外目标**（WorkBuddy 对照得出的形态改进）：

- **档案层**：高密度、分层（稳定/当前/近期）的用户档案，作为召回首选内容；
  卡片层退化为「证据层 + 精准层」。档案是**派生视图**，可随时丢弃重建。
- **交互偏好优先**：偏好提取向「沟通风格/交互偏好」倾斜（如「偏好简短直接、结构化回复」
  「要求诚实说明能力边界」），这类偏好直接改善每轮回复质量。

**非目标（明确放弃）**：

- 不做 embedding / 向量库（保持零新增依赖，tgz 部署链路不变）；
- 不做程序性记忆的**执行**（procedural 只作为「流程知识」记录与召回，不驱动代码路径）；
- 不做跨用户共享记忆（多租户隔离不变）；
- 不做记忆的 UI 管理界面（工具通道足够）。

---

## 三、总体架构

```text
                    ┌────────────────── 派生视图（可重建，非真相源） ──────────────────┐
                    │ memory_profiles：4 段档案（工作背景/个人背景/当前关注/近期动态）│
                    └──────────────────────────────▲─────────────────────────────────┘
                                                   │ 每日重建（LLM）
   ┌──────────── 真相源：memories（扩展字段）──────┴─────────────────────────────────┐
   │ atomic 卡片（身份/偏好/事实/待办/情境）   generalized 卡片（语义/程序性，带来源）│
   └──────▲───────────────────────────────────────────▲────────────────────────────┘
          │ 每轮提取（absorb）                         │ 每日：评分 → 聚类 → 泛化
   ┌──────┴────────┐  ┌──────────────────┐  ┌─────────┴────────┐  ┌──────────────────┐
   │memory-extractor│  │memory-importance │  │ memory-cluster   │  │ memory-generalize│
   │(+emotion 字段) │  │(四因子评分)      │  │ (规则预聚+LLM)   │  │ (样本≥3 才泛化)  │
   └────────────────┘  └──────────────────┘  └──────────────────┘  └──────────────────┘
          │                     │                     │                     │
          │              ┌──────┴─────────────────────┴─────────────────────┴────┐
          └─────────────►│ memory-pruner（todo 过期/老化）+ archived_memories   │
                         └──────────────────────────────────────────────────────┘
                                            ▲
                        memory-maintenance（编排：轻量每轮 / 重量每日）
                                            │
                        recall（分层注入：档案 → 泛化 → 待办 → 新近）
```

**四个关键约束**（后续所有模块都受它约束）：

1. **单一真相源**：档案永远是派生视图，任何时刻删掉 `memory_profiles` 行都不损失信息；
   卡片（含泛化卡）才是真相源。
2. **可追溯**：合并/归档/泛化都必须留下来源（`source_ids` 或 `archived_memories`），
   任何一次整理都可人工回溯「这条结论从哪来」。
3. **可回滚**：归档 = `status='archived'` + 原文进 `archived_memories`，不物理删除。
4. **保护栏**：`identity` 与 `preference` **永不自动归档**（用户画像核心）；
   `todo` 只由 pruner 按时间规则处理，不参与聚类/泛化（行为语义特殊）。

---

## 四、模块设计

### 4.1 `memory-store.mjs`（扩展：schema + 归档 + 档案 + 维护记录）

**memories 表新增列**（⚠️ 迁移实现要点：现有 `#migrate()` **只检测单个列名**
（`category`），扩展时必须改为**逐列检测**——`PRAGMA table_info` 取出列集合后，对每个
目标列单独判空再 `ALTER TABLE ADD COLUMN`；否则已有 `category` 的老库不会补出新列。
所有列带非空默认值，ALTER 安全且可重入（中途崩溃后重跑只补缺列）：

| 列 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `importance` | REAL | 0.5 | 第一层评分结果（0-1） |
| `access_count` | INTEGER | 0 | 被召回注入的累计次数（访问频率因子） |
| `last_access_at` | INTEGER | 0 | 最近一次被召回的时间 |
| `emotion` | REAL | 0 | 情感强度（0-1，提取时由 LLM 标注） |
| `kind` | TEXT | 'atomic' | `atomic` \| `generalized`（第三层产物） |
| `source_ids` | TEXT(JSON) | '[]' | 泛化/合并的来源卡片 id 列表 |
| `status` | TEXT | 'active' | `active` \| `merged` \| `archived` |

**新增三张表**：

```sql
-- 二级存储：被归档的原始卡片（MEMORY-SPEC 第二层「原始详细记忆可存档到二级存储」）
CREATE TABLE IF NOT EXISTS archived_memories (
  id          TEXT PRIMARY KEY,   -- 原卡片 id（保留，便于回滚）
  user_id     TEXT NOT NULL,
  payload     TEXT NOT NULL,      -- 归档那一刻的完整卡片 JSON
  reason      TEXT NOT NULL,      -- low_importance | merged | generalized_source | aged_todo
  archived_at INTEGER NOT NULL,
  restored_at INTEGER NOT NULL DEFAULT 0
);

-- 派生视图：用户档案（可丢弃重建）
CREATE TABLE IF NOT EXISTS memory_profiles (
  user_id      TEXT PRIMARY KEY,
  content      TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  generated_at INTEGER NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 0   -- 生成时的 active 卡片数（漂移检测用）
);

-- 维护编排状态
CREATE TABLE IF NOT EXISTS memory_maintenance (
  user_id        TEXT PRIMARY KEY,
  last_run_at    INTEGER NOT NULL DEFAULT 0,   -- 上次重量维护时间
  last_change_at INTEGER NOT NULL DEFAULT 0,   -- 最近一次卡片写入时间（脏标记）
  last_result    TEXT NOT NULL DEFAULT ''      -- 最近一次维护摘要（归档/合并/泛化计数）
);
```

**新增/变更 API**：

| 方法 | 用途 |
|---|---|
| `listActive(userId)` | 只取 `status='active'`；召回与维护的输入 |
| `listByKind(userId, kind)` | 取泛化卡 |
| `markAccessed(userId, ids, at)` | 召回后批量 `access_count++` / `last_access_at`（单条 UPDATE ... IN） |
| `setImportance(userId, id, score)` | 评分回写 |
| `archive(userId, ids, reason, at)` | 事务：`status='archived'` + 插 `archived_memories` |
| `mergeInto(userId, originalIds, mergedCard)` | 事务：插合并卡 + 原卡 `status='merged'` + 原卡入 archive |
| `upsertProfile(userId, content, sourceCount, at)` | 档案写入（version+1） |
| `getProfile(userId)` | 档案读取（recall 用） |
| `touchChange(userId, at)` / `getMaintenance(userId)` | 脏标记与维护状态 |

**约定**：`insert()` 保持现有「同 (type,subject,relation,category,content) 去重」语义并额外
更新 `last_change_at`；`update()` 覆盖语义不变（保留 `created_at`，刷新 `updated_at`）。

---

### 4.2 `memory-importance.mjs`（第一层：重要性评分）

**输出**：`{ importance, factors: { base, frequency, decay, emotion, uniqueness } }`
（四因子全部保留，便于测试与人工审查「为什么这条被判低分」）

**公式**（加权和，权重集中为常量，env 可覆盖）：

```text
importance = clamp01( w_base·base + w_freq·frequency + w_decay·decay + w_emo·emotion + w_uniq·uniqueness )

base       类别基线： identity 1.0 | preference 0.9 | todo 0.8 | fact 0.6 | episodic 0.5
frequency  访问频率： min(1, access_count / 5)             // 5 次饱和，避免热点垄断
decay      时间衰减（**按类别分半衰期 + 下限**）：
                     decay = max(DECAY_FLOOR, 0.5 ^ (ageDays / halfLife(category)))
                     halfLife: identity/preference = ∞（恒 1.0）| fact = 180 天
                               | todo = ∞（生命周期由 pruner 管）| episodic = 45 天
                     DECAY_FLOOR = 0.35
                     ageDays = (now - max(updated_at, last_access_at)) / 86400000
                     // 访问即刷新：被复述过的旧事实不该因为「写得早」被衰减掉
emotion    情感强度： emotion（提取时 LLM 标注 0-1；**缺失按 0.3 中性基线**，
                     不按 0——避免"没标注"被系统性当成"无情感"而压低分值）
uniqueness 信息独特性：1 - maxSimilarity(card, siblings)     // 与同用户其他 active 卡的最高相似度
                     相似度 = 字符 3-gram Jaccard（零依赖、中文可用、可解释）
                     // 完全重复(1.0) → 0 分；独一无二 → 1 分

权重： w_base 0.30 | w_freq 0.20 | w_decay 0.20 | w_emo 0.10 | w_uniq 0.20
```

**逐项推敲说明**：

- **base 权重最高**：「用户叫张工」不该因为没有访问记录而被判低价值——类别本身是最强的
  价值先验，同时修正纯行为统计模型的冷启动问题。
- **frequency 用饱和曲线而非线性**：避免高频卡片碾压一切；5 次封顶（单用户量级合理）。
- **decay 作用于 `max(updated_at, last_access_at)`**：复述强化，符合人类记忆规律。
- **decay 必须按类别分半衰期（评审修订）**：统一 45 天半衰期会算出——
  90 天未召回的一条 `fact`（例如「用户居住在蛇口」）decay≈0.25，加权后跌破归档阈值
  0.25 → **模型忘掉用户住址**。故 fact 半衰期放宽到 180 天、加 `DECAY_FLOOR=0.35`
  兜底；identity/preference 不衰减（画像核心）。
- **uniqueness 用 3-gram Jaccard**：零依赖、对中文有效、可解释；同时是聚类模块的预筛信号
  （一处计算两处复用）。实现细节：先归一化（去空白/标点、统一大小写），
  再用 `Array.from()` 按**码点**切分（emoji 是代理对，`substring` 会切碎）。
- **emotion 权重最低（0.10）**：LLM 打分噪声较大，只作微调，不作为主导因素；
  缺失按中性 0.3 而非 0（否则「模型没标注」与「确实无情感」不可区分）。

**归档阈值与保护栏**（不物理删除）：

```text
archiveCandidate ⇔ importance < 0.30
                 ∧ ageDays > 14                     // 新卡不判死
                 ∧ category ∉ {identity, preference} // 保护栏
                 ∧ category ≠ 'todo'                 // 交给 pruner
                 ∧ status = 'active'
```

**阈值可达性推导（实施期发现，P1）**：归档阈值必须**高于**任一类别的「最低可达分」，
否则规则永不触发。按「极旧 + 零访问 + 情感基线 + 完全重复（uniq=0）」计算
（注意 `episodic` 是 **type** 而非 category，`CATEGORY_BASE.episodic` 仅作旧数据兜底）：

| category | 最低可达分 | 计算 |
|---|---|---|
| fact（含 type=episodic 的流水账卡） | **0.28** | 0.30·0.6 + 0.20·0.35 + 0.10·0.3 |
| preference | 0.50 | 0.30·0.9 + 0.20·1（不衰减）+ 0.03 |
| identity | 0.53 | 0.30·1.0 + 0.20·1 + 0.03 |
| todo | 不参与 | 由 pruner 按时间规则处理 |

原定阈值 0.25 配相邻的 `<` 判断实际**不可达**（fact 最低 0.28 亦高于它 → 规则形同虚设）。
故阈值取 **0.30**：只清「几乎完全重复且已老化」的卡片；独特卡片由 uniqueness 因子自保
（唯一且极旧的 fact 仍 ≈0.50，不归档）。相似但不相同的长尾交给第二层聚类合并，
第一层不越权做语义判断。

**评分时机**：① 每轮 absorb 后只对**本轮新增/更新卡片**算分（每张新卡与 n 张旧卡比对，
复杂度 O(k·n)，k=本轮新增数）；② 每日重量维护对全部 active 卡片重算
（时间衰减需要全量刷新，此时为 O(n²)，单用户数十~数百条量级可接受）。

---

### 4.3 `memory-cluster.mjs`（第二层：聚类压缩）

**目标**：相似卡片 → 一条代表记忆；原文进二级存储。**不丢信息**是硬约束。

**两阶段设计**（规则预聚 + LLM 决策）：

```text
阶段 A 规则预聚（零成本，先砍噪声）：
  分组键 = (category, subject)
  相似度 = 字符 3-gram Jaccard（归一化 + 按码点切分）

  ⚠️ 用「种子扩张聚类」，**不用连通分量**（评审修订）：
    1. 组内按 importance 降序排序（未评分时按 updated_at 降序）作为种子候选
    2. 取首个未归簇卡片为种子；贪婪吸收同时满足下列两条的卡片：
       · 与**种子**的相似度 ≥ 0.35
       · 与**簇内已有成员的平均相似度** ≥ 0.30
    3. 簇大小上限 MAX_CLUSTER(12)，超出的卡片留给后续种子（避免一次喂爆）
    4. 重复直到无未归簇卡片
  只把「簇大小 ≥ 2」送 LLM（单条簇直接跳过）

  为什么不用连通分量：多数卡片 subject='用户'，连通分量会因**传递性**把
  「住址」「天气」「群文件」连成同一个巨型簇——送进 LLM 的是一堆互不相关的内容，
  既爆 token 又诱导幻觉式合并。种子 + 簇内平均相似度约束保证「簇内确实彼此相似」。

阶段 B LLM 决策（判断"是不是真在讲同一件事"）：
  输入：**打包多个候选簇**（`<group id="g1">…</group>` 分隔，见 §4.6 成本），
        每卡给出 id + content + context + updated_at；单卡 content >400 字时截断到 400（标记 …）
  输出：{"groups":[{"cardIds":[...],"summary":"合并后记忆","category":"...","subject":"...","relation":"..."}]}
  约束：不硬凑组（讲不同事的卡片允许不合并）；
        数字/日期/专有名词必须原样保留；identity 只能与 identity 合并；todo 不参与

应用（事务）：
  每个合并组 → 新增一条 kind='atomic' 的 semantic 卡片（content=summary（≤600 字），
    context=合并来源说明，source_ids=原卡 ids，emotion=max(原卡)，
    importance=max(原卡 importance)）
  → 原卡 status='merged' 并进 archived_memories（reason='merged'）
```

**幂等保证（评审简化）**：原卡合并后 `status='merged'`，而 `listActive()` 天然排除
非 active 卡片 → 同一组不会二次合并，**无需额外 merge_key 哈希与查重列**
（原设计的 merge_key 未定义存储位置，属多余机制，删除）。事务保证「插合并卡 +
标记原卡 + 归档原卡」要么全成要么全回滚。

**保护栏（逐项）**：
- `identity`：只在同 subject 且同 relation 内合并（「用户称呼为张工」+「用户叫张俊」可合并）；
  跨 subject 绝不合并。
- `todo`：完全不参与（待办是行动项，合并会丢失「哪件事」的粒度）。
- `generalized`：不参与二次合并（防止层层抽象导致信息漂移）。
- **信息保留校验（两项，任一不过则放弃本次合并并记入维护日志）**：
  ① **数字保持**：合并文本必须覆盖原卡中的每个数字串（`\d+`）；比较前做日期归一化
     （原卡 `2026-08-25` 与合并文本 `8月25日` 视为同一信息，统一解析成日期集合再比）。
  ② **专名保持**：原卡中长度 **3-4 字**的连续中文片段（在 ≥2 张原卡出现、且不含通用字的）
     在合并文本中的**覆盖率 ≥ 50%**——防止「昆山农商项目」被合并成「某个银行项目」而丢掉
     关键对象。
     > 实施期修正：原设计写「长度 ≥3 的连续中文串、覆盖率 ≥80%」。实测两处都不对——
     > ① 整段中文串会因措辞改写而整体失配；② 把 **2 字**片段算作实体时，「需要」这类通用词
     > 进入集合，覆盖率随措辞抖动（真实用例上从 1.0 掉到 0.73 仅因少了一个「需要」）。
     > 故改为 3-4 字片段 + 通用字过滤 + 阈值 0.5，改名（丢失主体）仍会被拦下。
  保守回退优先于丢信息：宁可少合并，不可合并出错误记忆。

---

### 4.4 `memory-generalize.mjs`（第三层：抽象和泛化）

**目标**：多条情境记忆 → 一条语义规律或程序性流程（MEMORY-SPEC 第三层）。

**样本门槛**（防幻觉的关键）：

```text
候选簇 = 按 (category, subject) 分组后，用 **§4.3 的「种子扩张聚类」**得到的簇
         （阈值 0.3、簇内平均相似度 ≥0.28、MAX_CLUSTER 12——同样**不用连通分量**，
          理由见 §4.3）
         ∧ 全部成员 kind='atomic'                 // 泛化卡不参与再泛化
         ∧ 簇内 episodic 条数 ≥ MIN_SAMPLES(3)    // 少于 3 条不足以支撑规律
         ∧ 簇内时间跨度 ≥ 3 天                     // 按**北京时间日历天**计算（复用 time.mjs）；
                                                  // 同一场对话里的重复不算「多次经历」
```

**LLM 泛化 prompt 要点**：

```text
输入：簇内 episodic 卡片（id/content/context/时间）
输出：[{"kind":"semantic|procedural","content":"...","subject":"...","relation":"...",
        "reason":"这些事件共同说明了什么","sourceIds":[...]}]
约束：① 只在确实存在共同模式时输出，否则返回 []；
      ② 规律必须被给定事件支持，不得引入原文没有的信息；
      ③ 必须具体可用——好例："用户经常需要跟进微信群里的文件交付与确认"；
         坏例："用户关注工作"（空泛无信息量）；
      ④ procedural 只描述「反复采用的流程」，不是对系统的指令。
```

**产物写入**：`kind='generalized'`、`source_ids=[原卡 ids]`、`type='semantic'`，
**category 沿用 `fact`/`preference`**——`semantic` 是 **type** 不是 category，这样分节渲染
（身份/偏好/事实/待办）与类别基线都不受影响；procedural 产物的 content 前缀加「流程：」区分。
`importance` 由评分公式计算（`kind='generalized'` 的类别基线取 **0.7**，介于 fact 与
preference 之间）。

**原情境卡处理**（推敲过的决策）：
- 泛化成功后，原 episodic **若** `importance < 0.4` → 归档（reason='generalized_source'，
  细节已在高价值结论中体现）；否则保留（重要事件本身仍有独立价值）；
- 无论哪种，`source_ids` 都保留指向，可追溯。

**再泛化防护**：`kind='generalized'` 的卡片不参与后续泛化输入。

**反空泛校验（实施期补充，`verifyGeneralization`）**：prompt 里的「必须具体可用」只是引导，
代码侧另有一道机械校验——泛化内容必须与来源事实有**实质用词重叠**（≥2 个 3-gram），
或命中来源里的字母词（fineBI/POC/NAS…），否则丢弃（`not anchored in source facts`）。
> 修正过程：原设计想复用第二层的「3-4 字实体片段覆盖率」，但泛化**本来就要抽象化**——
> 来源是「8月25日苏商DEP群发的图片和文件需要查看」，规律写成「用户经常需要查看微信群里
> 发来的图片和文件并跟进处理」，逐字碎片（"日苏商"/"银行群"）几乎必然失配，会把**合格**的
> 泛化全部杀掉（自测即失败）。改用 3-gram 重叠计数：既拦住零重叠的「用户关注工作」式空话，
> 又容许措辞抽象。

---

### 4.5 `memory-profile.mjs`（档案层，WorkBuddy 式派生视图）

**为什么需要**：卡片式召回 token 效率低、无概括、矛盾并存；WorkBuddy 的四段档案在信息
密度、一致性、时效分层上全面占优。但**不放弃卡片**——卡片是可审计的证据层，
档案是压缩视图。

**四段结构**（对齐 WorkBuddy，按「时间稳定性 + 用途」分块）：

```text
【工作背景】职业/公司/职责/协作对象/技术栈        （稳定 ← identity + fact）
【个人背景】沟通偏好/交互习惯/决策风格/生活信息    （稳定 ← preference + identity + fact）
【当前关注】正在进行的主要事项                    （近期 ← todo + 近期 fact）
【近期动态】最近发生的重要事件与状态变化           （时效 ← 近 14 天 episodic/fact，
                                                    按**北京时间日历天**，复用 time.mjs）
```

**生成 prompt 要点**：

```text
你是用户档案生成器。根据下列记忆卡片，生成该用户的档案，分四段（工作背景/个人背景/
当前关注/近期动态）。规则：
1. 只写卡片支持的内容，不推测、不补全；
2. 偏好写成可操作的描述（例："偏好简短直接、结构化（编号列表/对比表格）的回复"）；
3. 每段 1-5 条要点，无内容的段写"（暂无）"；
4. 数字/日期/专有名词原样保留；
5. 总长 ≤ 800 字。
输入：卡片列表（{[category] subject/relation: content}）+ 生成日期
输出：四段 Markdown 文本
```

**关键约定（避免双重真相）**：
- 档案**不含**助手自称名（那是 `assistantName()` 的单一来源，ADR-0003）；
- 档案是**只读投影**：召回与工具都不修改档案，只重建它；
- 输入 = 该用户全部 `status='active'` 卡片；`source_count` 用于漂移检测；
- active 卡片数 < MIN_PROFILE_CARDS(5) 时**不生成**（信息量不足，避免"（暂无）"四连）；
- 重建触发：每日重量维护，或卡片变更数 ≥ 8（`source_count` 漂移）。

---

### 4.6 `memory-maintenance.mjs`（编排：轻量每轮 / 重量每日）

模仿 `TaskScheduler` 的形态（`setInterval` + `unref()` + `sweep()` 手动触发，便于测试）。

```js
new MemoryMaintenance({
  store,                // MemoryStore（含新表 API）
  score, cluster, generalize, profile,   // 四个模块的入口函数（依赖注入，测试可替换）
  now = () => Date.now(),
  tickMs = 6 * 3600 * 1000,          // 每 6h 检查一次
  intervalMs = 24 * 3600 * 1000,     // 活跃用户：重量维护间隔 ≥ 24h
  idleIntervalMs = 7 * 24 * 3600 * 1000,  // 不活跃用户：低频兜底间隔 ≥ 7 天（用户 2026-09-14 拍板）
  minCards = 8,                       // 卡片数不足跳过（不值得 LLM 调用）
  onError = null,
})
```

**轻量路径（在 absorb 的 fire-and-forget 异步链里执行，不阻塞用户回复）**：
```text
1. prune：todo 过期（due 超期 >7 天）/ 老化（due=0 且 >15 天未更新）→ archive(reason='aged_todo')
2. 对本轮新增/更新卡片算 importance（含 3-gram 邻域比对）
3. touchChange(userId, now)   // 脏标记
```
> 注意：这里的 SQLite 操作走 `node:sqlite` **同步 API**，会短暂占用事件循环——
> 卡片量级（数十~数百条）下为毫秒级；实现时应避免在轻量路径做全量重算（那是重量维护的事）。

**重量路径（tick 命中且条件满足时，后台异步）**：
```text
条件（两档，均需 active 卡片数 ≥ minCards）：
  A 活跃用户： now - last_run_at ≥ intervalMs(24h)     且 now - last_change_at ≤ 3 天
  B 不活跃用户：now - last_run_at ≥ idleIntervalMs(7天) 且 now - last_change_at > 3 天
  → 两档都执行完整的重量维护（评分刷新→归档→聚类→泛化→档案）。
    不活跃用户必须有低频兜底（用户 2026-09-14 拍板）：时间衰减持续起作用，
    其卡片会随年龄增长逐步跨过归档线；长期不整理会让"僵尸记忆"永久占据召回预算。
步骤：
  1. 全量重算 importance（时间衰减刷新）
  2. 归档候选 → archive(reason='low_importance')
  3. 聚类压缩 → mergeInto(...)
  4. 抽象泛化 → insert(kind='generalized') [+ 必要时归档来源]
  5. 档案重建 → upsertProfile(...)
  6. 写 memory_maintenance.last_run_at / last_result（归档/合并/泛化计数）
失败处理：任一用户任一步骤抛错 → 记入 last_result，不中断 tick 其余部分。
串行执行：#running 标志保证同一时刻只跑一个用户的重量维护（避免 LLM 并发打爆配额）。
```

**成本核算**（每活跃用户每日，评审修订——原「逐簇调用」会膨胀到 8-15 次）：

```text
聚类：把该用户**所有候选簇打包**进 1-2 次 LLM 调用（prompt 内 `<group id="gN">` 分隔，
      一次返回多组结果）；候选簇 > PACK_MAX(6) 个时分批。
泛化：同样打包，1-2 次调用。
档案：1 次调用。
→ 合计 3-5 次 LLM 调用 / 活跃用户 / 日（deepseek-flash，单次 ≤900 output tokens）。
非活跃用户（3 天无写入）跳过；active 卡片数 < minCards 跳过。
```

**并发与快照语义**（与 absorb 的关系，评审补充）：

```text
- 重量维护开始时对 active 卡片做**快照**（id 列表）。
- 归档 / 合并 / 泛化**只对快照内的 id 生效**；维护期间 absorb 新写入的卡片不受影响，
  由下一轮维护处理（最终一致，不做跨阶段锁）。
- 档案重建读"维护开始时的快照 + 期间新写入卡片"的最新状态（档案本就是投影，允许最新）。
- 每次 LLM 调用前取快照、返回后按 id 逐个应用：避免长事务与 node:sqlite 同步 API
  长时间阻塞事件循环（DatabaseSync 是同步的，事务要短）。
```

---

### 4.7 `memory-manager.mjs`（recall 重设计：分层注入）

**现状**：全量分节 + 6000 token 硬截断（低价值卡片与核心事实等权竞争）。
**新设计**：档案优先 + 职责分离。

```text
recall(userId) 输出结构（总预算 maxRecallTokens=6000）：

[用户档案]                          ← 若存在 profile；预算 ≤1200 token（超长整体截断到要点）
【泛化】                            ← kind='generalized'；预算 ≤800；无则整节省略
【待办】                            ← active todo，按「最近到期优先」；**上限 20 条**，
                                      超出以「…另有 N 条待办，需要我列出来吗」一行收尾
                                      （行动项优先级最高，但非无限——防止极端情况挤爆预算）
【新近】                            ← **档案生成时间之后**新增/更新的非 todo 卡片
                                      （真增量，与档案不重叠；无档案时退化为「近 7 天」）
[长期记忆]（回退路径，仅当无档案）  ← 现有分类分节全量注入（保持老行为，避免回归）
```

> 评审修订说明：原设计的「新近 = 近 7 天」与档案【近期动态】段在**同一时间维度**上重叠，
> 同一事件会在 system prompt 里出现两次。改为「档案生成时间之后的增量」——语义变成
> 「档案还没覆盖到的部分」，零重叠；待办则加了上限与溢出提示。

**要点**：
- 档案存在时**不重复注入**被档案覆盖的稳定事实（同一信息不两处出现）；
- 待办优先级最高（行为语义，模型必须看到）；
- 注入后调 `store.markAccessed(userId, injectedIds, now)`——访问频率因子的唯一来源；
- 回退路径保证：从未跑过维护的库（新部署、老数据）行为与现在一致。
- **档案独立于卡片**（实施期修正）：`active` 卡片为空但档案存在时**仍然注入档案**——
  档案是投影，可能比当前 active 卡片更持久；只有"无卡片且无档案"才返回空串。

**`assistantName()` 不变**（ADR-0003 单一来源），档案与 recall 都不重复承载自称名。

---

### 4.8 提取器与 prompt 增强

**`memory-extractor.mjs`**：
- 输出 schema 新增字段 `emotion`（0-1，情感强度：强烈情绪/重要偏好/健康与家庭类偏高，
  中性事务偏低；prompt 给锚点示例）。
- 保留 due 解析、`action=add|update` 判定。
- `buildExtractPrompt` 采用**已实测通过**的新版（重要性门槛 / episodic 收紧 / todo 门槛 /
  交互偏好引导 / 称呼去重），并新增交互偏好示例（WorkBuddy 对照得出的改进）：
  「偏好简短直接、结构化回复」「决策要多选项与证据」「要求诚实说明能力边界而非强行变通」。

**实测依据**（83 轮完整回放）：新 prompt 产出 8 条（原 19 条），垃圾 todo 与流水账清零、
preference 从 0 → 3 条、敏感信息（cos 密钥）不再入库、居住/工作地合并为一条。

---

## 五、数据流（端到端）

```text
用户消息 ─► agents-sdk-agent.respond()
             ├─ recall()：档案 + 泛化 + 待办 + 新近        ──► system prompt
             ├─ 主对话（LLM + 工具）
             └─ absorb()：提取卡片 → insert/update
                 └─ 轻量维护：prune + 评分 + 脏标记

每 6h ─► MemoryMaintenance.tick()
           └─ 命中用户（活跃 & ≥24h）→ 重量维护：
                评分刷新 → 低价值归档 → 聚类合并 → 泛化 → 档案重建
```

---

## 六、备选方案（逐项否决理由）

| 备选 | 否决理由 |
|---|---|
| 只做 prompt 优化，不做生命周期 | 存量垃圾永远清不掉（Z.俊 4 条 todo 存活 20 天为证）；不满足「二三层全落实」要求 |
| embedding + 向量库做聚类/相似度 | 引入新依赖，tgz 部署链路需重装；3-gram Jaccard + LLM 决策在单用户量级（数十~数百条）足够 |
| 档案层直接取代卡片层 | 丢失可审计性（不知结论从哪来）、精准增删（用户无法删单条）、结构化消歧（subject/relation）；档案出错无法回溯 |
| 归档改为物理删除 | 丢失可回滚与审计能力，误判代价不可逆 |
| 用规则（正则/关键词）做泛化 | 泛化需要语义归纳，规则做不到；LLM + 样本门槛 + 来源校验是可行组合 |
| 重量维护挂在 TaskScheduler | 语义不同（用户任务 vs 系统维护）；混用污染任务表与执行日志 |
| 每轮都跑重量维护 | LLM 调用量 ×10，且无新样本时聚类/泛化无意义 |

---

## 七、验收标准（可观察、可证伪）

| # | 验收 | 直接证据 |
|---|---|---|
| 1 | 四因子评分可解释 | `memory-importance` 单测：给定卡片+访问次数+时间，断言 importance 与各因子；边界（全新/极旧/重复/高频）逐项覆盖 |
| 2 | 低价值卡片被归档而非删除 | 单测：构造 importance<0.30 且 age>14 的 fact → 归档后 `status='archived'`、`archived_memories` 有完整 payload |
| 3 | 保护栏生效 | 单测：identity/preference 即使 importance 极低也不归档；todo 不参与聚类/泛化 |
| 4 | 聚类不丢信息 | 单测：数字/日期/专名保留校验（缺任一数字串则放弃合并）；重复跑不产生第二张合并卡（幂等） |
| 5 | 泛化守住样本门槛 | 单测：2 条 episodic 不泛化、3 条且跨 3 天则泛化；`kind='generalized'` 且 `source_ids` 完整 |
| 6 | 档案是派生视图 | 单测：删 `memory_profiles` 行后 recall 回退旧路径，行为与现版本一致；重建后内容一致 |
| 7 | recall 分层正确 | 单测：有档案时 = 档案+泛化+待办+新近，不重复注入被覆盖事实；无档案时 = 现有分节行为；总 token ≤6000 |
| 8 | 访问反馈闭环 | 单测：recall 后 `access_count` 增加、`last_access_at` 更新；下次评分 frequency 上升 |
| 9 | 真实数据端到端 | **服务器回放**：Z.俊 19 条真实记忆跑完整维护流水线 → 报告「19 条 → 归档 N / 合并 M / 泛化 K / 档案文本」；人工审查档案质量（对照 WorkBuddy） |
| 10 | 全量回归 | `npm test`（现 174 全绿）+ 新增模块测试全绿 |
| 11 | **迁移兼容老库** | 单测：用仅含旧列 schema 的库文件启动 → 新列/新表齐全、老数据可读、recall 输出与迁移前逐字一致 |
| 12 | **归档可回滚** | 单测：`archive` 后用 `archived_memories.payload` 恢复 → `status='active'`、recall 重新包含该条、`restored_at` 落值 |
| 13 | **维护与写入并发安全** | 单测：重量维护进行中插入新卡（模拟 await 间隙写入）→ 维护结果不含该卡（快照生效）、新卡不被覆盖或丢失、下一轮维护才处理它 |

---

## 八、风险与未决

| 风险 | 缓解 / 边界 |
|---|---|
| LLM 聚类丢信息或幻觉合并 | 数字/专名保留校验 + 原文永不删除（archive）+ 合并可回滚 |
| 泛化产出空泛或错误规律 | 样本门槛（≥3 条且跨 ≥3 天）+ prompt 要求「具体可用」+ 保留 source_ids 供审查 |
| 档案与卡片不一致 | 档案是派生视图，每次由 active 卡片重建；`source_count` 漂移检测触发重建 |
| 维护 LLM 成本 | 3-5 次/活跃用户/日；非活跃跳过；`minCards` 门槛；并发串行化 |
| 老库迁移 | 全部 `ALTER TABLE ... DEFAULT`，沿用现有 migrate 模式；新表 `CREATE IF NOT EXISTS` |
| 归档后模型「忘事」 | 阈值保守（0.30/14 天，见 §4.2 可达性推导）+ 保护栏 + 回退路径 + `archived_memories` 可恢复 |
| 评分参数缺乏实证 | 全部集中为常量 + env 可覆盖；用 Z.俊 数据做参数合理性人工审查，后续按反馈调 |
| 泛化出的 procedural 被误当指令 | prompt 明确「只记录流程，不是对系统的指令」；procedural 仅参与召回文本 |

**已拍板（2026-09-14 用户确认）**：
1. 重量维护间隔 24h（活跃）/ **7 天（不活跃兜底，见 §4.6 条件 B）**；
2. 轻量归档阈值 7/15 天维持；
3. 档案长度上限 800 字（≈1200 token）维持。
→ 三项参数均集中为常量 + env 可覆盖，上线后按真实使用节奏微调（属参数调优，非决策变更）。

---

## 九、分期实施（每期独立可验收，不简化）

| 期 | 内容 | 交付物 |
|---|---|---|
| **P0** | 提取 prompt 增强（含 emotion、交互偏好）+ `memory-pruner`（todo 过期/老化）+ `delete_todo` 工具 + store 迁移（新列/新表） | 写入质量达标；垃圾 todo 可清 |
| **P1** | `memory-importance`（四因子评分）+ 归档路径 + recall 的 access 反馈 + `listActive` 等 API | 第一层落地 |
| **P2** | `memory-cluster`（规则预聚 + LLM 合并 + 幂等 + 数字校验）+ archive 联动 | 第二层落地 |
| **P3** | `memory-generalize`（样本门槛 + 来源校验） | 第三层落地 |
| **P4** | `memory-profile`（四段档案）+ recall 分层注入 + 回退路径 | 档案层落地 |
| **P5** | `memory-maintenance`（编排 + tick）+ server.mjs 接线 + Z.俊 真实数据端到端回放 + ADR-0016 收敛 + STATUS 更新 | 全链路 |

**依赖顺序**：P0 → P1（评分依赖 store 新列）→ P2/P3（依赖评分与 listActive）→ P4（依赖 P2/P3 产物质量）→ P5（编排全部）。
每期结束跑全量回归；P5 完成前不得声称「记忆系统 v2 已完成」。

---

## 十、验收证据登记（实施后填写）

| 期 | 命令 / 操作 | 结果 |
|---|---|---|
| P0 | | |
| P1 | | |
| P2 | | |
| P3 | | |
| P4 | | |
| P5 | | |

---

## 十一、设计评审记录（自评审，2026-09-14）

> 原计划委派 Claude Code（opus）做对抗性评审，因订阅周额度耗尽（21:00 重置）中断，
> 改由设计者自行完成：**逐条把设计假设拿到现有代码上核对** + 对抗性自审。
> 下列发现已全部修订进上文对应章节（修订处均带「评审修订」标注）。

| 级别 | 发现 | 处置 |
|---|---|---|
| **Blocker** | 连通分量聚类在 `subject='用户'` 下因**传递性**退化成巨型簇（住址/天气/群文件连成一片）→ 送进 LLM 的是一堆无关内容，既爆 token 又诱导幻觉合并 | §4.3/§4.4 改为**种子扩张聚类**（与种子 ≥0.35 且与簇内平均 ≥0.30，簇上限 12） |
| Major | 统一 45 天半衰期 → 90 天未召回的高价值 fact（住址/姓名）跌破归档线，**模型忘掉用户核心事实** | §4.2 按类别分半衰期（fact 180 天、identity/preference 不衰减）+ `DECAY_FLOOR=0.35` |
| Major | `emotion` 缺失按 0 计 → "未标注"与"无情感"不可区分，系统性压分 | §4.2 缺失按 **0.3 中性基线** |
| Major | 【待办】"全部注入、不截断"与 6000 总预算冲突（todo 多时挤爆档案与泛化） | §4.7 待办**上限 20 条** + 溢出提示 |
| Major | 【新近 = 近 7 天】与档案【近期动态】同时间维度重叠 → 同一事件注入两次 | §4.7 改为**档案生成时间之后的真增量** |
| Major | 聚类/泛化「逐簇调用」实为 8-15 次 LLM/用户/日，原估算（1-2 次）低估 | §4.6 改为**打包批量**（`<group>` 分隔，PACK_MAX 6）→ 合计 3-5 次 |
| Major | 只校验数字保留，**专有名词**（群名/项目名/人名）可能被合并丢 | §4.3 增设两项校验：数字（含日期归一化）+ 中文串覆盖率 ≥80% |
| Major | 重量维护与 absorb 并发语义未定义（谁覆盖谁） | §4.6 明确**快照语义**：只对快照内 id 生效，新写入留给下一轮 |
| Major | 现有 `#migrate()` 只检测单列（`category`）→ 老库不会补出 7 个新列 | §4.1 明确改**逐列检测**，可重入 |
| Minor | 3-gram 需按码点切分（emoji 代理对）；超长卡片需截断；"近 N 天"需按北京时间；复杂度描述（O(k·n) 而非 O(1)）；`merge_key` 无存储位置属多余机制 | 已在 §4.2/§4.3/§4.5/§4.7 逐条修正；merge_key 设计删除（`listActive` 已保证幂等） |
| Minor | 验收缺「迁移兼容 / 归档回滚 / 并发快照」三项 | §7 补验收 11-13 |

**经代码核对后确认成立、实施时不得简化的设计**（评审亮点）：

1. **档案 = 派生视图、卡片 = 真相源**——避免双重真相（spec-loop 的单一权威要求）；
   删掉 `memory_profiles` 行不损失任何信息。
2. **保护栏**：identity/preference 永不自动归档；todo 不进聚类/泛化。
3. **归档而非删除**：`status='archived'` + `archived_memories.payload`，可回滚可审计。
4. **两阶段聚类**（规则预聚 + LLM 决策）：规则层砍噪声省 token，LLM 层判语义——这是
   在零 embedding 依赖下做到「既不误合也不漏合」的可行组合。
5. **泛化样本门槛**（≥3 条且跨 ≥3 天）：防幻觉的核心机制，不可为了「多产出」而放宽。
6. **回退路径**：无档案时 recall 行为与现版本一致——保证灰度与回滚安全。
7. **access 反馈闭环**：召回 → `access_count` → 重要性评分，四因子里唯一的行为信号。
8. **轻量/重量双路径**：轻量挂 absorb（每轮、无 LLM），重量按日 tick（有 LLM）——
   成本与时效的正确切分。
