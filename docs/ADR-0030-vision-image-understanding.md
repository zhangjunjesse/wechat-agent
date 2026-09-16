# ADR-0030: 看图理解——独立视觉客户端接 gpt-5.6-terra，不碰主对话链路

- 状态：Accepted
- 类型：Feature / External integration
- 日期：2026-09-16
- 关联：ADR-0029（历史聊天附件取回，本记录复用其落盘的 `inbox/` 沙箱）、
  ADR-0010（入站附件）、ADR-0012（媒体类型分类）、
  deepseek-thinking-client 相关三次生产 400 修复记录（本记录刻意绕开那条链路的直接原因）

## 问题

agent 现有的"图片能力"只有转发（`send_file`）和变换（`image_generate` 的 edit/inpaint 模式，
调外部图像 API 重绘）——**完全没有"看懂图里是什么"的能力**。这个缺口从 ADR-0010（入站附件）
时代就存在，只是这次 ADR-0029 让"取历史聊天图片"变容易了，用户才第一次真正摸到它：拿到一张
图，agent 只能干瞪眼，答不出"这图讲的是什么"。

## 决策

### 1. 独立 `VisionClient`（`src/services/vision-client.mjs`），刻意不接主链路

单轮、无工具、标准 OpenAI vision content block（`text` + `image_url` data URI base64），
直接 POST `${OPENAI_BASE_URL}/chat/completions`，不经过 `deepseek-thinking-client` /
`AgentsSdkAgent` 的主对话链路。

**为什么刻意隔离**：主链路是为多轮工具调用 + DeepSeek `reasoning_content` 强制回传设计的，
历史上因这条约束出过三次生产 400 事故（`b2b66e3`/`ebccf61`/`2cc5f47`）。视觉调用是一次性
单轮问答，部署前的生产网关人工冒烟测试已实测 `usage.reasoning_tokens: 0`——没有任何理由
让它沾上那套复杂度。实现上对齐 `SubagentRunner` 的简单模式：无 session、无 serial-queue、
不重试，只有一个 60 秒 `AbortController` 超时防止单次调用卡死一次工具执行。

### 2. 新工具 `image_describe`（`image-tools.mjs`）

读用户沙箱内的图片文件路径（不区分是 ADR-0010 入站收到的还是 ADR-0029 从历史聊天取回的——
同一个 `inbox/` 目录天然通用，不需要新增"这张图从哪来"的分支），先用 `classifyMediaType`
（复用 ADR-0012 现成的分类白名单）拦截非图片路径（不把任意字节喂给视觉模型），再调
`VisionClient.describeImage`。`question` 参数可选，不填时用通用描述 prompt。

### 3. 条件注册——未配置时工具"压根不存在"，不是"存在但报错"

与 `lark_*`/`wechat_*` 同一套 fail-closed 模式：只有配置了 `VISION_MODEL` 环境变量时，
`server.mjs` 才会 `new VisionClient(...)`（复用已有的 `OPENAI_BASE_URL`/`OPENAI_API_KEY`，
不新增一套凭据配置）；未配置时 `vision=null`，`buildTools` 里 `image.imageDescribe` 为
`null`，`image_describe` 不会被塞进工具列表——模型的工具清单里根本看不到这个选项，不会
出现"看到工具、调用后才发现没配置"的体验。

### 4. 部署前的人工冒烟验证（模型选型的直接依据）

自动化测试一律 mock `fetch`（不在 CI/单测里打真实网关，遵循本项目一贯的测试纪律）；
模型是否真的可用、返回是否有意义，靠部署前一次性对生产真实网关+key 发起真实请求验证：

```
model: gpt-5.6-terra
返回："图片介绍了一种通过将负载均衡算法改为'加权轮询（WRR）'并开启 CLB 原生会话保持来
实现请求固定转发的方案，分别说明了四层基于源 IP、七层基于 Cookie 的会话保持方式及其局限性。"
usage.reasoning_tokens: 0
```

测试图取自生产真实聊天记录，描述内容与该聊天的上下文语义完全对得上（不是泛泛而谈的
套话），且 `reasoning_tokens: 0` 印证了"不需要 DeepSeek thinking 链路"的判断——这是
选择"独立客户端+同一网关不同模型"这条路线、而不是"想办法让主模型也具备视觉"的直接证据。

## 备选（不选的理由）

- **让主 agent 的 `deepseek-v4-flash` 自己读图**：不确定当前模型/网关组合是否支持 vision
  content block；就算支持，把视觉内容塞进主对话的多轮工具调用链路会重新引入
  `reasoning_content` 那套已经出过三次事故的复杂度，用一个独立工具换掉这个风险很划算。
- **agent 看到图片消息自动触发 `image_describe`**：本 ADR 刻意不做——每张图一次额外 LLM
  调用是实打实的成本，应该由 agent 按需判断要不要看图（现有工具调用模型本来就是"模型自己
  决定何时调用哪个工具"），而不是无条件触发。

## 验收证据

- `node --test tests/*.test.mjs` → **364/364 全绿**（基线 345 + 本次新增 19，与本 ADR
  直接相关 10 条：`vision-client.test.mjs` 6——标准请求体形状（含尾斜杠归一化、`Bearer`
  鉴权头、`image_url` data URI 正确拼装）、无 `question` 时的通用中文 prompt 兜底、网关
  错误原样透传（状态码+响应体摘要，不吞异常）、空内容视为错误（不会把空字符串当成"描述
  完成"悄悄放过）、超时被 `AbortController` 正确掐断并给出可读提示、`mimeForImage` 扩展名
  映射；`image-tools.test.mjs` 4——`image_describe` 读沙箱图片并返回视觉模型文本、非图片
  路径直接拒绝且**不发起任何真实调用**（用 spy 验证零调用，不是靠人工检查）、网关失败与
  文件不存在时的清晰错误文案、**`VISION_MODEL` 未配置时工具对象为 `null`、不出现在工具
  列表里**）。其余 9 条属于 ADR-0029（历史附件取回），一并列在该记录。
- 生产网关人工冒烟测试（见上，非自动化）：HTTP 200，真实语义正确。

## 遗留（诚实边界）

- **只做静态图片**：视频抽帧、语音转写、`docx`/`pdf`/`xlsx` 等文档解析明确不做。用户最初的
  诉求是"帮用户处理所有聊天记录里面的文件"，本记录连同 ADR-0029 交付的是"图片"这一类
  （取回 + 转发 + 理解全部打通）；非图片类型目前只能取回+转发（ADR-0029），agent 仍然
  读不懂内容——这是已知的范围收窄，不是遗漏。
- **不会被自动调用**：如果模型自己判断力不够主动，用户体验上可能仍需要明确说"帮我看看
  这张图"。是否需要更强的提示词引导，留待真实使用反馈后再定，本次不预先过度设计。
- **无结果缓存**：同一张图被问两次会打两次视觉模型请求（对话中未出现这个场景，暂不做
  这个优化，避免过早引入复杂度）。
- **生产 `VISION_MODEL` 的实际启用时间点**：本记录的代码合并与生产环境变量启用是两个
  独立的部署动作（后者需要 `docker rm + docker run` 让新 env 生效，`docker restart` 不会
  重读 env-file）——以 `docs/STATUS.md` 里记录的实际部署时间为准。
