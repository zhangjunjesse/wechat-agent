import path from 'node:path'

// 微信 iLink 发送侧按文件类型路由到不同原生消息通道（见 ADR-0012）：
// video/* → 视频消息（item.type=5）、image/* → 图片消息（item.type=2）、
// 其余 → 文件附件（item.type=4）。分类依据文件名扩展名白名单，识别失败一律
// 兜底为 'file'（文件附件不关心内容，什么都能发）。

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.m4v', '.ts', '.3gp', '.mpeg', '.mpg', '.rmvb'])
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif', '.ico', '.tif', '.tiff', '.avif'])

/** 按文件名扩展名分类：'video' | 'image' | 'file'（兜底）。 */
export function classifyMediaType(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase()
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (IMAGE_EXTS.has(ext)) return 'image'
  return 'file'
}
