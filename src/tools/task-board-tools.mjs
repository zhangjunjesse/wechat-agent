import { tool } from '@openai/agents'

/** Agent 任务板工具集（DESIGN-agent-task-board.md，取代 ADR-0024 的
 * delegate_task/list_tasks/task_status/retry_task 四工具）。
 *
 * 板是 **agent 自己的工作记忆**：用户一次交代多件事、有先后依赖、要等外部、
 * 跨轮跨天的承诺，都落在板上由 drain 循环后台兑现。用户从不直接看板——
 * 对用户只说人话。判据与纪律写在工具描述里（ADR-0025 的机制：每轮必然
 * 可见的表面才可靠），关键迁移状态另有服务端硬校验兜底（终态不可迁出、
 * 有未完成前置不能标完成、依赖防环、跨用户不可见）。 */
export function taskBoardTools({ board, runs, runner } = {}) {
  const disabled = () => '任务板功能未启用。'

  const taskCreate = tool({
    name: 'task_create',
    description:
      '在任务板上记一个待办的**承诺**，后台会自动认领执行、完成后自动通知用户。' +
      '【核心判据】这轮结束时你给用户的是"结果"还是"承诺"？给得出结果 → 直接做，不建任务；只能给承诺 → 必须建任务。' +
      '【结构信号（命中任一就建）】① 一句话里有 ≥2 件可独立交付的事（每件各建一个，用 blockedBy 表达先后）；② 产物是交付物（文件/文档/报告/图片）；③ 导出/下载、批量处理、抓多篇汇总、要等外部异步接口；④ 中间状态要跨轮保留；⑤ 用户明说"帮我盯着/记一下（要你做的事）"。' +
      '【禁止】不许按预计耗时判断（估不准）；不许给已做完的事补建任务；不许把一件事拆成琐碎步骤铺满板（任务=有意义的交付单元）；建前必先 task_list 查重，同一目标已有任务就不要重复建；对既有任务的追问走 task_get，不新建。' +
      '【自包含】后台执行者**看不到你和用户的对话**：subject+description 必须写清"做什么+交付形式+成功标准+边界"。需要先向用户澄清的事，问清了再建。' +
      '【建完怎么说】只用人话确认（如"记下了，做好我发你"），不要承诺具体结果、不要自己接着做、不要向用户展示任务板结构。' +
      '若这件事你打算**当场自己做**（作为多件事计划的一部分），传 owner="me" 建一条自己认领的，做完立刻 task_update 标 completed。',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '祈使句标题，如"导出季度总结为 PDF"' },
        description: { type: 'string', description: '自包含详情：背景+目标+交付形式+成功标准+边界' },
        activeForm: { type: 'string', description: '进行中文案（给用户看的现在进行时），如"正在导出季度总结"' },
        blockedBy: { type: 'array', items: { type: 'number' }, description: '可选：必须先完成的前置任务 id 列表' },
        owner: { type: 'string', enum: ['', 'me'], description: '默认空=后台自动认领执行；"me"=你当场自己做' },
      },
      required: ['subject', 'description'],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      if (!board) return disabled()
      try {
        const task = board.create({
          userId,
          subject: input.subject,
          description: input.description,
          activeForm: input.activeForm || '',
          owner: input.owner === 'me' ? 'main' : '',
          blockedBy: (input.blockedBy || []).map(Number),
        })
        const open = board.openBlockers(task.id)
        if (task.owner === 'main') board.update(task.id, userId, { status: 'in_progress' })
        else if (!open.length) runner?.poke(userId) // 被阻塞的不必 poke，解锁时（前置 completed）会再 poke
        const tail = open.length
          ? `（等 #${open.join('、#')} 完成后开始）`
          : task.owner === 'main'
            ? '（你自己当场做，完成后记得 task_update 标 completed）'
            : '（后台已排队，完成后系统自动通知用户）'
        return `已建任务 #${task.id}「${task.subject}」${tail}`
      } catch (e) {
        return `建任务失败：${e.message}`
      }
    },
  })

  const taskList = tool({
    name: 'task_list',
    description:
      '列出当前用户任务板上的任务（活跃在前，按 id 升序）。三个用途：' +
      '① 建新任务前**必查**（同一目标已有就不重复建）；② 回答"我那几件事怎么样了"（读完用人话转述，不要贴板结构）；③ 完成一个任务后看有没有被解锁的下一个。' +
      '行内标注：等待中的前置任务 id、失败原因（若有）。',
    parameters: {
      type: 'object',
      properties: { includeCompleted: { type: 'boolean', description: '是否附带最近已完成的任务，默认否' } },
      required: [],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      if (!board) return disabled()
      const list = board.list(userId, { includeCompleted: Boolean(input.includeCompleted) })
      if (!list.length) return '任务板是空的。'
      return list.map((t) => {
        const bits = [`#${t.id}`, STATUS_LABEL[t.status] || t.status]
        if (t.openBlockerIds?.length) bits.push(`等 #${t.openBlockerIds.join('、#')}`)
        if (t.owner === 'main') bits.push('你自己在做')
        bits.push(t.subject)
        if (t.status === 'in_progress' && t.activeForm) bits.push(t.activeForm)
        if (t.lastError) bits.push(`上次失败：${t.lastError.slice(0, 40)}`)
        return `- ${bits.join('｜')}`
      }).join('\n')
    },
  })

  const taskGet = tool({
    name: 'task_get',
    description:
      '读某个任务的完整详情（描述、状态、两向依赖、最近一次执行概要）。' +
      '**改任务之前必须先用它读最新状态**（板可能已被后台更新）；用户追问某件事进展时也用它，如实转述（进行中就说进行中，不要说"马上好"）。',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'number', description: '任务 id（数字）' } },
      required: ['taskId'],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      if (!board) return disabled()
      const t = board.getDetail(Number(input.taskId), userId)
      if (!t) return `找不到任务 #${input.taskId}（只能查看自己的任务）。`
      const lines = [
        `#${t.id}｜${STATUS_LABEL[t.status] || t.status}${t.owner ? `｜owner=${t.owner === 'main' ? '你自己' : '后台'}` : ''}`,
        `标题：${t.subject}`,
        t.description ? `详情：${t.description}` : '',
        t.blockedBy.length ? `前置：${t.blockedBy.map((d) => `#${d.id}(${STATUS_LABEL[d.status] || d.status})`).join('、')}` : '',
        t.blocks.length ? `解锁：${t.blocks.map((d) => `#${d.id}`).join('、')}` : '',
        t.result ? `结果：${t.result}` : '',
        t.lastError ? `上次失败：${t.lastError}` : '',
        t.autoAttempts ? `自动重试已用：${t.autoAttempts} 次` : '',
      ].filter(Boolean)
      const run = runs?.latestForBoard(String(t.id))
      if (run) lines.push(`最近执行：${run.id}｜${run.status}${run.status === 'running' ? `｜已用 ${Math.round((Date.now() - (run.startedAt || run.createdAt)) / 1000)} 秒` : ''}`)
      return lines.join('\n')
    },
  })

  const taskUpdate = tool({
    name: 'task_update',
    description:
      '更新任务：改状态/字段、建依赖。**完成纪律（违者是在向用户撒谎）**：' +
      '只有**完全做成**了才许标 completed——有报错没解决、交付物没产出、找不到需要的文件/数据，都不许标；' +
      '被卡住时保持 in_progress，并**新建一个任务写清卡点**（而不是硬标完成或干耗）。' +
      '改之前必须先 task_get 读最新状态。其他用法：用户说"重试任务 N"→ status="pending"（会清除失败记录重新排队）；' +
      '任务不需要了 → status="deleted"（正在执行的会作废结果、不打扰用户）；' +
      'addBlockedBy/addBlocks 建依赖（系统拒绝成环）。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'number', description: '任务 id（数字）' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'], description: '新状态' },
        subject: { type: 'string', description: '新标题' },
        description: { type: 'string', description: '新详情' },
        activeForm: { type: 'string', description: '新进行中文案' },
        result: { type: 'string', description: '标 completed 时附上结果说明' },
        addBlockedBy: { type: 'array', items: { type: 'number' }, description: '给本任务加前置' },
        addBlocks: { type: 'array', items: { type: 'number' }, description: '声明哪些任务要等本任务' },
      },
      required: ['taskId'],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      if (!board) return disabled()
      try {
        const updated = board.update(Number(input.taskId), userId, {
          status: input.status,
          subject: input.subject,
          description: input.description,
          activeForm: input.activeForm,
          result: input.result,
          addBlockedBy: input.addBlockedBy,
          addBlocks: input.addBlocks,
        })
        if (!updated) return `找不到任务 #${input.taskId}（只能改自己的任务）。`
        if (input.status === 'pending') runner?.poke(userId)
        if (input.status === 'completed') runner?.poke(userId) // 完成可能解锁后继任务
        return `已更新 #${updated.id}：${STATUS_LABEL[updated.status] || updated.status}｜${updated.subject}`
      } catch (e) {
        return `更新失败：${e.message}`
      }
    },
  })

  const taskOutput = tool({
    name: 'task_output',
    description:
      '取某个任务最近一次后台执行的输出（状态/结果/耗时）。用户催问进展时用它如实回答（"处理中，已 N 秒"），不要反复轮询——完成会自动通知。也接受执行 id（task-N 形式）。',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string', description: '板任务 id（如 "3"）或执行 id（如 "task-12"）' } },
      required: ['taskId'],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      if (!runs) return disabled()
      const key = String(input.taskId || '').replace(/^#/, '').trim()
      const run = key.startsWith('task-') ? runs.get(key) : runs.latestForBoard(key)
      if (!run || run.userId !== String(userId)) return `找不到 #${key} 的执行记录（可能还没开始，或不属于当前用户）。`
      const lines = [`${run.id}｜${run.status}${run.boardTaskId ? `｜任务 #${run.boardTaskId}` : ''}`]
      if (run.status === 'running') lines.push(`已用 ${Math.round((Date.now() - (run.startedAt || run.createdAt)) / 1000)} 秒`)
      if (run.result) lines.push(`结果：${run.result}`)
      if (run.resultFiles?.length) lines.push(`产物：${run.resultFiles.join('、')}`)
      if (run.error) lines.push(`错误：${run.error}`)
      return lines.join('\n')
    },
  })

  return { taskCreate, taskList, taskGet, taskUpdate, taskOutput }
}

const STATUS_LABEL = {
  pending: '排队中',
  in_progress: '进行中',
  completed: '已完成',
  deleted: '已删除',
}
