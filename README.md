# wechat-agent

多租户微信个人助手：腾讯 iLink Bot 负责扫码绑定和消息通道，OpenAI Agents SDK 负责 Agent 对话，公网同步的微信聊天记录负责用户资料核验与上下文。

## 公网入口

```text
https://datadefender.cn/wechat-agent/
```

## 完整流程

1. 打开公网入口，输入用户标识并获取 iLink Bot 二维码。
2. 使用微信扫码并确认 Bot 绑定。
3. 扫码“助手”二维码，添加微信联系人“助手”。
4. 向“助手”发送页面生成的一次性验证码。
5. 服务从公网同步微信记录中找到验证码发送者，保存 `wxid`、昵称和核验时间。
6. 页面显示个人助手聊天框；每个用户的会话历史独立。
7. 微信 iLink 消息和网页消息都进入同一个 Agent。

## 运行配置

```env
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_MODEL=deepseek-chat
AGENT_SDK=openai
WECHAT_SYNC_BASE_URL=https://datadefender.cn
WECHAT_SYNC_ACCESS_KEY=...
```

密钥只放在服务器环境文件中，不要提交 Git。

## 本地开发

```powershell
npm install
npm test
$env:OPENAI_API_KEY='...'
$env:AGENT_SDK='openai'
npm start
```

## 能力边界

- iLink 当前主要是个人 Bot 1 对 1 消息通道，不能当作完整微信通讯录 API。
- 微信昵称和 wxid 通过“助手 + 一次性验证码 + 已同步聊天记录”核验获得。
- Agent 默认可以读取与已核验昵称/wxid匹配的最近微信记录，并要求模型区分本人消息和 `@` 消息。
- Bot Token、模型 Key、微信同步 Key 和运行时 JSON 数据不得提交 Git。
