import { tool } from '@openai/agents'

/** 任务委派工具集（DESIGN-task-delegation.md / ADR-0024）。
 *
 * 主 agent 用它把"自包含 + 多步 + 耗时"的任务派给后台子 agent，**立即返回**并
 * 继续接待用户；子任务完成后由 SubagentRunner 主动通知用户。
 *
 * 判断标准（与 skills/task-delegation/SKILL.md 一致，四条全过才派）：
 *   自包含（无需澄清）/ 多步（≥3 次工具调用或等外部 API）/ 预计 ≥30 秒 / 不依赖当前对话。
 * 不该派：简单问答、需澄清或多轮交互、用户催"马上"且任务很快、敏感操作要逐步确认、
 *   同一目标已在处理中。 */
export function delegateTools({ taskRunStore, runner, minSeconds = 30 } = {}) {
  const delegateTask = tool({
    name: 'delegate_task',
    description:
      '把一个**自包含、多步、耗时（预计 ≥' + minSeconds + ' 秒）**的任务派给后台子 agent 执行，立即返回，不占用当前对话。' +
      '子 agent **看不到你与用户的对话**，所以 goal 必须写成完整、独立、无需追问的任务描述（含：要做什么、交付什么形式、成功标准、边界）。' +
      '适用：导出/下载文档、抓取多篇文章并总结、批量处理文件、生成长文档或图片、需要等待外部接口的活。' +
      '不适用：简单问答与单次查询（直接回答）、需要与用户澄清的任务（先问清）、用户要求"马上"且任务很快的。' +
      '派发后请立即告诉用户"已派发任务 #N"，**不要承诺具体结果**（结果由子任务完成通知给出）；完成后系统会自动通知用户。',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '自包含的任务描述（背景 + 目标 + 交付形式 + 成功标准 + 边界），子 agent 只看到这段' },
        context: { type: 'string', description: '可选：从当前对话中提炼的必要上下文（如文档链接、用户偏好），不要整段对话' },
      },
      required: ['goal'],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      const profile = ctx?.context?.profile || null
      const channel = ctx?.context?.channel || null
      if (!taskRunStore || !runner) return '任务委派功能未启用。'
      const goal = String(input.goal || '').trim()
      if (!goal) return '派发失败：goal 不能为空。'
      try {
        const task = taskRunStore.create({ userId, goal, context: input.context || '', origin: channel ? 'chat' : '' })
        runner.enqueue({ taskId: task.id, userId, profile, channel })
        return `✅ 已派发任务 ${task.id}（${goal.slice(0, 40)}${goal.length > 40 ? '…' : ''}），后台执行中。完成后我会主动通知用户并推送结果。\n现在请用一句话告诉用户"已派发"，然后继续接待其他问题（不要等待这个任务）。`
      } catch (e) {
        return `派发失败：${e.message}`
      }
    },
  })

  const listTasks = tool({
    name: 'list_tasks',
    description: '列出当前用户派发过的后台任务（任务 id / 目标 / 状态 / 时间），用于回答"我派的任务怎么样了"。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: '返回条数，默认 10' } },
      required: [],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      if (!taskRunStore) return '任务委派功能未启用。'
      const list = taskRunStore.listByUser(userId, { limit: Math.min(Math.max(Number(input.limit) || 10, 1), 30) })
      if (!list.length) return '你还没有派发过后台任务。'
      return list.map((t) => {
        const label = STATUS_LABEL[t.status] || t.status
        const when = new Date(t.createdAt).toISOString().slice(5, 16).replace('T', ' ')
        return `- ${t.id}｜${label}｜${when}｜${t.goal.slice(0, 40)}${t.goal.length > 40 ? '…' : ''}`
      }).join('\n')
    },
  })

  const taskStatus = tool({
    name: 'task_status',
    description: '查看某个后台任务的详情（状态 / 结果 / 错误 / 耗时）。用户问"任务 #N 怎么样了"时使用；不要用它反复轮询。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '任务 id，如 task-3' } },
      required: ['id'],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      if (!taskRunStore) return '任务委派功能未启用。'
      const task = taskRunStore.get(String(input.id).trim())
      if (!task || task.userId !== String(userId)) return `找不到任务 ${input.id}（只能查看自己的任务）。`
      const lines = [
        `${task.id}｜${STATUS_LABEL[task.status] || task.status}`,
        `目标：${task.goal}`,
        `创建：${new Date(task.createdAt).toISOString()}`,
      ]
      if (task.startedAt) lines.push(`开始：${new Date(task.startedAt).toISOString()}`)
      if (task.finishedAt) lines.push(`结束：${new Date(task.finishedAt).toISOString()}（耗时 ${Math.round((task.finishedAt - task.startedAt) / 1000)} 秒）`)
      if (task.result) lines.push(`结果：${task.result}`)
      if (task.resultFiles?.length) lines.push(`产物：${task.resultFiles.join('、')}`)
      if (task.error) lines.push(`错误：${task.error}`)
      if (task.attempts > 1) lines.push(`尝试次数：${task.attempts}`)
      return lines.join('\n')
    },
  })

  const retryTask = tool({
    name: 'retry_task',
    description: '重试一个失败或超时的后台任务（重新派发执行）。用户说"重试 #N"时使用。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '任务 id，如 task-3' } },
      required: ['id'],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      const profile = ctx?.context?.profile || null
      const channel = ctx?.context?.channel || null
      if (!taskRunStore || !runner) return '任务委派功能未启用。'
      const task = taskRunStore.get(String(input.id).trim())
      if (!task || task.userId !== String(userId)) return `找不到任务 ${input.id}（只能重试自己的任务）。`
      if (!['failed', 'timeout', 'cancelled'].includes(task.status)) return `任务 ${task.id} 当前状态是「${STATUS_LABEL[task.status] || task.status}」，只有失败/超时/已取消的任务可以重试。`
      const next = taskRunStore.markRetry(task.id)
      runner.enqueue({ taskId: next.id, userId, profile, channel })
      return `🔁 已重新派发任务 ${next.id}（第 ${next.attempts} 次尝试），完成后我会通知你。`
    },
  })

  return { delegateTask, listTasks, taskStatus, retryTask }
}

const STATUS_LABEL = {
  pending: '排队中',
  running: '执行中',
  done: '已完成',
  failed: '失败',
  timeout: '超时',
  cancelled: '已取消',
}
