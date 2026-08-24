# wechat-agent

多租户微信 Bot Agent 服务的本地首版骨架。

> 当前状态：已完成 provider-neutral 绑定/路由、Mock Provider，以及基于公开 WeixinBot 协议文档的实验性 Web Weixin Provider；真实扫码仍需测试账号和实际环境验证。

## 目标

- 公网入口：`https://datadefender.cn/wechat-agent`
- 默认使用腾讯 iLink Bot 协议（`src/providers/ilink-provider.mjs`）
- 用户通过二维码绑定自己的微信 Bot
- 每个用户拥有独立的 bot binding、Agent conversation 和消息路由空间
- 一个服务进程服务多个用户；只有 SDK 要求独占运行时才引入按 Bot 的 worker
- 不把微信凭据、Token、二维码内容或个人资料提交到 Git

## SDK 资料边界

参考文档：[用户提供的 CSDN SDK 文章](https://blog.csdn.net/gitblog_00184/article/details/160968796)

已补充参考实现仓库 [Urinx/WeixinBot](https://github.com/Urinx/WeixinBot) 的公开协议资料：UUID、二维码、扫码状态、登录页、`webwxinit`、`synccheck`、`webwxsync` 和 `webwxsendmsg`。对应适配器是实验性实现，协议属于较老的 Web WeChat 接口，不能据此保证当前微信账号仍可登录；部署前必须用测试账号做真实扫码验证。

## 本地验证

```powershell
node --test tests/*.test.mjs
```

当前测试验证 HTTP 组合、绑定/路由隔离、旧 Web Weixin 协议适配器和腾讯 iLink 协议适配器的请求/响应映射；真实扫码仍需在你的微信账号上做端到端测试。iLink 当前资料明确支持 1v1 私聊，不支持群聊；用户资料来自扫码确认返回的 `ilink_user_id`，昵称/微信号等详细资料是否由当前 iLink 返回需要实测确认。
