import { tool } from '@openai/agents'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveUserPath } from '../services/user-sandbox.mjs'

// Conservative cap — this path is a reverse-engineered protocol (ADR-0009),
// not a documented one; stay well under any assumed real limit rather than
// find it out the hard way against a live channel.
const MAX_SEND_BYTES = 20 * 1024 * 1024

/** `send_file`: deliver a file the agent already wrote (via write_file) as a
 * real WeChat file attachment, when the current turn is a WeChat conversation.
 *
 * Why this is a separate tool from write_file rather than write_file always
 * pushing to WeChat: write_file is also used from the web chat channel (no
 * iLink session to send through) and for intermediate/scratch writes the
 * model may not want delivered immediately. `send_file` is the explicit
 * "give the user this exact file, right now, on WeChat" action; write_file's
 * download link (ADR-0008) remains the universal fallback that works on any
 * channel. `provider` is the same ILinkProvider instance used for text
 * replies — this tool only calls its `sendFile` method when the CURRENT
 * turn's channel (threaded through run context, see message-router.mjs /
 * agents-sdk-agent.mjs) says we're on WeChat. */
export function wechatSendTools({ provider, root = process.env.USER_FILES_ROOT || 'data/user-files' } = {}) {
  const sendFile = tool({
    name: 'send_file',
    description:
      '把用户目录下的一个文件，作为真实的微信文件消息直接发送给用户（对方在微信里能看到一个可点开/保存/转发的文件，不是链接）。' +
      '只有当前对话是通过微信进行的才能发送；如果是网页对话，会提示改用 write_file 的下载链接（那个在任何渠道都能用）。' +
      '文件必须先用 write_file 写好，这里传同样的 path。任意文件类型都可以发（.csv/.md/.txt/.html/.json 等），微信把它当普通文件附件处理。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要发送的文件相对路径，跟 write_file 用的一致' },
        filename: { type: 'string', description: '可选：微信里显示的文件名，默认用 path 的文件名部分' },
      },
      required: ['path'],
    },
    execute: async (input, ctx) => {
      const channel = ctx?.context?.channel
      if (!channel || channel.type !== 'ilink' || typeof provider?.sendFile !== 'function') {
        return '当前对话不是通过微信进行的，无法直接发送文件——请改用 write_file，我会给你一个下载链接。'
      }
      const userId = ctx?.context?.userId
      const full = resolveUserPath(root, userId, input.path)
      const buffer = await fs.readFile(full)
      if (buffer.length > MAX_SEND_BYTES) {
        return `文件太大（${(buffer.length / 1024 / 1024).toFixed(1)}MB），超过了 ${MAX_SEND_BYTES / 1024 / 1024}MB 的发送上限，请改用 write_file 的下载链接。`
      }
      const fileName = input.filename || path.basename(input.path)
      await provider.sendFile({ providerBotId: channel.providerBotId, toProviderUserId: channel.toProviderUserId, contextToken: channel.contextToken, fileName, buffer })
      return `已发送文件：${fileName}`
    },
  })
  return { sendFile }
}
