#!/usr/bin/env node
/** ADR-0032 一次性回填脚本：把已核验用户 profiles.json 里缺失的 wxid 补上。
 *
 * 为什么需要它：`VerificationService`/`RemoteWechatVerifier` 修复后（见
 * profile-verifier.mjs 的 chatWxid 兜底），新核验的用户会正确拿到 wxid；但
 * **存量**用户（在修复前核验过的）profile 里 wxid 已经落定为空字符串，不会
 * 因为代码修好而自动补上——服务不会重放历史核验。这个脚本就是补那一段历史。
 *
 * 方法（"反查"，ADR-0032 认定的首选方案，唯一在此脚本里实现的方案）：
 *   每条 profile 在核验成功时就已经记录了 `code`（验证码原文）和 `messageTs`
 *   （命中那条消息的 ts，unix 秒——与聊天库 messages.ts 同一个单位，同一个
 *   来源，见 profile-verifier.mjs 的 findAssistantCode）。拿这两个字段回聊天库
 *   `messages` 表按 `content LIKE '%code%' AND ts ≈ messageTs` 精确反查回
 *   当年那条被用来核验的消息本身，取它的 `sender_wxid`（如果非空）或者
 *   `chat_wxid`（1:1 会话的 chat_wxid 本身就是对方的真实 wxid，见 ADR-0007/
 *   profile-verifier.mjs 的同一条推理）。
 *
 * 为什么不用"按 chat_roster 昵称反查"这条路（考虑过，否掉了）：那正是
 * accessibleChats 刚刚从"并列 OR"改成"分级 + 歧义拒绝"要防的同一个坑——
 * 昵称本身不唯一（生产真实数据：4 个不同用户共享昵称"Z.俊"），拿昵称去查
 * chat_roster 一样会撞见多个不同 member_wxid，回填脚本没有比线上服务更多的
 * 信息去打破这个平局。验证码是全局唯一（6 位数字）+ 窄时间窗（±WINDOW_SEC 秒）
 * 的强证据，能绕开这个歧义；昵称查询不能，所以不做。
 *
 * 安全边界：
 *   - **默认 dry-run**，只打印计划改什么、依据是什么；`--apply` 才真的写
 *     profiles.json。
 *   - 只处理"命中恰好 1 条候选消息"的 profile；0 条（消息已不在保留窗口/被
 *     清理）或 >1 条（罕见但不能排队——多个候选无法唯一确定）一律跳过并打印
 *     原因，绝不猜。
 *   - 只信 `is_group=0`（1:1 会话）的候选消息；群消息里出现的验证码文本不能
 *     当成任何人的个人 wxid。`chat_wxid` 恰好是 `filehelper`（微信内置的"文件
 *     传输助手"自聊）也排除——那是开发者自测通道，不是某个外部用户的身份。
 *   - **不在服务启动时自动跑**——这是一次性、有歧义风险的手工操作，见
 *     ADR-0032 的决策记录。
 *
 * 用法：
 *   node scripts/backfill-wechat-wxid.mjs                    # dry-run，只打印
 *   node scripts/backfill-wechat-wxid.mjs --apply             # 真的写 profiles.json
 *   PROFILES_FILE=... WECHAT_LOG_DB=... node scripts/backfill-wechat-wxid.mjs
 *   node scripts/backfill-wechat-wxid.mjs --window-seconds 10 # 默认 5 秒容差
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const FILEHELPER_WXID = 'filehelper'

/** 给一条缺 wxid 的 profile 找回填候选。纯函数，方便单测（不碰真实文件）。
 * `db` 是一个已打开的 `node:sqlite` DatabaseSync（只读挂载的聊天库）。
 * 返回 `{ plan: {...} }`（可回填）或 `{ skip: reason }`（不可回填，如实说明）。 */
