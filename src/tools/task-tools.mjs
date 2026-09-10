import { tool } from '@openai/agents'
import { nextRunAt, describeSchedule } from '../services/schedule.mjs'

/** 定时任务工具集（DESIGN-timed-tasks.md）。
 *
 * 私有任务（create/list/delete）由用户自己管理；公共任务目录 + 订阅/退订
 * 控制全局任务的加入。userId 来自 run context，所有操作只影响本人。 */
export function taskTools({ taskStore, now = () => Date.now() } = {}) {
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
    description: '订阅一个公共定时任务（到点自动执行并推送到本用户微信）。可先 list_global_tasks 查看目录。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '公共任务名' } },
      required: ['name'],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      try {
        taskStore.subscribe(input.name, userId)
        return `已订阅公共任务「${input.name}」，到点会推送到你的微信。`
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

  return { createTask, listMyTasks, deleteTask, listGlobalTasks, subscribeTask, unsubscribeTask }
}

/** 供测试/展示：任务的下次触发时间。 */
export function taskNextRun(schedule, nowMs = Date.now()) {
  return nextRunAt(schedule, nowMs)
}
