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

  return { addTodo, listTodo }
}
