# ADR-0010: iLink 入站附件接收与用户沙箱处理

- 状态：Accepted
- 类型：Architecture / Feature / Security
- 日期：2026-08-25

## 问题

iLink 入站处理此前只提取文本，用户发送给微信 Bot 的文件、图片、视频和语音被丢弃。Agent 无法知道附件名称、无法读取附件，也无法基于附件生成结果并回传。

## 决策

在 Provider 层处理 iLink `item_list` 中的非文本项：

1. 从 `file_item`/`image_item`/`video_item`/`voice_item` 的 media 引用下载 CDN 密文；
2. 使用消息携带的 AES-128 密钥解密；
3. 以服务端稳定 `providerUserId` 为租户边界，将文件写入 `USER_FILES_ROOT/<userId>/inbox/`；
4. 只把安全的相对路径、文件名、类型和大小传给 Agent，内容仍须由 Agent 实际调用 `read_file`/`run_code` 读取；
5. 将附件元数据写进 session transcript；
6. 保留下载失败元数据，禁止 Agent 声称已经读到失败附件；
7. 继续复用 `send_file` 完成结果文件的微信回传。

使用本地代码和 iLink CDN 协议，不引入 MCP；单文件上限 50MB，文件名通过 basename 和字符白名单清理。

## 后果

- 文件处理闭环为：微信入站 → 下载解密 → 用户沙箱 → Agent 工具处理 → `send_file` 回传。
- 非文本媒体具备统一附件元数据；图片/视频后续可在同一入口增加专门解析能力。
- CDN 和协议字段属于逆向兼容边界，仍需真实微信文件消息验证；当前单测覆盖协议形状、解密、隔离和持久化。

## 验收证据

- `tests/ilink-provider.test.mjs`：模拟 iLink file_item、AES 加密 CDN 响应，验证解密落盘。
- `tests/contracts.test.mjs` 及全量测试：纯文本事件合同和既有路由保持兼容。
- `npm test`：99/99 通过。
