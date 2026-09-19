# ADR-0040 子任务沙箱按用户共享（跨任务文件交接）

- 状态：已采纳（2026-09-19）
- 类型：缺陷修复 / 沙箱边界
- 关联：ADR-0008（文件沙箱）、ADR-0024（任务委派）、ADR-0036（任务板）、ADR-0038（回合管道）、**ADR-0039（子任务渠道透传）**

## 背景与问题

ADR-0039 修好了"后台任务拿不到微信渠道"（文件/图片发不出去），但**同批次的文件交接仍然断裂**：
后一个子任务读不到前一个子任务产出的文件。

生产实证（2026-09-19，用户 Z.俊 的真实批次 #11/#12/#13）：

| 子任务 | 做了什么 | 结果 |
|---|---|---|
| task-16 / board#11 | 搜索整理德文猫资料 | done |
| task-17 / board#12 | 生成 HTML 图文报告（写在**自己的**目录） | done，报告确实生成了 |
| task-18 / board#13 | 把报告发给用户 | **失败**：`工作目录 /data/user-files/subagent:task-18 中没有任何文件，且无法访问到主用户目录（路径越界被拒绝）` |

同一模式在 9-18 的批次里已经出现过一次（task-13：「没有找到任何『整理好的要点』文件」）。
两次都是**如实拒绝编造**——worker 的行为是好的，坏的是沙箱边界。

## 根因

`SubagentRunner.#execute()` 用**合成 agent userId** 调 `agent.respond`：

```js
agent.respond({ userId: `subagent:${run.id}`, ... })   // 修复前
```

而所有文件类工具（`file-tools` / `wechat-send-tools` / `image-tools` / `poster-tools` / `lark-tools`）
都通过 `resolveUserPath(root, ctx.context.userId, rel)` 解析路径 → 沙箱根 = `user-files/subagent:task-N`。
**每个子任务一个空目录**，兄弟任务互相看不见对方的产出，"生成 → 发送"这条最基本的交接必然失败。

同时这个选择还带来两个副作用（都是白得的坏处）：
1. 用户下载链接指向的文件也不在用户目录（`wechat-send-tools` 的 `send_file` 与 `write_file` 落点不一致）；
2. 板上记录的是 `subagent:task-N` 这种运行标识，跟"这是谁的文件"这件事无关。

## 决策

子任务沙箱根改用**任务归属用户**：

```js
agent.respond({ userId: task.userId, text: prompt, profile: execProfile, ephemeral: true, channel: this.#channelFor(task.userId) })
```

- 同批次的兄弟任务共享 `user-files/<userId>/`，交接自然成立（task-17 写的，task-18 能读到并发出）。
- **会话与长期记忆不受影响**：`ephemeral: true` 仍然为真，两者都不落盘。
- `execProfile` 不变（仍是 `{ nickname:'任务执行', wxid:'subagent:<runId>' }`），worker 的自我描述不变。

测试契约更新：`tests/subagent-runner.test.mjs` 原有的 `assert.match(calls[0].userId, /^subagent:task-/)` 改为
`assert.equal(calls[0].userId, 'u1')`——把新边界钉住（13/13 通过）。

## 被放弃的能力

- **同用户跨 run 的文件隔离没有了**：同一用户的多个子任务（含不同批次）现在能互相读写文件。
  接受，理由：① 跨**用户**隔离不变，仍由 `resolveUserPath` 的越界检查守着，那才是安全边界；
  ② 子任务本来就是"替该用户干活"，用户与用户之间才有隔离意义；③ 用户自己下载链接拿到的就是这些文件。
- 若将来确需按批隔离，正确做法是**按批次（metadata.batchId）分目录**，并把该目录显式告知 worker，
  而不是回到按 run 分——按 run 分连正常的批内交接都做不了。

## 验收与证据

- `node --test tests/subagent-runner.test.mjs` → 13/13 通过（含更新后的沙箱边界断言）。
- 全量回归见提交说明。
- **未验证**：还没有在线上跑一次真实的多任务批次来确认"图片/文件真正送达"。这是本 ADR 唯一未闭合的验收项，
  需要一次真实的"生成报告 → 发我"任务来确认（预期：`send_file` 成功，图片直接进微信而不是下载链接）。

## 遗留（不在本记录范围）

- 磁盘上遗留的 `user-files/subagent:task-*` 目录是新旧路径切换的残留，不再被写入；确认无用后可清理。
- 批内交接目前依赖"共享工作区 + worker 自己找文件"。若后续发现 worker 找不到前序产物，
  应把依赖任务的结果文本/文件名**显式注入**给后继任务，而不是继续依赖隐式约定。
