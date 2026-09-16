import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveUserPath } from './user-sandbox.mjs'
import { MAX_INBOUND_FILE_BYTES, sanitizeInboundName } from './ilink-media.mjs'

/** 把 wechat-sync 媒体目录里的一个历史聊天附件拷贝进用户沙箱 inbox/（ADR-0029）。
 *
 * 数据通路：媒体真身在宿主机 /opt/wechat-sync/data/media/<media_id>.<ext>，
 * 已随 sync_inbox.db 同一挂载点只读进容器（deploy/docker-compose.yml 的
 * /wechat-sync-data:ro）——这里只做本地只读拷贝，不经任何 HTTP、不动源文件。
 *
 * 安全边界（关键）：本函数**不做**租户校验——attachment 必须来自调用方已经
 * 过 WechatLogStore 访问控制（accessibleChats）筛出的消息，绝不能直接接受
 * 模型给的裸 media_id（媒体存储是全局的，裸 id 会穿透"用户只能看自己所在
 * 会话"的边界，见 ADR-0029）。落盘目录/文件名清洗/50MB 上限复用 ADR-0010
 * 入站附件的同一套（同一个 inbox/，read_file/image_generate/send_file 通吃）。 */
export async function fetchChatMedia({ attachment, mediaDir, userId, root }) {
  if (!mediaDir) throw new Error('未配置微信媒体目录，无法取回附件文件')
  const mediaId = String(attachment?.mediaId || '')
  // media_id 来自数据库而非模型，但仍然收紧到十六进制串：防御脏数据拼路径
  if (!/^[0-9a-fA-F]{8,64}$/.test(mediaId)) throw new Error('附件缺少有效的 media_id')

  // 定位源文件：优先按 attachment.ext 直拼；缺 ext 时按 media_id 前缀扫描
  // （与 receiver.py 服务媒体时 `fn.split(".")[0] == mid` 的解析一致）
  let src = null
  if (attachment.ext) {
    const candidate = path.join(mediaDir, `${mediaId}.${String(attachment.ext).replace(/[^0-9a-zA-Z]/g, '')}`)
    try { await fs.access(candidate); src = candidate } catch { /* 落到目录扫描 */ }
  }
  if (!src) {
    for (const fn of await fs.readdir(mediaDir)) {
      if (fn.split('.')[0] === mediaId) { src = path.join(mediaDir, fn); break }
    }
  }
  if (!src) throw new Error('媒体文件不在同步目录里（可能还没同步完成，稍后再试）')

  const stat = await fs.stat(src)
  if (stat.size > MAX_INBOUND_FILE_BYTES) throw new Error('附件超过 50MB 上限，无法取回')

  const ext = path.extname(src)
  let name = sanitizeInboundName(attachment.filename || '', `${attachment.kind || 'media'}-${mediaId}${ext}`)
  if (!path.extname(name) && ext) name += ext
  const rel = `inbox/${Date.now()}-${name}`
  const full = resolveUserPath(root, userId, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.copyFile(src, full)
  return { name, path: rel, size: stat.size, kind: String(attachment.kind || 'file') }
}
