import { tool } from '@openai/agents'

/** 任务委派工具集（DESIGN-task-delegation.md / ADR-0024，判据重构见 ADR-0025）。
 *
 * 主 agent 用它把"自包含 + 会卡住当前对话"的任务派给后台子 agent，**立即返回**并
 * 继续接待用户；子任务完成后由 SubagentRunner 主动通知用户。
 *
 * 判断标准（ADR-0025 起改为**操作类型清单**，不再靠估时间/数工具调用次数）：
 *   命中清单（导出/下载文件、批量处理、生成文档与图片、多篇抓取汇总、等外部异步接口）
 *   且任务自包含（无需澄清）→ 默认派发。
 * 不该派：单条查询、简单问答、发一条消息、需澄清或多轮交互、敏感操作要逐步确认、
 *   同一目标已在处理中（派发前先 list_tasks 查）。
 *
 * 判据文案放在**工具描述**里（而非只放在静态 prompt 或按需加载的 skill 里）：
 * 工具描述是每轮都在上下文里的稳定表面，模型选择工具时必然读到。 */
export function delegateTools({ taskRunStore, runner } = {}) {
  const delegateTask = tool({
    name: 'delegate_task',
    description:
      '把一个**会卡住当前对话的活**派给后台子 agent 执行，立即返回，不占用当前对话。' +
      '【什么时候必须用】只要命中下面任一操作类型，就默认派发，不要自己闷头做：' +
      '① 导出/下载文件（飞书文档导出、附件下载、大文件转换）；' +
      '② 批量处理（多个文件、多条数据、多个群/多次发送）；' +
      '③ 生成文档/图片/海报/报告；' +
      '④ 抓取多篇内容再汇总；' +
      '⑤ 任何要等外部异步接口（导出任务、长轮询、第三方处理）的活。' +
      '**判据看操作类型，不要靠估时间、也不要看自己调了几次工具**——单次调用也可能跑一分钟（如 lark_export_doc）。' +
      '【什么时候不要用】单条查询/简单问答（直接回答）、发一条消息、需要先跟用户澄清（先问清）、敏感操作要逐步确认、同一目标已有进行中的任务。' +
      '【派发前】先 list_tasks 查有没有进行中的同类任务：已有就报它的进度（用 task_status 拿已用时长），不要重复派。' +
      '【派发后】只回一句"已派发任务 #N，完成后发你"，**不要承诺具体结果、不要自己接着做、不要轮询**；结果由系统完成通知给出。' +
      'goal 必须自包含：子 agent **看不到你和用户的对话**，所以要写清"做什么 + 交付什么形式 + 成功标准 + 边界"。',
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
    description: '列出当前用户派发过的后台任务（任务 id / 目标 / 状态 / 已用时长）。两个用途：① 派发或动手前先查有没有进行中的同类任务（避免重复派/重复做）；② 回答"我派的任务怎么样了"。',
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
        return `- ${t.id}｜${label}${elapsedSuffix(t)}｜${when}｜${t.goal.slice(0, 40)}${t.goal.length > 40 ? '…' : ''}`
      }).join('\n')
    },
  })

  const taskStatus = tool({
    name: 'task_status',
    description: '查看某个后台任务的详情（状态 / 结果 / 错误 / 已用时长）。用户催问"任务 #N 好了吗"或"还要多久"时用它如实回答"处理中（已 N 秒）"；不要用它反复轮询。',
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
        `${task.id}｜${STATUS_LABEL[task.status] || task.status}${elapsedSuffix(task)}`,
        `目标：${task.goal}`,
        `创建：${new Date(task.createdAt).toISOString()}`,
      ]
      if (task.startedAt) lines.push(`开始：${new Date(task.startedAt).toISOString()}`)
      if (task.finishedAt) lines.push(`结束：${new Date(task.finishedAt).toISOString()}（耗时 ${durationSeconds(task.startedAt || task.createdAt, task.finishedAt)} 秒）`)
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

/** 已用/耗时秒数（ADR-0025：派发路径必须让用户看到时间，否则"在吗/好了吗"会逼回自己动手）。 */
function durationSeconds(fromMs, toMs = Date.now()) {
  const from = Number(fromMs) || 0
  if (!from) return 0
  return Math.max(0, Math.round((toMs - from) / 1000))
}

/** 进行中任务的时间后缀「 · 已用 42 秒」；排队中/已结束不重复状态词，返回空串。 */
function elapsedSuffix(task) {
  if (task.status !== 'running') return ''
  const s = durationSeconds(task.startedAt || task.createdAt)
  return s ? ` · 已用 ${s} 秒` : ''
}
