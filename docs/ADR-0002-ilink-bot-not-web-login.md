# ADR-0002: 使用 iLink Bot 绑定，不使用网页版微信登录

- 状态：Accepted for the current prototype
- 类型：Architecture / Security

## 观察

扫码后手机提示“网页版微信登录确认，暂时无法登录”。这是旧 `WeixinWebProvider` 的登录入口行为，不是用户期望的 Bot 绑定流程。

## 决策

公网/默认启动入口只使用 `ILinkProvider`。`WeixinWebProvider` 保留为历史协议实验代码，但不再由 `src/server.mjs` 注册，也不作为 Bot 绑定入口。

iLink Bot 的二维码应来自：

```text
GET https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3
```

扫码状态来自：

```text
GET https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=...
```

确认成功后才取得 `ilink_bot_id` 和 `bot_token`，随后通过 iLink 的 `getupdates` / `sendmessage` 收发消息。

## 后果

- 不会再把旧版“网页版微信登录”二维码展示给用户。
- iLink 是 Bot 绑定协议，不等同于登录用户的网页版微信。
- iLink 当前资料声明主要支持个人号 1v1，不承诺微信群聊或完整微信通讯录资料。
- 真实 Bot 二维码必须来自 iLink 服务；若 iLink 返回不可用或服务拒绝，需要展示明确错误，而不能回退到网页版微信登录。
