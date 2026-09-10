# DESIGN：渐进式动态技能管理（已实现 → 稳定决策见 ADR-0013）

- 状态：**Superseded by [ADR-0013](ADR-0013-dynamic-skill-management.md)**（2026-09-10 实现完成；
  本文保留为设计过程记录。实现范围：第 1/2/3/4 块 + 发布路径 L1/L3；**L2 技能仓库同步与
  技能脚本执行器为后续工作**）
- 关联：ADR-0005（per-user skill isolation）、ADR-0006（forced skill invocation）
- 日期：2026-09-10

## 问题（与实现无关）

1. **目录占位**：技能目录（`catalogText`）目前拼进 system prompt，每轮固定消耗
   token；技能越多，静态开销越大。渐进式应该只给"目录"（名称+一句话），全文按需加载。
2. **发布通道缺失**：新技能只能"人工往服务器目录放文件"，没有管理入口、没有版本/
   来源元数据、没有可追溯的发布路径。技能作者（如 wechat-gzh-research 这样的独立
   技能仓库）无法自助接入。
3. **技能与运行时依赖耦合**：技能若带脚本（如 gzh_tool.py 依赖 python3+requests），
   运行环境必须预装，没有执行器抽象，容器部署时依赖难以管理。

## 现状盘点

已具备（不要重复造）：
- `SkillRegistry`：`SKILL.md` + frontmatter（name/description），全局技能 + 每用户
  私有技能物理隔离，per-user enable/disable（ADR-0005）。
- `use_skill` 工具：按需加载完整指令，每轮 `loadedSkills` Set 去重（ADR-0006）。
- 目录热增删：`list`/`get` 每次读盘，放文件即生效，无需重启。

缺口：
- 目录注入位置（system prompt → 工具描述）。
- 管理/发布通道（无 `manage_skill`、无技能仓库同步）。
- 技能脚本执行器抽象。
- 技能元数据（version/author/updated_at）与变更追踪。

## 设计

### 1. 目录呈现：注入 `use_skill` 工具描述（渐进式 context）

- system prompt 技能相关只剩一行引导：
  `技能：可用技能的名称与简介见 use_skill 工具描述；用户需求命中某项时必须先调用
  use_skill 加载完整指令再执行（不要凭名字猜测）。`
- `use_skill` 的 `description` 每轮按用户动态生成：
  `可用技能（N 个，名称+一句话描述）：- <name>: <description>`。
- 实现：`respond()` 里每轮按用户重建 tools（现状 `#makeAgent` 已是每轮构建，
  tools 数组改为 per-turn 生成，把 `use_skill` 的 description 换成
  `registry.catalogText(userId, enabledGlobal)` 的紧凑版）。
- 上限：目录条目 cap（env `SKILL_CATALOG_CAP`，默认 25）；超出时 `use_skill` 在
  描述末尾提示"更多可用技能：调用 use_skill 并传空/`list` 返回完整目录"。

### 2. 按需加载（增强）

- `use_skill` 返回：`【技能 <name> v<version>】<完整指令>`，metadata 前置。
- 每轮去重保留；跨轮不缓存全文（技能可能更新，宁可重载）。
- frontmatter 扩展：`version`、`author`、`updated_at`（可选，缺省空）；`list`/
  catalog 展示 version，方便排查"用的是哪版"。

### 3. 动态管理（运行时热增删）

- 热增删天然支持（目录扫描），补齐**管理面**：
  - 新工具 `manage_skill`（仅当 `ADMIN_SKILLS=1` 时注册）：`add/update/remove/list`。
    校验：frontmatter 必须含 `name`/`description`；`name` 只允许 `[a-z0-9-]`；
    单文件 ≤ 64KB；路径安全（防 `..` 穿越）。
  - 写入位置：全局 → `SKILLS_DIR/<name>/SKILL.md`。
