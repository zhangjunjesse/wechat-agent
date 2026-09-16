import fs from 'node:fs'
import path from 'node:path'
import { tool } from '@openai/agents'
import { nextRunAt, describeSchedule } from '../services/schedule.mjs'
import { beijingParts } from '../services/time.mjs'
import { renderPushText } from '../services/daily-report.mjs'

/** 定时任务工具集（DESIGN-timed-tasks.md + DESIGN-daily-report.md + ADR-0026）。
 *
 * 私有任务（create/list/delete）由用户自己管理；公共任务目录 + 订阅/退订
 * 控制全局任务的加入。userId 来自 run context，所有操作只影响本人。
 * reportStore 可选：提供后注册 get_daily_report（查看/追问某一条细节，纯文本）
 * 与 resend_daily_report（真的重发原始的海报图+短描述，需要 provider）。
 *
 * 两者分工是事故教训（ADR-0026）：此前"补发"被路由到 get_daily_report，模型
 * 拿到纯文本后自己现编了一整段带 Markdown、带裸链接、没有图的回复——和真实
 * 推送的样子完全对不上。现在"重新发一遍"必须走会调 provider.sendImage 的
 * resend_daily_report，不给模型现场编排的机会。 */
export function taskTools({ taskStore, reportStore = null, now = () => Date.now(), provider = null, reportUrl = null } = {}) {
  const createTask = tool({
    name: 'create_task',
    description:
      '创建用户自己的定时任务（到点后 agent 自动执行指令并把结果推送到用户的微信）。' +
      '调度格式：daily@HH:MM（每天，如 daily@08:00）、weekly@D@HH:MM（每周，D=1周一~7周日，如 weekly@1@09:00）、hourly@MM（每小时第 MM 分）。' +
      '用户说"每天早上X点给我推送…""每天提醒我…""每周一总结…"时使用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '任务名（简短，如"每日早报"）' },
        schedule: { type: 'string', description: '调度表达式：daily@HH:MM / weekly@D@HH:MM / hourly@MM' },
        instruction: { type: 'string', description: '到点后执行的指令（自然语言，如"搜索今天的AI要闻，汇总成5条简报推给我"）' },
      },
      required: ['name', 'schedule', 'instruction'],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      try {
        const task = taskStore.createUserTask({ name: input.name, schedule: input.schedule, instruction: input.instruction, ownerUserId: userId })
        return `已创建定时任务「${task.name}」：${describeSchedule(task.schedule)} 执行——${task.instruction}`
      } catch (e) {
        return `创建失败：${e.message}`
      }
    },
  })

  const listMyTasks = tool({
    name: 'list_my_tasks',
    description: '列出用户自己的全部定时任务（名称/调度/指令/上次执行），以及已订阅的公共任务。',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async (_input, ctx) => {
      const userId = ctx?.context?.userId
      const mine = taskStore.listUserTasks(userId)
      const lines = []
      for (const t of mine) {
        lines.push(`- ${t.name}：${describeSchedule(t.schedule)}｜${t.instruction}${t.lastError ? `｜上次失败：${t.lastError}` : t.lastRunAt ? `｜上次执行：${new Date(t.lastRunAt).toISOString()}` : ''}`)
      }
      const globalSubs = taskStore.listGlobalTasks().filter((t) => t.subscribers.includes(userId))
      for (const t of globalSubs) {
        lines.push(`- [公共] ${t.name}：${describeSchedule(t.schedule)}｜${t.instruction}`)
      }
      return lines.length ? `我的定时任务：\n${lines.join('\n')}` : '你还没有定时任务。可以让我创建（如"每天早上8点推送行业要闻"），或在 list_global_tasks 里订阅公共任务。'
    },
  })

  const deleteTask = tool({
    name: 'delete_task',
    description: '删除用户自己的一个定时任务（只能删自己创建的，公共任务请用 unsubscribe_task 退订）。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '要删除的任务名' } },
      required: ['name'],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      const ok = taskStore.deleteUserTask({ ownerUserId: userId, name: input.name })
      return ok ? `已删除任务「${input.name}」` : `任务「${input.name}」不存在（只能删除自己的任务）`
    },
  })

  const listGlobalTasks = tool({
    name: 'list_global_tasks',
    description: '列出公共定时任务目录（系统提供、可订阅的任务，如每日早报、每日总结）。用户可订阅后到点自动收到推送。',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async (_input, ctx) => {
      const userId = ctx?.context?.userId
      const list = taskStore.listGlobalTasks()
      if (!list.length) return '当前没有可订阅的公共任务。'
      return list.map((t) => `- ${t.name}：${describeSchedule(t.schedule)}｜${t.instruction}${taskStore.isSubscribed(t.name, userId) ? '｜已订阅' : ''}`).join('\n')
    },
  })

  const subscribeTask = tool({
    name: 'subscribe_task',
    description: '订阅一个公共定时任务（到点自动执行并推送到本用户微信）。可先 list_global_tasks 查看目录。订阅后建议引导用户设置感兴趣的主题（update_report_topics），让日报更贴合。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '公共任务名' } },
      required: ['name'],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      try {
        taskStore.subscribe(input.name, userId)
        taskStore.recordGuideEvent({ userId, event: 'guide_shown', entry: 'subscribe', taskName: input.name })
        return `已订阅公共任务「${input.name}」，到点会推送到你的微信。\n想让它更贴合你？告诉我感兴趣的主题，比如「订阅 AI 主题」，日报就会围绕你关注的方向生成。`
      } catch (e) {
        return `订阅失败：${e.message}`
      }
    },
  })

  const unsubscribeTask = tool({
    name: 'unsubscribe_task',
    description: '退订一个已订阅的公共定时任务。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '公共任务名' } },
      required: ['name'],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      try {
        const was = taskStore.unsubscribe(input.name, userId)
        return was ? `已退订公共任务「${input.name}」` : `你未订阅「${input.name}」`
      } catch (e) {
        return `退订失败：${e.message}`
      }
    },
  })

  const getDailyReport = tool({
    name: 'get_daily_report',
    description:
      '查看最近一份定时任务报告（如每日早报）的条目内容（标题/摘要/来源），用于**追问某一条的细节**。' +
      '用户追问"早报第3条展开讲讲""今天的早报讲了什么"时使用；如需更详细信息可再配合 gzh_content 抓取原文。' +
      '⚠️ 用户是要求**重新推送**（"早报补发一下""没收到再发一次""早报重发"）时，不要用这个工具' +
      '现编一段文字回复——改用 resend_daily_report，那个才会真的重发原始的图+短描述。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '报告对应的任务名（不填则取该用户已订阅任务的最近一份报告）' },
      },
      required: [],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      if (!reportStore) return '报告功能未启用。'
      const found = findLatestReport({ taskStore, reportStore, userId, name: input.name })
      if (!found.ok) return found.reason === 'not_subscribed' ? `你未订阅/未创建任务「${input.name}」，无法查看其报告。` : '未找到报告。'
      const report = found.report
      const p = beijingParts(report.runAt)
      const date = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
      const lines = [`📰 ${report.name} · ${date}`]
      if (report.focus) lines.push(`🎯 今日关注：${report.focus}`)
      report.items.forEach((it, i) => {
        // 不带原文链接（对齐海报"来源不放裸 URL"的规矩，ADR-0026）；需要原文
        // 时模型应配合 gzh_content 去抓正文，而不是把裸链接甩给用户。
        lines.push(`${i + 1}. ${it.title}${it.source ? `（${it.source}）` : ''}`)
        if (it.summary) lines.push(`　${it.summary}`)
      })
      return lines.join('\n')
    },
  })

  const resendDailyReport = tool({
    name: 'resend_daily_report',
    description:
      '重新发送最近一份定时报告（如每日早报）的**原始推送**——真实的海报图片 + 短描述，' +
      '和当时自动推送的一模一样。用户说"早报补发一下""日报没收到，再发一次""早报重发"这类' +
      '要求重新推送的话时用这个工具本身发送，**不要**先调 get_daily_report 拿文字内容再自己在' +
      '聊天里重新组织一遍——那样会丢图、模型自己加的 Markdown 微信不会渲染、还会把原文链接' +
      '直接摆出来（生产事故复现过，见 ADR-0026）。调用后不需要再复述报告内容，一句话确认即可。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '报告对应的任务名（不填则取该用户已订阅任务的最近一份报告）' },
      },
      required: [],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      const channel = ctx?.context?.channel
      if (!reportStore) return '报告功能未启用。'
      if (!provider) return '发送能力未就绪，无法补发。'
      if (!channel?.providerBotId || !channel?.contextToken) return '当前渠道不支持发送图片，请在微信对话中重试。'
      const found = findLatestReport({ taskStore, reportStore, userId, name: input.name })
      if (!found.ok) return found.reason === 'not_subscribed' ? `你未订阅/未创建任务「${input.name}」，无法补发其报告。` : '未找到报告，无法补发。'
      const report = found.report
      const p = beijingParts(report.runAt)
      const date = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
      let sentImage = false
      if (report.posterPath) {
        try {
          const buffer = await fs.promises.readFile(report.posterPath)
          await provider.sendImage({ providerBotId: channel.providerBotId, toProviderUserId: channel.toProviderUserId, contextToken: channel.contextToken, fileName: path.basename(report.posterPath), buffer })
          sentImage = true
        } catch { /* 海报文件缺失/读取失败：仍发文字版说明，不整体失败 */ }
      }
      const topics = taskStore.getReportTopics ? taskStore.getReportTopics(report.name, userId) : []
      const text = renderPushText(report, { reportUrl: reportUrl ? reportUrl(report.id) : '', topics, resend: true })
      await provider.sendText({ providerBotId: channel.providerBotId, toProviderUserId: channel.toProviderUserId, contextToken: channel.contextToken, text })
      return sentImage
        ? `已重新发送 ${date} 的${report.name}（图+说明），不用再复述内容了。`
        : `${date} 的${report.name}没有保存海报图（可能当时降级过），已重发文字版说明。`
    },
  })

  const updateReportTopics = tool({
    name: 'update_report_topics',
    description:
      '设置用户自己对一个已订阅公共任务的个性化主题（如「订阅 AI 主题」「关注 芯片 新能源」）。' +
      '设置后该任务的日报将围绕这些主题单独生成（只影响自己，不串他人）。传空列表 topics 表示清除个性化，回到公共版。' +
      '用户表达"订阅/关注/想要 XX 主题、想定制日报、换个主题"时使用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '已订阅的公共任务名（如「每日早报」）' },
        topics: { type: 'array', items: { type: 'string' }, description: '感兴趣的主题列表（1-5 个，如 ["AI","芯片"]；空数组 = 清除个性化）' },
      },
      required: ['name', 'topics'],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      try {
        const topics = taskStore.setReportTopics({ globalName: input.name, userId, topics: input.topics || [] })
        taskStore.recordGuideEvent({ userId, event: 'guide_converted', entry: 'chat', taskName: input.name })
        return topics.length
          ? `已设置「${input.name}」的个性化主题：${topics.join('、')}。从下次推送起，日报会围绕这些主题生成（只对你生效）。随时可改：告诉我新的主题即可。`
          : `已清除「${input.name}」的个性化主题，回到公共版日报。`
      } catch (e) {
        return `设置失败：${e.message}`
      }
    },
  })

  const listReportTopics = tool({
    name: 'list_report_topics',
    description: '查看自己已设置的所有个性化主题订阅。',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async (_input, ctx) => {
      const userId = ctx?.context?.userId
      const rows = taskStore.listReportTopics(userId)
      if (!rows.length) return '你还没有设置个性化主题。订阅任务后告诉我感兴趣的主题（如「订阅 AI 主题」），日报会更贴合你。'
      return rows.map((r) => `- ${r.taskName}：${r.topics.join('、')}`).join('\n')
    },
  })

  return { createTask, listMyTasks, deleteTask, listGlobalTasks, subscribeTask, unsubscribeTask, updateReportTopics, listReportTopics, getDailyReport, resendDailyReport }
}

