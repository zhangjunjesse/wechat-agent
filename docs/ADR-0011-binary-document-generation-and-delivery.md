# ADR-0011: 二进制文档生成与微信交付

- 状态：Accepted
- 类型：Feature / Architecture
- 日期：2026-08-25

## 问题

Agent 可以写文本和发送文件，但此前没有生成真正的 `.xlsx`、`.docx`、`.pdf` 的能力，导致用户要求“整理成 Excel 后发给我”时，模型错误地把“不能生成二进制”和“不能发送二进制”混为一谈。

## 决策

新增本地确定性生成工具：

- `create_xlsx`：二维数组 → 真正的 XLSX ZIP/XML 文件；
- `create_docx`：标题/段落 → 真正的 DOCX ZIP/XML 文件；
- `create_pdf`：标题/文本 → PDF 文件。

生成文件统一落入当前用户沙箱。用户在微信中明确要求发送时，生成工具完成后必须继续调用 `send_file`；`send_file` 发送的是 Buffer，不区分文本与二进制。网页渠道仍使用下载链接。

暂不引入第三方文档库或 MCP：当前只需要基础文档生成，内置最小格式生成器可控、无额外依赖；复杂排版后续再扩展。

## 后果

- 能真正生成并发送 `.xlsx`、`.docx`、`.pdf`，不会把 CSV 冒充 Excel。
- 当前生成器覆盖基础表格/文本文档，不承诺复杂样式、公式、图表、分页排版。
- Office 文件通过 ZIP/XML 结构生成；PDF 当前为基础文本 PDF，中文字体嵌入与复杂排版仍是后续工作。

## 验收证据

- `tests/office-generators.test.mjs`：验证 XLSX/DOCX ZIP 文件头、PDF 文件头和最小内容。
- `npm test`：100/100 通过。
- `send_file` 继续复用既有 iLink CDN 上传和文件消息协议。
