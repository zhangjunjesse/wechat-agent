#!/usr/bin/env node
/** ADR-0031（2026-09-17 变更）一次性回填脚本：把默认订阅从"新用户在核验那一刻
 * 拿到"扩展到"存量已核验用户也拿到一次"。
 *
 * 为什么不能挂到服务启动流程（这是本次变更最重要的设计约束）：
 *   如果做成"服务启动时确保所有已核验用户都订阅了默认任务"，那么用户**退订
 *   之后下一次重启又会被订回来**——退订功能等于永久失效。默认订阅的正确语义
 *   是"在某个一次性时刻施加一次"：新用户 = 核验那一刻（`buildOnVerified`，
 *   `src/app.mjs`）；存量用户 = 这个脚本跑的那一次。之后用户自己的订阅/退订
 *   状态就是唯一权威，任何后台流程都不会再覆盖它。所以本脚本只能手动触发，
 *   绝不接到 `server.mjs` 的启动路径上。
 *
 * 判定"已核验"：`profile.verifiedAt` 存在 **且** `profile.ilinkUserId` 非空。
 *   `verifiedAt` 由 `ProfileStore.put()` 在每次写入时无条件盖章（见
 *   `src/services/profile-store.mjs`），而 `put()` 只在核验成功那一刻被调用
 *   （`VerificationService.check()`）——也就是说 profiles.json 里**所有**记录
 *   的 `verifiedAt` 恒真，它本身不能把"真人核验过"和"合成测试档案"分开。真正
 *   的判据是 `ilinkUserId`：`test-user`/`repro`/`repro2` 这类合成档案是开发期
 *   直接写文件或走非常规路径造出来的，没有经过 `VerificationService` 的
 *   `task.ilinkUserId` 赋值，字段为空——用它们做排除条件。
 *
 * 订阅键：必须是 `profile.ilinkUserId`，与 `onVerified`/`subscribe_task`/
 *   调度器扇出用的同一个稳定租户键（ADR-0004）。生产 profiles.json 里存在多条
 *   档案共用同一个 `ilinkUserId`（同一个微信用户在网页上核验了多次，每次拿到
 *   不同的 browser id）——按 `ilinkUserId` 去重后应只产生一个订阅者，否则
 *   `tasks.subscribers` 里会出现同一个人的多个"马甲"键（无害但脏，且不是
 *   `subscribe()` 本身的幂等能兜住的——它按值去重，不知道两个不同字符串其实
 *   是同一个人）。
 *
 * 默认只回填「微信日报」「微信周报」，**不含「每日资讯」**（见
 * `DEFAULT_BACKFILL_TASKS`）：「每日资讯」的存量订阅已经通过 ADR-0031 最初那次
 * 的改名迁移（`TaskStore.renameGlobalTask`）处理过——老任务「每日早报」的全部
 * 订阅者已经原样搬到新任务上。如果这里默认还把「每日资讯」纳入回填范围，会把
 * "改名后主动退订过新任务的人"又拉回订阅列表，直接违反"退订永远优先"。真要
 * 回填「每日资讯」（比如发现迁移当时漏了什么人），用 `--tasks 每日资讯` 显式指定，
 * 这样做的人清楚自己在覆盖一条已有历史决策，而不是被默认值悄悄带偏。
 *
 * 幂等 + **不复活已退订用户**（这是本脚本与 `backfill-wechat-wxid.mjs` 最大的
 * 不同点，值得单独说清楚）：`tasks.subscribers` 只是一个当前状态的集合，没有
 * "这个人曾经被系统订阅过、后来自己退订了"的历史记录——`TaskStore` 完全没有
 * 退订的 tombstone。只看 subscribers 里没有某个人，分不清两种情况：
 *   (a) 这个人从没被回填过（该订阅）
 *   (b) 这个人被回填过，后来自己退订了（不该被这个脚本碰）
 * 如果本脚本的判定完全依赖 `taskStore.isSubscribed()`，(a) 和 (b) 会被同等对待
 * ——那么脚本被重复运行（比如为了给新核验的一批用户回填）时，就会把所有中途
 * 退订过的人重新订阅回去，退订等于白退。所以本脚本自己维护一个旁路账本
 * （`BACKFILL_LOG_FILE`，默认 `data/default-subscriptions-backfill-log.json`），
 * 记录"这个人这个任务已经被本脚本处理过"（不论当时是新订阅还是发现已订阅）；
 * `--apply` 之后即使用户之后退订，下次重跑本脚本会在账本里查到记录，直接跳过
 * ——不会再看 `subscribers`，因此绝不会把他们订阅回去。
 *
 * 安全边界（同 `backfill-wechat-wxid.mjs`）：
 *   - **默认 dry-run**，打印每个用户会被订阅到哪些任务 / 已订阅跳过 / 因何排除；
 *     `--apply` 才真的写 `tasks.db` 和账本文件。
 *   - dry-run 不写账本——只有真正执行过 `--apply` 的处理才算数。
 *
 * 用法：
 *   node scripts/backfill-default-subscriptions.mjs                     # dry-run
 *   node scripts/backfill-default-subscriptions.mjs --apply
 *   node scripts/backfill-default-subscriptions.mjs --apply --tasks 微信日报,微信周报
 *   PROFILES_FILE=... TASKS_FILE=... BACKFILL_LOG_FILE=... node scripts/backfill-default-subscriptions.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { TaskStore } from '../src/services/task-store.mjs'
import { DEFAULT_SUBSCRIPTIONS } from '../src/app.mjs'

/** 见文件头注释：默认回填范围 = DEFAULT_SUBSCRIPTIONS 去掉「每日资讯」。 */
export const DEFAULT_BACKFILL_TASKS = DEFAULT_SUBSCRIPTIONS.filter((n) => n !== '每日资讯')

