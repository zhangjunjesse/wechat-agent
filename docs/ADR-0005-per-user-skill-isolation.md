# ADR-0005: 按用户隔离的技能机制（全局技能 + 私有技能）

- 状态：Accepted
- 类型：Architecture / Security / Feature
- 日期：2026-08-25

## 问题

技能机制（`SkillRegistry`）此前是单例、全局的：`list()`/`get(name)`/`catalogText()` 都不带用户维度。这在只有一个内置全局技能（`word-report`）时没问题，但不满足两个即将到来的需求：

1. **管理员要能配置"默认技能清单"**（不是所有全局技能都对所有用户可见/启用）；
2. **用户要能创建自己的私有技能**（下一轮加 `create_skill` 工具）。第 2 点如果不做物理隔离，会成为真实的多租户安全问题：A 用户创建的技能被 B 用户看到或调用。

参考了 WorkBuddy 的 Skill 工具设计（技能目录内嵌工具描述、`<available_skills>` 按已装/已启用状态动态生成）——但 WorkBuddy 是**客户端**，用户天然物理隔离（不同机器/不同 OS 用户）；我们是**多租户服务端**，同一进程服务所有用户，必须在代码层做隔离，不能照抄它"客户端天然隔离"的前提。

## 决策

`SkillRegistry` 改为两级来源 + 每用户可见性计算，隔离方式与 `file-tools.mjs` 的用户目录沙箱同构：

```text
全局技能   <SKILLS_DIR>/<name>/SKILL.md                （共享，管理员维护）
私有技能   <USER_SKILLS_ROOT>/<userId>/<name>/SKILL.md  （物理隔离，仅该用户可达）
```

- `listGlobal()` / `listUser(userId)` 分别列出两个来源；`list(userId, enabledGlobal)` = 该用户"启用的全局技能" ∪ "全部私有技能"。
- **默认启用清单可配置**：`resolveEnabled(profile.enabledSkills)` —— 用户 profile 没设置时，回退到服务器级 `DEFAULT_SKILLS` 环境变量（逗号分隔技能名）；`DEFAULT_SKILLS` 未设置时默认"全部全局技能启用"（零配置可用）。用户可通过 profile 的 `enabledSkills` 数组自定义（显式 `[]` = 关闭所有全局技能，私有技能不受影响）。
- **物理隔离**：`listUser`/`get` 按 `userId` 拼接目录路径（同 file-tools 的 `resolve()` 思路），另一个用户的 `userId` 天然打不开这个用户的私有技能目录；`userId` 是服务端下发的稳定键（`providerUserId`），不是用户可控输入。
- **同名冲突**：私有技能优先于同名全局技能（用户能覆盖全局技能而不影响别人）。
- **`use_skill` 工具**：从 `ctx.context.userId` + `ctx.context.profile.enabledSkills` 取参数调用 `registry.get/list`，天然按当前会话用户过滤，不需要额外鉴权代码。
- **系统提示词的技能目录**：从"构造时算一次的全局字符串"改为"`respond()` 时按 `userId` + `profile.enabledSkills` 计算"。这是在现有架构上顺势扩展——`AgentsSdkAgent` 本来就是每次对话重建 `Agent` 定义（为了让工具沙箱拿到 `ctx.context.userId`），所以 `instructions` 从"构造时固定"改成"每次 respond() 时按用户生成"零架构改动。

## 备选方案

1. **不隔离，靠约定/文档提醒**：不选，多租户下这是真实的数据泄漏，不是提醒能防住的。
2. **每用户一个 SkillRegistry 实例**：能达到隔离效果，但要在 respond() 里按 userId 现造实例，增加对象生命周期管理；不如"一个 Registry + 按参数算可见性"简单。
3. **数据库表而非目录**：更适合技能数量巨大或需要精细权限时；当前技能仍是"人类可编辑的 Markdown 指令"，保持文件形态与 `file-tools`/`SKILL.md` 惯例一致，选文件目录。

## 后果

- 两个不同 `userId` 现在物理上只能看到/加载各自的私有技能 + 各自启用的全局技能——已用测试验证（`tests/skills.test.mjs`：跨用户不可见、私有覆盖同名全局、`resolveEnabled` 的默认/覆盖/关闭三态）。
- `create_skill` 工具（用户通过对话创建私有技能）留到下一轮：本轮只做地基（隔离 + 清单机制），生成器工具是在这个地基上加的新工具，不影响本轮设计。
- `data/user-skills/` 加入 `.gitignore`（运行时用户数据，同 `data/user-files/`）。

## 验收证据

- `tests/skills.test.mjs`：
  - 无 `userId` 时只看到全局技能；
  - 私有技能仅对其所有者可见/可加载，另一用户 `list`/`get` 均为空；
  - 全局 + 私有技能合并出现在同一用户的目录/`catalogText`；
  - `resolveEnabled`：`undefined`→服务器默认、显式列表覆盖、显式 `[]` 关闭全局但保留私有；
  - 私有技能覆盖同名全局技能，且只对该用户生效；
  - `DEFAULT_SKILLS` 未设置（`defaultEnabled=null`）时全部全局技能可见。
- `npm test`：41/41 通过。
