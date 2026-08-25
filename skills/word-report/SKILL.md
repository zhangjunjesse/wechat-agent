---
name: word-report
description: 将用户提供的资料整理成结构化的 Word 文档
---

# 生成 Word 文档

当用户要求"整理成 Word""生成文档""写成报告"时使用本技能。

步骤：
1. 用 read_file 读取用户目录下的资料文件；
2. 将内容整理为结构化文档（标题、章节、正文）；
3. 用 write_file 写成一个 .docx 兼容的文本或 html 文档（后续可接入真正的 docx 生成器）；
4. 告知用户文件路径。

注意：
- 只能读写用户自己的目录（read_file / write_file 已做沙箱隔离）；
- 生成的文档先保存为 .html 或 .md，后续再升级为真正的 Word 格式。