export function resolveBackfill(db, profile, { windowSec = 5 } = {}) {
  if (String(profile?.wxid || '').trim()) return { skip: '已有 wxid，跳过' }
  const nickname = String(profile?.nickname || '').trim()
  const code = String(profile?.code || '').trim()
  const messageTs = Number(profile?.messageTs || 0)
  if (!code) return { skip: '没有记录验证码原文（code），无法反查' }
  if (!messageTs) return { skip: '没有记录验证消息时间戳（messageTs），无法反查' }

  const rows = db.prepare(
    `SELECT chat_wxid, chat_display, is_group, sender_wxid, sender_display, ts, content
     FROM messages
     WHERE content LIKE ? ESCAPE '\\' AND ts BETWEEN ? AND ? AND is_group = 0
     ORDER BY ts`
  ).all(`%${escapeLike(code)}%`, messageTs - windowSec, messageTs + windowSec)

  if (rows.length === 0) {
    return { skip: `验证码消息在聊天库里找不到（code=${code} ts≈${messageTs}±${windowSec}s，可能已超出保留窗口或被清理）` }
  }
  if (rows.length > 1) {
    return { skip: `命中 ${rows.length} 条候选消息，无法唯一确定，需要人工核查（code=${code} ts≈${messageTs}）` }
  }
  const row = rows[0]
  const candidateWxid = String(row.sender_wxid || '').trim() || String(row.chat_wxid || '').trim()
  if (!candidateWxid || candidateWxid === FILEHELPER_WXID) {
    return { skip: `命中的消息所在会话没有可用的个人 wxid（chat_wxid=${row.chat_wxid}），跳过` }
  }
  return {
    plan: {
      userId: profile.userId,
      nickname,
      wxid: candidateWxid,
      evidence: {
        chatWxid: row.chat_wxid,
        chatDisplay: row.chat_display,
        ts: row.ts,
        sourceField: row.sender_wxid ? 'sender_wxid' : 'chat_wxid（1:1 会话本身即对方 wxid，见 ADR-0007）',
        contentExcerpt: String(row.content || '').slice(0, 40),
      },
    },
  }
}

function escapeLike(text) {
  return String(text).replace(/[\\%_]/g, (c) => '\\' + c)
}

/** CLI 入口：读 profiles.json，逐条决策，打印依据；--apply 才写回。 */
function main() {
  const argv = process.argv.slice(2)
  const apply = argv.includes('--apply')
  const windowIdx = argv.indexOf('--window-seconds')
  const windowSec = windowIdx >= 0 && argv[windowIdx + 1] ? Number(argv[windowIdx + 1]) : 5

  const profilesFile = process.env.PROFILES_FILE || path.resolve('data/profiles.json')
  const wechatLogDb = process.env.WECHAT_LOG_DB || ''
  if (!wechatLogDb || !fs.existsSync(wechatLogDb)) {
    console.error(`WECHAT_LOG_DB 未配置或文件不存在：${JSON.stringify(wechatLogDb)}`)
    process.exit(2)
  }
  if (!fs.existsSync(profilesFile)) {
    console.error(`PROFILES_FILE 不存在：${profilesFile}`)
    process.exit(2)
  }

  const profiles = JSON.parse(fs.readFileSync(profilesFile, 'utf8'))
  if (!Array.isArray(profiles)) {
    console.error(`${profilesFile} 内容不是数组，中止`)
    process.exit(2)
  }

  const db = new DatabaseSync(wechatLogDb, { readOnly: true })
  console.log(`${apply ? '[APPLY]' : '[DRY-RUN，加 --apply 才会真的写文件]'} 扫描 ${profiles.length} 条 profile，容差窗口 ±${windowSec}s`)

  let backfilled = 0, skipped = 0
  const next = profiles.map((profile) => {
    const result = resolveBackfill(db, profile, { windowSec })
    if (result.skip) {
      skipped++
      console.log(`  [跳过] ${profile.userId} (${profile.nickname || '无昵称'}): ${result.skip}`)
      return profile
    }
    const { plan } = result
    backfilled++
    console.log(`  [回填] ${plan.userId} (${plan.nickname}): wxid = ${plan.wxid}`)
    console.log(`          依据：chat_wxid=${plan.evidence.chatWxid}（${plan.evidence.chatDisplay || ''}）ts=${plan.evidence.ts} 字段来源=${plan.evidence.sourceField}`)
    console.log(`          消息片段："${plan.evidence.contentExcerpt}"`)
    return { ...profile, wxid: plan.wxid, wxidBackfillSource: 'scripts/backfill-wechat-wxid.mjs (ADR-0032)', wxidBackfilledAt: new Date().toISOString() }
  })
  db.close()

  console.log(`\n汇总：可回填 ${backfilled} 条，跳过 ${skipped} 条（共 ${profiles.length} 条）`)
  if (!apply) {
    console.log('dry-run 结束，未写入任何文件。确认无误后加 --apply 重跑。')
    return
  }
  fs.writeFileSync(profilesFile, JSON.stringify(next, null, 2), 'utf8')
  console.log(`已写入 ${profilesFile}`)
}

// CLI: node scripts/backfill-wechat-wxid.mjs [--apply] [--window-seconds N]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