/** 单条 profile 是否是回填的合法目标。纯函数，不碰文件/DB，方便单测。
 * 返回 `{ eligible: true, key }`（key = ilinkUserId，回填要用的订阅键）或
 * `{ eligible: false, reason }`。 */
export function classifyProfile(profile) {
  if (!profile?.verifiedAt) return { eligible: false, reason: '未核验（没有 verifiedAt）' }
  const ilinkUserId = String(profile?.ilinkUserId || '').trim()
  if (!ilinkUserId) return { eligible: false, reason: '没有 ilinkUserId（合成/测试档案，或核验流程未正确记录），无法解析稳定订阅键，跳过' }
  return { eligible: true, key: ilinkUserId }
}

/** 给全部 profile 生成回填计划。纯函数：`taskStore`/`backfillLog` 只读查询，
 * 真正的写入交给 `applyBackfill`。
 *
 * `backfillLog`：Set，元素形如 `${ilinkUserId}\u0000${taskName}`——此前
 * `--apply` 处理过的 (人, 任务) 组合。已在里面的一律跳过，即使当前
 * `subscribers` 里没有这个人（大概率是主动退订了，见文件头注释）。
 *
 * 返回每条 profile 的处理结果：
 *   `{ userId, nickname, excluded: reason }`                    —— 未核验/无 ilinkUserId/重复
 *   `{ userId, nickname, ilinkUserId, tasks: [{ name, action, reason? }] }` —— 逐任务的计划 */
export function planBackfill(profiles, taskStore, backfillLog = new Set(), { taskNames = DEFAULT_BACKFILL_TASKS } = {}) {
  const names = (taskNames || []).map((n) => String(n).trim()).filter(Boolean)
  const seenBy = new Map() // ilinkUserId -> 第一个认领这个键的 userId
  const entries = []
  for (const profile of profiles || []) {
    const userId = profile?.userId || '(unknown)'
    const nickname = profile?.nickname || ''
    const verdict = classifyProfile(profile)
    if (!verdict.eligible) { entries.push({ userId, nickname, excluded: verdict.reason }); continue }
    const key = verdict.key
    if (seenBy.has(key)) {
      entries.push({ userId, nickname, ilinkUserId: key, excluded: `与 ${seenBy.get(key)} 共用同一 ilinkUserId（${key}），已作为同一个人处理过，跳过` })
      continue
    }
    seenBy.set(key, userId)
    const tasks = names.map((name) => {
      if (backfillLog.has(`${key}\u0000${name}`)) return { name, action: 'skip', reason: '此前已被本脚本回填处理过（可能后来主动退订了，不重新订阅）' }
      if (taskStore.isSubscribed(name, key)) return { name, action: 'skip', reason: '已订阅' }
      return { name, action: 'subscribe' }
    })
    entries.push({ userId, nickname, ilinkUserId: key, tasks })
  }
  return entries
}

/** 按 `planBackfill` 的计划真正执行：订阅 + 落账本。只应在 `--apply` 时调用。
 * 每个 (人, 任务) 组合无论这次是"新订阅"还是"发现已订阅"，都会被记进账本——
 * 一旦被本脚本处理过，就再也不会被本脚本重新触碰（哪怕之后 subscribers 里
 * 因为用户自己退订而不再包含这个人）。返回新增订阅数，供 CLI 打印汇总。 */
