# wechat-agent

多租户微信 Bot Agent 服务的本地首版骨架。

> 当前状态：已完成 provider-neutral 的绑定状态机、租户隔离合同和 Mock Provider；真实微信 Bot SDK 适配尚未实现。

## 目标

- 公网入口：`https://datadefender.cn/wechat-agent`
- 用户通过二维码绑定自己的微信 Bot
- 每个用户拥有独立的 bot binding、Agent conversation 和消息路由空间
- 一个服务进程服务多个用户；只有 SDK 要求独占运行时才引入按 Bot 的 worker
- 不把微信凭据、Token、二维码内容或个人资料提交到 Git

## SDK 资料边界

参考文档：[用户提供的 CSDN SDK 文章](https://blog.csdn.net/gitblog_00184/article/details/160968796)

当前开发环境无法取得该文章正文/API schema，因此真实 provider 适配器不猜测接口。需要补充 SDK 仓库、API 文档或接口示例后，才能接通真实扫码、用户信息、收发消息。

## 本地验证

```powershell
node --test tests/*.test.mjs
```

当前测试只验证不依赖第三方 SDK 的合同与状态机，不宣称真实微信扫码已经可用。
