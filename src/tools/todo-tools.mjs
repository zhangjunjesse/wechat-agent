import { tool } from '@openai/agents'

/** Todo tools backed by MemoryStore (category=todo). userId comes from run context. */
export function todoTools({ memoryManager }) {
  const addTodo = tool({
    name: 'add_todo',
    description: '为用户添加一条待办事项',
    parameters: { type: 'object', properties: { content: { type: 'string' }, due: { type: 'string', description: '截止日期 YYYY-MM-DD，可留空' } }, required: ['content'] },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      await memoryManager.store.insert(userId, { type: 'semantic', category: 'todo', subject: '用户', relation: '本人', content: input.content, due: input.due ? Date.parse(input.due) : 0 })
      return `已添加待办：${input.content}`
    },
  })

  const listTodo = tool({
    name: 'list_todo',
    description: '列出用户的所有待办事项',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async (_input, ctx) => {
      const userId = ctx?.context?.userId
      const cards = memoryManager.store.listCategory(userId, 'todo')
      if (!cards.length) return '暂无待办事项'
      return cards.map((c) => `- ${c.content}${c.due ? `（截止 ${new Date(c.due).toISOString().slice(0, 10)}）` : ''}`).join('\n')
    },
  })

  /** 用户显式要求删除待办 → 物理删除（尊重用户意图，隐私优先）。
   * 与系统自动清理（memory-pruner 走归档、可回滚）语义不同，勿混用。 */
  const deleteTodo = tool({
    name: 'delete_todo',
    description: '删除一条待办事项。用户说“这条待办不用了/删掉/已完成/取消”时使用；有 id 用 id，否则给内容关键词',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '待办 id（已知则优先使用）' },
        content: { type: 'string', description: '待办内容关键词（不知道 id 时用）' },
      },
      required: [],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      const cards = memoryManager.store.listCategory(userId, 'todo')
      if (!cards.length) return '当前没有待办事项'
      const key = String(input?.content || '').trim()
      const target = input?.id
        ? cards.find((c) => c.id === String(input.id))
        : key
          ? cards.find((c) => c.content.includes(key)) || cards.find((c) => key.includes(c.content))
          : null
      if (!target) {
        return `没找到匹配的待办事项。当前待办：\n${cards.map((c) => `- ${c.content}`).join('\n')}\n请用更准确的关键词，或先调用 list_todo 确认。`
      }
      const ok = memoryManager.store.delete(userId, target.id)
      return ok ? `已删除待办：${target.content}` : `删除失败（该待办可能已不存在）：${target.content}`
    },
  })

  return { addTodo, listTodo, deleteTodo }
}