- 用户私有技能：web 页可选"自定义技能"上传（写 `USER_SKILLS_ROOT/<userId>/<name>/`），
  二期再做，本期先不放开。

### 4. 发布路径（新技能如何进入 wechat-agent）

三层通道，覆盖开发期 → 生产：

| 层 | 机制 | 适用 |
|---|---|---|
| L1 仓库内置 | 技能随 wechat-agent 仓库 `skills/<name>/` 维护，部署时 COPY（现状已如此） | 核心技能随代码走 |
| L2 技能仓库同步 | env `SKILLS_REPO`（git URL，可选 `SKILLS_REPO_SUBDIR`/`SKILLS_ALLOWLIST`），启动/定时 `git pull` 到 `SKILLS_DIR` | 独立技能仓库（如 wechat-gzh-research）免改主仓库接入 |
| L3 运行时管理 | `manage_skill` 工具热更新，立即生效 | 运维热修、灰度 |

元数据在目录里展示 version/author，来源可追溯（L2 记录 repo+commit）。

### 5. 技能执行器抽象（技能可以带代码）

- 技能 = `SKILL.md`（指令）+ 可选 `scripts/`（可执行脚本）。
- 执行器 registry 按 shebang/扩展名路由：`.py` → python3、`.sh` → sh、`.mjs/.js` →
  node；`SKILL.md` frontmatter 可声明 `runs:` 显式指定。
- 执行约束：cwd=技能目录、超时（默认 30s）、输出截断（64KB）、`network: true/false`
  声明（gzh 搜索需要网络）。
- **wechat-gzh-research 接入路线**（二选一，评审定）：
  - **路线 A（推荐）**：RedFoxHub API 是纯 HTTP（`searchArticle`/`queryWork`），用
    Node 把 gzh_tool.py 的两个原子能力实现为通用工具（如 `gzh_search`/`gzh_content`，
    复用现有 `download-tokens`/fetch 基建，key 读 `REDFOX_API_KEY`）；技能本体只放
    SKILL.md（调研 SOP 指令），编排调用这两个工具。零 Python 依赖，容器即用。
  - **路线 B**：打包 `gzh_tool.py` + `SKILL.md`，容器镜像加装 python3+requests；
    执行器走 `.py` 路由。改动小但引入运行时依赖。

## 备选方案（不选的理由）

- **目录继续放 system prompt**：最简单，但每轮固定开销随技能数线性增长——正是要
  解决的"老旧"痛点（用户否决）。
- **独立 `list_skills` 工具查目录**：上下文最省，但模型不会主动想起先查，命中率
  不可靠；折中方案（描述注入 + 溢出时查完整目录）两者兼得。
- **技能全部固化为 agent 工具（不用 SKILL.md）**：工具与技能强耦合，无法热增删、
  无发布路径、无版本，回到原点（用户否决）。

## 验收标准

1. 技能目录（名称+一句话）出现在 `use_skill` 工具描述，按用户过滤、私有技能带标记。
2. system prompt 技能相关仅一行引导。
3. 向 `SKILLS_DIR` 新增/删除技能文件 → 下一轮对话目录立即反映，无需重启。
4. `manage_skill` 增删改生效，非法输入（缺 frontmatter、非法 name、超大、路径穿越）拒绝。
5. wechat-gzh-research 以技能形式接入（路线 A 或 B），实测可用。
6. `npm test` 全绿（新增 registry 目录/校验/执行器用例，既有 112 条不回归）。

## 风险与未决

- 工具描述长度：技能超 cap 时的截断策略（默认 25 条，超出引导查完整目录）。
- 执行器沙箱：脚本执行权限边界（先"技能作者=可信管理员"假设，网络按声明放行）。
- `manage_skill` 鉴权：当前无 admin 体系，先 env 开关（`ADMIN_SKILLS=1`）控制。
- 路线 A/B 待评审定稿后，随实现转稳定决策（ADR-0013）。
