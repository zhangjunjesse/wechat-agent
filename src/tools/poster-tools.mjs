import { tool } from '@openai/agents'
import { renderPoster } from '../services/poster-render.mjs'
import { resolveUserPath } from '../services/user-sandbox.mjs'

/** 海报渲染工具（skills/poster-render 的通道）。
 *
 * 把 HTML 渲染成海报长图 PNG（无头浏览器截图）。与 image-studio 技能的分工：
 * image-studio 出"视觉图"（AI 生图，文字不可靠）；poster-render 出"信息图"
 * （HTML 排版 + 截图，中文/现代 CSS 完美支持）——日报海报走这里。 */
export function posterTools({ root = process.env.USER_FILES_ROOT || 'data/user-files' } = {}) {
  const renderPosterTool = tool({
    name: 'render_poster',
    description:
      '把 HTML 渲染成海报长图 PNG（无头浏览器截图，中文与现代 CSS 完美支持、不乱码）。' +
      '用户要求"生成海报""把这段内容做成图片""做成长图""图文一体的卡片"时使用。' +
      'html 参数必须是完整 HTML 文档（含 <style>，建议 body 宽度 750px）；生成完成后必须调用 send_file 把图片作为真实消息发给用户。',
    parameters: {
      type: 'object',
      properties: {
        html: { type: 'string', description: '要渲染的完整 HTML 文档（含内联 <style>，body 建议宽度 750px）' },
        width: { type: 'number', description: '图片宽度像素，默认 750' },
      },
      required: ['html'],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      const rel = `images/poster-${Date.now()}.png`
      const full = resolveUserPath(root, userId, rel)
      try {
        await renderPoster(input.html, { width: input.width || 750, outPath: full })
        return `海报已生成：${rel}\n请调用 send_file 把图片作为真实消息发给用户。`
      } catch (e) {
        return `海报渲染失败：${e.message}`
      }
    },
  })
  return { renderPoster: renderPosterTool }
}
