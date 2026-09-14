# ADR-0015: 会话时间感知——间隔注入 + 对话节奏规则

- 状态：Accepted
- 类型：Behavior / Feature
- 日期：2026-09-11

## 问题

Agent 的 transcript 只存消息文本（无时间戳），动态 system 只注入「今天是 X」，模型**感知不到距上次对话多久**。用户周一聊过某事、周五回来打招呼时，模型把它当作同一场无缝对话，生硬地接续旧话题——行为突兀、不像人。根因有两处：

1. `SessionStore.append()` 存 `{role, content}`，消息无时间（虽然 `sessions.updated_at` 记录了上次活跃时间，但从未被使用）；
2. `buildDynamicSystem()` 只给当前时间，不给间隔，模型无从判断"该重启还是该继续"。

## 决策

给 Agent 补上「时间流逝」感知，**信息 + 用法两层配合**，并把该能力的所有内容**集中管理在一个模块**（`src/llm/conversation-pace.mjs`），后续调文案/阈值只改这一个文件：

1. **动态注入（信息层）**：`buildGapLine(updatedAtMs, nowMs)` —— 非首次（`updatedAt>0`）且间隔超过 `GAP_THRESHOLD_MS`（默认 2 小时，`env GAP_THRESHOLD_MS` 可配）时返回「距上次对话：4 天 3 小时。」，否则返回空串。注入到动态 system 的「今天是…」之后、记忆之前。间隔格式化用 `src/services/time.mjs` 新增的 `humanizeGap(ms)`（北京时间语义，<1h 显示分钟，<24h 显示小时+分钟，<7 天显示天+小时，≥7 天只显示天）。
2. **静态规则（用法层）**：`PACE_RULES`（对话节奏）拼入 `buildBaseInstructions` 角色行为——隔久先自然问候、以用户当前意图为主、不主动硬接旧话题；短间隔正常连续；打招呼不长篇回应。只给方向，不写死话术。
3. **时间源零改动**：直接用 `SessionStore` 已存的 `updated_at`（上次对话时间），存储 schema 不迁移。

## 备选方案

- **B 时间门控**：间隔超阈值时不注入全部 transcript，只给 summary 或空历史。否决：会误伤用户确实想接着聊的场景（"上次那事后来呢"），且丢失可用的历史信息。
- **C 话题化会话**：历史按话题分组、显式引用才接续。否决：个人助手场景过重，属产品级改造，未来有需求再议。

## 后果

- 模型隔天对话会自然重启或一句话衔接，不再生硬接续；定时任务推送也能感知"用户多久没上线"，推送文案更自然。
- 行为交给 LLM 自由发挥（补信息 + 给方向，不写死话术），存在一定行为方差，但可控。
- 阈值可配（`GAP_THRESHOLD_MS`），按运营反馈可调（如改 8h 只跨天生效）。
- 新能力内容集中在一处，维护成本低：改文案/阈值不涉及 system-prompt 与 agent 接线层。

## 验收证据

- `tests/conversation-pace.test.mjs`：`buildGapLine` 首次/阈值内/超阈值/格式化边界；`PACE_RULES` 存在；`humanizeGap` 天/小时/分钟边界。
- `tests/system-prompt.test.mjs`：间隔行注入位置（时间之后、记忆之前）；「对话节奏」进入静态 instructions。
- `npm test` 全量回归（原 131 全绿 + 新增用例）。
