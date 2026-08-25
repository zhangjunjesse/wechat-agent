# ADR-0004: 稳定租户键统一为 providerUserId + 旧数据迁移

- 状态：Accepted
- 类型：Architecture / Bug fix
- 日期：2026-08-25

## 问题

此前把租户键从 browser 随机 ID 改为 iLink `providerUserId`（稳定键）时，只改了 iLink 消息路径，两处遗留未处理：

1. **网页消息路径**（`/api/chat`）仍用 `x-user-id`（browser id）作为 `agent.respond` 的 `userId`；
2. **旧数据未迁移**：修复前存在 browser id（如 `u_51cf2368-99a`）下的记忆/会话，在改用 providerUserId 后成了孤儿，用户重新绑定后看到「记忆没了、对话重置」。

实际观察：`memories.db` 里 2 条记忆仍在 `u_51cf2368-99a` 下（`助手名为小新`、`用户称呼为张工`），而新消息用 `o9cq80wXtSkIXBJDDLCggTI4WQPY@im.wechat` 查，两边对不上。数据并未丢失。

## 决策

1. **统一稳定租户键 = `providerUserId`**。`ProfileStore.stableKey(key)` 把任意 key（browser id 或 providerUserId）解析到 providerUserId：取 `profile.ilinkUserId`，无则回退输入（未验证用户）。网页 `/api/chat` 用 `stableKey` 作为 agent 的 `userId`，与 iLink 消息路径对齐。
2. **一次性迁移**：`scripts/migrate-tenant-keys.mjs` 把 browser id 下的 memories（按 content 去重）和 sessions（transcript 合并，旧在前）折叠到 providerUserId。幂等，重跑是 no-op。

## 后果

- 网页和微信两条路径现在指向同一个租户，记忆/会话不再分裂。
- 迁移是就地更新 `user_id`，不删数据；去重仅删除与目标完全相同的重复记忆。
- 未验证用户仍用 browser id 作为临时键（验证前不能对话，不会产生分裂数据）。

## 验收证据

- `tests/profile-store.test.mjs`：`stableKey` 解析 browser id→providerUserId、幂等、未验证回退。
- `tests/migrate-tenant-keys.test.mjs`：迁移 move/dedup/merge 及幂等性。
- 服务器实测：迁移后 `providerUserId` 下能召回「小新」「张工」两条记忆。
