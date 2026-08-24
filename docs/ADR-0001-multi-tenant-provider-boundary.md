# ADR-0001: 多租户 Agent 与可替换微信 Bot Provider 边界

- 状态：Proposed（真实 SDK 合同待验证）
- 类型：Architecture / Feature
- 日期：2026-08-21

## 问题

需要在 `datadefender.cn/wechat-agent` 提供扫码绑定和微信 Bot 对话，同时隔离多个用户的身份、Bot 绑定、Agent 会话和消息。当前尚未取得真实 SDK 的可执行 API 合同，不能安全地把某个猜测的 SDK 接口固化到业务层。

## 决策方向

采用一个多租户服务进程，业务层只依赖 `BotProvider` 合同。每个租户有独立的 `userId`、`bindingId`、`botId` 和会话命名空间；Provider 负责二维码、扫码状态、用户资料、入站事件和发送消息。默认不为用户创建独立进程；只有 Provider 明确要求独占运行时才增加按 Bot 的 Worker。

## 备选方案

1. **每个用户一个 Agent 进程**：隔离直观，但资源、重启、升级和租户数增长成本高；当前不选。
2. **业务层直接绑定具体 SDK**：实现快但难以测试，且在 SDK 合同未确认时风险最高；不选。
3. **多租户服务 + Provider 边界**：业务隔离和 SDK 替换可测试；选为当前方向。

## 不在本记录中承诺

- 不假设个人微信存在官方公网 Bot API。
- 不在没有 SDK 文档/凭据/回调样例时声称真实扫码可用。
- 不在本地保存真实微信 Token 或用户隐私资料。

## 验收证据

- `tests/contracts.test.mjs`：绑定状态转换、租户隔离、幂等回调和消息路由合同。
- 真实 SDK 端到端扫码：待取得 SDK API 合同和测试账号后执行，当前明确未验证。
