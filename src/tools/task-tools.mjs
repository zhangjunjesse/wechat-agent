import { tool } from '@openai/agents'
import { nextRunAt, describeSchedule } from '../services/schedule.mjs'
import { beijingParts } from '../services/time.mjs'

/** 定时任务工具集（DESIGN-timed-tasks.md + DESIGN-daily-report.md）。
 *
 * 私有任务（create/list/delete）由用户自己管理；公共任务目录 + 订阅/退订
 * 控制全局任务的加入。userId 来自 run context，所有操作只影响本人。
 * reportStore 可选：提供后注册 get_daily_report（查看/追问报告详情）。 */
export function taskTools({ taskStore, reportStore = null, now = () => Date.now() } = {}) {
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
      '查看最近一份定时任务报告（如每日早报）的完整条目内容（标题/摘要/来源/原文链接）。' +
      '用户追问"早报第3条展开讲讲""今天的早报内容"时使用；如需更详细信息可再配合 gzh_content 抓取原文。',
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
      let report = null
      const latestFor = (taskId) => {
        // 优先自己主题的个性化报告，回退公共版
        const mine = reportStore.listReports(taskId, 1, { userId })
        const shared = reportStore.listReports(taskId, 1)
        const cands = [...mine, ...shared].sort((a, b) => b.runAt - a.runAt)
        return cands.length ? reportStore.getReport(cands[0].id) : null
      }
      if (input.name) {
        // 只允许查看自己订阅的公共任务 / 自己创建的任务的报告
        const sub = taskStore.listGlobalTasks().find((t) => t.name === input.name && t.subscribers.includes(userId))
        const mine = taskStore.listUserTasks(userId).find((t) => t.name === input.name)
        if (!sub && !mine) return `你未订阅/未创建任务「${input.name}」，无法查看其报告。`
        const taskId = sub ? `global-${sub.name}` : `user-${userId}-${mine.name}`
        report = latestFor(taskId)
      } else {
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
        report = best ? reportStore.getReport(best.id) : null
      }
      if (!report) return '未找到报告。'
      const p = beijingParts(report.runAt)
      const date = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
      const lines = [`📰 ${report.name} · ${date}`]
      if (report.focus) lines.push(`🎯 今日关注：${report.focus}`)
      report.items.forEach((it, i) => {
        lines.push(`${i + 1}. ${it.title}${it.source ? `（${it.source}）` : ''}`)
        if (it.summary) lines.push(`　${it.summary}`)
        if (it.url) lines.push(`　原文：${it.url}`)
      })
      return lines.join('\n')
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

  return { createTask, listMyTasks, deleteTask, listGlobalTasks, subscribeTask, unsubscribeTask, updateReportTopics, listReportTopics, getDailyReport }
}

/** 供测试/展示：任务的下次触发时间。 */
export function taskNextRun(schedule, nowMs = Date.now()) {
  return nextRunAt(schedule, nowMs)
}
