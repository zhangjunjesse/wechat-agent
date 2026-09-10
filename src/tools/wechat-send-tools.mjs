import { tool } from '@openai/agents'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveUserPath } from '../services/user-sandbox.mjs'
import { classifyMediaType } from '../services/media-type.mjs'

// Conservative caps — this path is a reverse-engineered protocol (ADR-0009 /
// ADR-0012), not a documented one; stay well under any assumed real limit
// rather than find it out the hard way against a live channel. Plain files
// keep the original 20MB cap (documents rarely exceed it); media gets a wider
// 100MB cap, otherwise "send a video" would be dead on arrival — videos are
// naturally far larger than 20MB. Both are configurable via env.
const MAX_FILE_BYTES = Number(process.env.SEND_FILE_MAX_MB || 20) * 1024 * 1024
const MAX_MEDIA_BYTES = Number(process.env.SEND_MEDIA_MAX_MB || 100) * 1024 * 1024

/** `send_file`: deliver a file the agent already wrote (via write_file) as a
 * real WeChat message — video files as a native playable video, images as a
 * native image, everything else as a file attachment — when the current turn
 * is a WeChat conversation (ADR-0012).
 *
 * Why this is a separate tool from write_file rather than write_file always
 * pushing to WeChat: write_file is also used from the web chat channel (no
 * iLink session to send through) and for intermediate/scratch writes the
 * model may not want delivered immediately. `send_file` is the explicit
 * "give the user this exact file, right now, on WeChat" action; write_file's
 * download link (ADR-0008) remains the universal fallback that works on any
 * channel. `provider` is the same ILinkProvider instance used for text
 * replies — this tool only calls its sendImage/sendVideo/sendFile methods
 * when the CURRENT turn's channel (threaded through run context, see
 * message-router.mjs / agents-sdk-agent.mjs) says we're on WeChat. */
export function wechatSendTools({ provider, root = process.env.USER_FILES_ROOT || 'data/user-files' } = {}) {
  const sendFile = tool({
    name: 'send_file',
    description:
      '把用户目录下的一个文件，作为真实的微信消息直接发送给用户（对方在微信里能看到，不是链接）。' +
      '视频文件（.mp4/.mov/.avi/.mkv 等）会以微信原生视频消息发送，对方可直接播放；' +
      '图片文件（.jpg/.png/.gif/.webp 等）以微信图片消息发送；' +
      '其余任意类型（.csv/.md/.txt/.html/.json/.docx/.xlsx/.pdf/.zip 等）以微信文件附件发送，可点开/保存/转发。' +
      '只有当前对话是通过微信进行的才能发送；如果是网页对话，请改用 write_file 的下载链接（那个在任何渠道都能用）。' +
      '文件必须先用 write_file 写好，这里传同样的 path。',
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
      if (!channel || channel.type !== 'ilink') {
        return '当前对话不是通过微信进行的，无法直接发送文件——请改用 write_file，我会给你一个下载链接。'
      }
      const userId = ctx?.context?.userId
      const full = resolveUserPath(root, userId, input.path)
      const buffer = await fs.readFile(full)
      const kind = classifyMediaType(input.filename || input.path)
      const cap = kind === 'file' ? MAX_FILE_BYTES : MAX_MEDIA_BYTES
      if (buffer.length > cap) {
        const capMb = cap / 1024 / 1024
        return `文件太大（${(buffer.length / 1024 / 1024).toFixed(1)}MB），超过了 ${capMb}MB 的发送上限，请改用 write_file 的下载链接。`
      }
      const fileName = input.filename || path.basename(input.path)
      const preferred = kind === 'image' ? 'sendImage' : kind === 'video' ? 'sendVideo' : 'sendFile'
      let send = provider[preferred]
      // Fallback: a provider that only implements the FILE channel can still
      // deliver media as a plain file attachment (ADR-0012 compat).
      if (typeof send !== 'function' && preferred !== 'sendFile' && typeof provider.sendFile === 'function') {
        send = provider.sendFile
      }
      if (typeof send !== 'function') {
        return '当前微信通道无法直接发送该类型文件——请改用 write_file，我会给你一个下载链接。'
      }
      await send({ providerBotId: channel.providerBotId, toProviderUserId: channel.toProviderUserId, contextToken: channel.contextToken, fileName, buffer })
      // Label the actual channel used: media that fell back to the FILE
      // channel is delivered as a file attachment, not as media.
      const deliveredKind = preferred !== 'sendFile' && send !== provider.sendFile ? kind : 'file'
      const label = deliveredKind === 'image' ? '图片' : deliveredKind === 'video' ? '视频' : '文件'
      return `已发送${label}：${fileName}`
    },
  })
  return { sendFile }
}