export function applyBackfill(entries, taskStore, backfillLog) {
  let subscribed = 0
  for (const entry of entries) {
    if (entry.excluded || !entry.tasks) continue
    for (const t of entry.tasks) {
      if (t.action === 'subscribe') { taskStore.subscribe(t.name, entry.ilinkUserId); subscribed++ }
      backfillLog.add(`${entry.ilinkUserId}\u0000${t.name}`)
    }
  }
  return subscribed
}

function loadBackfillLog(file) {
  try { return new Set(JSON.parse(fs.readFileSync(file, 'utf8'))) } catch (e) { if (e.code !== 'ENOENT') throw e; return new Set() }
}
function saveBackfillLog(file, set) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify([...set].sort(), null, 2), 'utf8')
}

/** CLI 入口：读 profiles.json + tasks.db + 账本，逐条打印计划；--apply 才真的写。 */
function main() {
  const argv = process.argv.slice(2)
  const apply = argv.includes('--apply')
  const tasksIdx = argv.indexOf('--tasks')
  const taskNames = tasksIdx >= 0 && argv[tasksIdx + 1] ? argv[tasksIdx + 1].split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_BACKFILL_TASKS

  const profilesFile = process.env.PROFILES_FILE || path.resolve('data/profiles.json')
  const tasksFile = process.env.TASKS_FILE || path.resolve('data/tasks.db')
  const backfillLogFile = process.env.BACKFILL_LOG_FILE || path.resolve('data/default-subscriptions-backfill-log.json')
  if (!fs.existsSync(profilesFile)) { console.error(`PROFILES_FILE 不存在：${profilesFile}`); process.exit(2) }

  const profiles = JSON.parse(fs.readFileSync(profilesFile, 'utf8'))
  if (!Array.isArray(profiles)) { console.error(`${profilesFile} 内容不是数组，中止`); process.exit(2) }

  const taskStore = new TaskStore({ file: tasksFile })
  // 快速失败：任务名对不上是配置/拼写错误，应该在改动任何数据前就中止，而不是
  // 在 planBackfill 里悄悄判成"可订阅"、到 applyBackfill 调用 taskStore.subscribe
  // 时才抛出，那样已经处理过的前面几个用户会先落盘，账本却因为异常没保存，
  // 状态变得难以推理。
  const knownNames = new Set(taskStore.listGlobalTasks().map((t) => t.name))
  const unknown = taskNames.filter((n) => !knownNames.has(n))
  if (unknown.length) {
    console.error(`--tasks 里有不存在的公共任务：${unknown.join('、')}（当前 tasks.db 里的全局任务：${[...knownNames].join('、') || '(无)'}）`)
    taskStore.close()
    process.exit(2)
  }
  const backfillLog = loadBackfillLog(backfillLogFile)
  console.log(`${apply ? '[APPLY]' : '[DRY-RUN，加 --apply 才会真的写 tasks.db]'} 扫描 ${profiles.length} 条 profile，回填任务：${taskNames.join('、') || '(空)'}`)

  const entries = planBackfill(profiles, taskStore, backfillLog, { taskNames })
  let plannedSubscribe = 0
  for (const entry of entries) {
    if (entry.excluded) { console.log(`  [排除] ${entry.userId} (${entry.nickname || '无昵称'}): ${entry.excluded}`); continue }
    const parts = entry.tasks.map((t) => t.action === 'subscribe' ? (plannedSubscribe++, `+${t.name}`) : `-${t.name}(${t.reason})`)
    console.log(`  [${entry.ilinkUserId}] ${entry.userId} (${entry.nickname || '无昵称'}): ${parts.join('  ') || '(无目标任务)'}`)
  }

  console.log(`\n汇总：待新增订阅 ${plannedSubscribe} 项，涉及 ${entries.filter((e) => !e.excluded).length} 个去重后的用户（共 ${profiles.length} 条 profile）`)
  if (!apply) {
    console.log('dry-run 结束，未写入 tasks.db 或账本。确认无误后加 --apply 重跑。')
    taskStore.close()
    return
  }
  const subscribed = applyBackfill(entries, taskStore, backfillLog)
  saveBackfillLog(backfillLogFile, backfillLog)
  taskStore.close()
  console.log(`已写入：新增订阅 ${subscribed} 项，账本更新到 ${backfillLogFile}`)
}

// CLI: node scripts/backfill-default-subscriptions.mjs [--apply] [--tasks 名字1,名字2]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