/** 供测试/展示：任务的下次触发时间。 */
export function taskNextRun(schedule, nowMs = Date.now()) {
  return nextRunAt(schedule, nowMs)
}

/** 找该用户能看的最近一份报告：不指定 name → 遍历已订阅的 report 类任务取最新
 * （个性化优先于公共版）；指定 name → 只在该用户订阅/自建的同名任务里找。
 * get_daily_report（追问细节）与 resend_daily_report（补发原始推送）共用同一份
 * 查找逻辑（ADR-0026）——避免两处各写一遍、行为跑偏。 */
function findLatestReport({ taskStore, reportStore, userId, name }) {
  const latestFor = (taskId) => {
    const mine = reportStore.listReports(taskId, 1, { userId })
    const shared = reportStore.listReports(taskId, 1)
    const cands = [...mine, ...shared].sort((a, b) => b.runAt - a.runAt)
    return cands.length ? reportStore.getReport(cands[0].id) : null
  }
  if (name) {
    // 只允许查看自己订阅的公共任务 / 自己创建的任务的报告
    const sub = taskStore.listGlobalTasks().find((t) => t.name === name && t.subscribers.includes(userId))
    const mine = taskStore.listUserTasks(userId).find((t) => t.name === name)
    if (!sub && !mine) return { ok: false, reason: 'not_subscribed' }
    const taskId = sub ? `global-${sub.name}` : `user-${userId}-${mine.name}`
    const report = latestFor(taskId)
    return report ? { ok: true, report } : { ok: false, reason: 'not_found' }
  }
  // 已订阅的报告类公共任务中取最近一份（含个性化）
  let best = null
  for (const t of taskStore.listGlobalTasks()) {
    if (t.kind !== 'report' || !t.subscribers.includes(userId)) continue
    const taskId = `global-${t.name}`
    const mine = reportStore.listReports(taskId, 1, { userId })
    const shared = reportStore.listReports(taskId, 1)
    const cands = [...mine, ...shared].sort((a, b) => b.runAt - a.runAt)
    if (cands.length && (!best || cands[0].runAt > best.runAt)) best = cands[0]
  }
  const report = best ? reportStore.getReport(best.id) : null
  return report ? { ok: true, report } : { ok: false, reason: 'not_found' }
}
