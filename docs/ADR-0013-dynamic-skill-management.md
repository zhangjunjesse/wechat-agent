# ADR-0013: 渐进式动态技能管理 + wechat-gzh-research 接入（路线 A）

- 状态：Accepted
- 类型：Architecture / Feature
- 日期：2026-09-10
- 前身：`docs/DESIGN-dynamic-skill-management.md`（working proposal，已实现，本记录为稳定决策）

## 问题

1. 技能目录（名称+描述）拼在 system prompt 里，每轮固定消耗 token，技能越多静态开销越大；
   技能全文本应只在使用时按需加载（渐进式）。
2. 新技能只有"人工往服务器目录放文件"一条通道，无管理入口、无版本/来源元数据。
3. 带脚本的技能（如 gzh_tool.py 依赖 python3+requests）与运行环境耦合，容器部署时依赖难管理。

## 决策

### 1. 目录进 `use_skill` 工具描述（渐进式 context）

- system prompt 只剩一行引导："可用技能的名称与简介见 use_skill 工具描述；需求命中某技能时
  必须先调用 use_skill 加载完整指令再执行"。
- `use_skill` 的 description 每轮按用户动态生成：`可用技能（N）：- name vX: 一句话`——
  私有技能带（私有）标记、带 version，cap 25 条（`SKILL_CATALOG_CAP`），溢出提示
  `name=list` 查完整目录。私有技能优先展示。
- 实现：`buildUseSkillTool({ skillRegistry, catalog })`（misc-tools.mjs）；`AgentsSdkAgent`
  在 `respond()` 里按用户算 catalog、拼进每轮 tools（静态工具 + 动态 use_skill）；
  `catalogForTool(userId, enabledGlobal, cap)` 在 SkillRegistry。
- 全文仍只在使用时进入上下文（use_skill 返回完整指令，本轮去重 `loadedSkills` 保留）。

### 2. SKILL.md frontmatter 元数据

`version`/`author`/`updated_at` 可选字段，随 list/get 返回、目录与 use_skill 结果展示
version。`parseSkillText()` 拆出 meta+body 供校验复用。

### 3. 运行时技能管理（管理面）

- `manage_skill` 工具（`src/tools/manage-skill-tools.mjs`），仅 `ADMIN_SKILLS=1` 时注册：
  `add/update/remove/list`。写入经 `SkillRegistry.addSkill` 校验：name 只允许
  `[a-z0-9][a-z0-9-]{0,63}`、frontmatter 必须含 name/description 且 name 一致、≤64KB；
  `removeSkill` 同样只接受合法 name。热生效，无需重启。
- 用户私有技能上传（web 页面）本期不做（deferred）。

### 4. 公众号调研能力接入（路线 A——Node 直连 RedFoxHub API）

- `src/services/gzh-api.mjs`：`gzhSearch`（关键词→文章列表，offset 分页去重、3108 限流
  重试一次、关键词 ≤10 字符）/ `gzhContent`（workUuid→正文）——协议与 gzh_tool.py 相同
  （source 字段、X-API-KEY 鉴权），key 读取沿用 gzh-search-crawler 约定（REDFOX_API_KEY
  环境变量 > `~/.qoder/apis/redfox.json`）。零 Python 依赖。
- `src/tools/gzh-tools.mjs`：`gzh_search` / `gzh_content` 两个 agent 工具，错误显式返回
  （未配置 key / 额度 / 网络），不静默失败。
- `skills/wechat-gzh-research/SKILL.md`：调研 SOP 技能（意图识别→多关键词搜索→评估→
  调整重试→精选→抓正文核实→综合成文→透明说明消耗），随仓库 skills/ 目录分发（L1 内置
  发布路径），模型通过 use_skill 加载后按 SOP 编排两个工具。

### 5. 发布路径

- L1 仓库内置（现状保留）：技能随 wechat-agent 仓库 `skills/<name>/` 分发，部署 COPY。
- L2 技能仓库 git 同步（`SKILLS_REPO`）：**后续实现**。
- L3 运行时管理：本决策第 3 条（manage_skill）。

## 备选（不选的理由）

- 目录继续放 system prompt：每轮固定开销线性增长（被否）。
- 独立 list_skills 工具：模型不主动查、命中率不可靠；折中（描述注入 + name=list 完整目录）
  两者兼得。
- gzh 技能走 Python 打包（路线 B）：引入 python3/requests 运行时依赖；RedFoxHub API 是
  纯 HTTP，Node 实现成本低且与代码库一致（选 A）。
- 技能固化为硬编码 agent 工具：无法热增删/发布/版本化（被否）。

## 后果

- 每轮固定开销与技能总数解耦（目录 ≤25 条一行描述，全文按需加载）。
- 新技能三种路径可达：仓库内置、manage_skill 热更新、（后续）技能仓库同步。
- gzh 能力以技能形式交付，模型按 SOP 自主完成调研；API 额度消耗透明。
- 风险：目录描述仍占少量每轮 token（25 条以内可接受）；manage_skill 依赖 ADMIN_SKILLS
  开关无更细鉴权（当前无 admin 体系）；gzh 真实调用依赖 RedFoxHub key 与线上行为。

## 验收证据

- `npm test`：**131/131 全绿**（新增 gzh-api 6 条、gzh-tools 6 条、技能元数据/目录/校验/
  管理 5 条、buildUseSkillTool 2 条；system-prompt 测试更新为断言一行引导）。
- 行为核对：system prompt 不再含技能目录；use_skill 描述携带目录；manage_skill 非法输入
  全被拒；技能文件热增删下一轮即反映。

## 遗留（诚实边界）

- gzh 真实搜索/抓正文效果需要配置 REDFOX_API_KEY 后实测（mock 测试只证明协议字段与
  错误分支正确）。
- L2 技能仓库同步、技能脚本执行器抽象、用户私有技能上传为后续工作。
