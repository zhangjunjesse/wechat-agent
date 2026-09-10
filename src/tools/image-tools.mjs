import { tool } from '@openai/agents'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveUserPath } from '../services/user-sandbox.mjs'
import { getImageApiKey, uploadImage, createImageTask, waitForImageTask, downloadImage, extFromUrl, IMAGE_SIZES, IMAGE_RESOLUTIONS } from '../services/image-api.mjs'

/** 图片生成/编辑/重绘工具（图像工坊技能）。三种模式：
 *   generate — 文生图 / 图生图（参考图仅作风格参考，重新生成版式）
 *   edit     — 图像编辑（保留原图主体结构，按 prompt 改元素）
 *   inpaint  — 局部重绘（只改 mask 透明区域，其余原样）
 * 参考图/mask 从用户沙箱读取；结果图片写入用户沙箱 images/ 目录并返回相对路径，
 * 模型随后应调用 send_file（微信）或给出下载链接交付。 */
export function imageTools({ root = process.env.USER_FILES_ROOT || 'data/user-files', getKey = getImageApiKey, api = { uploadImage, createImageTask, waitForImageTask, downloadImage } } = {}) {
  const imageGenerate = tool({
    name: 'image_generate',
    description:
      '图片处理：生成新图片、按参考图生成、编辑原图、局部重绘。' +
      '三种模式：generate=文生图/图生图（参考图仅作风格参考）；edit=图像编辑（保留原图主体，按描述改元素，如"在右上角加红色按钮"）；' +
      'inpaint=局部重绘（只改 mask 透明区域，其余原样）。' +
      'prompt 必填；edit/inpaint 需要 image（原图路径）；inpaint 还需要 mask（PNG，透明区域=待重绘区，尺寸须与原图一致）。' +
      '参考图用之前收到的图片附件（inbox/ 目录）或 write_file/run_code 生成的图片的相对路径。' +
      '生成完成后返回图片文件路径，必须再调用 send_file 把图片作为真实消息发给用户。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['generate', 'edit', 'inpaint'], description: '模式：generate（默认，文生图/图生图）、edit（编辑原图）、inpaint（局部重绘）' },
        prompt: { type: 'string', description: '图片内容描述（必填），编辑/重绘时描述要改什么、其余保持不变' },
        image: { type: 'string', description: '参考图/原图路径（相对用户目录），edit/inpaint 必填，generate 可选（风格参考）' },
        mask: { type: 'string', description: 'mask 图路径（仅 inpaint）：PNG 含 alpha 通道，透明区域为待重绘区' },
        size: { type: 'string', description: `输出比例，默认 1:1；可选 ${IMAGE_SIZES.join('/')}` },
        resolution: { type: 'string', description: `分辨率档位，默认 1k；可选 ${IMAGE_RESOLUTIONS.join('/')}` },
        n: { type: 'number', description: '生成数量，默认 1' },
      },
      required: ['prompt'],
    },
    execute: async (input, ctx) => {
      const key = getKey()
      if (!key) return '未配置图片服务 API Key，请联系管理员配置后重试。'
      const userId = ctx?.context?.userId
      const mode = input.mode || 'generate'
      if (!IMAGE_RESOLUTIONS.includes(input.resolution || '1k')) return `不支持的 resolution：${input.resolution}（可选 ${IMAGE_RESOLUTIONS.join('/')}）`
      if (input.size && !IMAGE_SIZES.includes(input.size)) return `不支持的 size：${input.size}（可选 ${IMAGE_SIZES.join('/')}）`

      try {
        // Validate mode requirements BEFORE uploading anything.
        if ((mode === 'edit' || mode === 'inpaint') && !input.image) {
          return `${mode} 模式必须提供原图（image 参数）`
        }
        if (mode === 'inpaint' && !input.mask) {
          return 'inpaint 模式必须提供 mask 图（PNG，透明区域为待重绘区）'
        }
        // Read and upload reference image / mask from the user sandbox.
        const refs = []
        if (input.image) {
          const full = resolveUserPath(root, userId, input.image)
          const buf = await fs.readFile(full)
          const url = await api.uploadImage({ buffer: buf, fileName: path.basename(input.image), apiKey: key })
          refs.push(url)
        }
        let maskUrl = null
        if (input.mask) {
          const full = resolveUserPath(root, userId, input.mask)
          const buf = await fs.readFile(full)
          maskUrl = await api.uploadImage({ buffer: buf, fileName: path.basename(input.mask), apiKey: key })
        }

        const taskId = await api.createImageTask({ mode, prompt: input.prompt, size: input.size || '1:1', resolution: input.resolution || '1k', n: Math.max(1, Math.min(4, Number(input.n) || 1)), refs, maskUrl, apiKey: key })
        const urls = await api.waitForImageTask({ taskId, apiKey: key })

        const saved = []
        for (const url of urls) {
          const rel = `images/img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${extFromUrl(url)}`
          const full = resolveUserPath(root, userId, rel)
          await api.downloadImage({ url, destPath: full, apiKey: key })
          saved.push(rel)
        }
        return `图片处理完成（${mode} 模式，${saved.length} 张）：\n${saved.map((p) => `- ${p}`).join('\n')}\n请调用 send_file 把这些图片作为真实消息发给用户。`
      } catch (e) {
        return `图片处理失败：${e.message}`
      }
    },
  })
  return { imageGenerate }
}
