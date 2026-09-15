import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { MemoryStore } from '../src/services/memory-store.mjs'
import { todoTools } from '../src/tools/todo-tools.mjs'

const call = (toolFn, input, ctx) => toolFn.invoke(ctx, JSON.stringify(input))

function makeTools() {
  const file = path.join(os.tmpdir(), `todo-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const store = new MemoryStore({ file })
  return { file, store, tools: todoTools({ memoryManager: { store } }), ctx: { context: { userId: 'u1' } } }
}
const cleanup = (file) => { try { fs.rmSync(file, { force: true }) } catch (e) {} }

test('add_todo stores a todo, list_todo renders it, delete_todo removes it by keyword', async () => {
  const { file, store, tools, ctx } = makeTools()
  try {
    await call(tools.addTodo, { content: '查看四川银行内部技术群🍊发的图片' }, ctx)
    await call(tools.addTodo, { content: '跟进 NAS 数据定时清理' }, ctx)
    let out = await call(tools.listTodo, {}, ctx)
    assert.match(out, /四川银行/)
    assert.match(out, /NAS/)

    const deleted = await call(tools.deleteTodo, { content: '图片' }, ctx)
    assert.match(deleted, /已删除待办/)
    assert.match(deleted, /四川银行/)

    out = await call(tools.listTodo, {}, ctx)
    assert.doesNotMatch(out, /四川银行/)      // 目标被删
    assert.match(out, /NAS/)                  // 其他待办不受影响
    assert.equal(store.listCategory('u1', 'todo').length, 1)
  } finally { cleanup(file) }
})

test('delete_todo deletes by exact id when given one', async () => {
  const { file, store, tools, ctx } = makeTools()
  try {
    await call(tools.addTodo, { content: '甲任务' }, ctx)
    await call(tools.addTodo, { content: '乙任务' }, ctx)
    const target = store.listCategory('u1', 'todo').find((c) => c.content === '乙任务')
    const out = await call(tools.deleteTodo, { id: target.id }, ctx)
    assert.match(out, /已删除待办：乙任务/)
    assert.deepEqual(store.listCategory('u1', 'todo').map((c) => c.content), ['甲任务'])
  } finally { cleanup(file) }
})

test('delete_todo never guesses: no match returns the candidate list and deletes nothing', async () => {
  const { file, store, tools, ctx } = makeTools()
  try {
    await call(tools.addTodo, { content: '甲任务' }, ctx)
    const out = await call(tools.deleteTodo, { content: '完全不相关的内容' }, ctx)
    assert.match(out, /没找到匹配的待办事项/)
    assert.match(out, /甲任务/)                // 把候选列出来让模型重新确认
    assert.equal(store.listCategory('u1', 'todo').length, 1)
    // 空输入同样不删除
    const empty = await call(tools.deleteTodo, {}, ctx)
    assert.match(empty, /没找到匹配的待办事项/)
    assert.equal(store.listCategory('u1', 'todo').length, 1)
  } finally { cleanup(file) }
})

test('delete_todo is a physical delete (user intent) — nothing lands in the archive', async () => {
  const { file, store, tools, ctx } = makeTools()
  try {
    await call(tools.addTodo, { content: '临时待办' }, ctx)
    await call(tools.deleteTodo, { content: '临时待办' }, ctx)
    assert.deepEqual(store.listArchived('u1'), [])   // 与 pruner 的归档语义不同
    assert.equal(store.listCategory('u1', 'todo').length, 0)
  } finally { cleanup(file) }
})

test('list_todo hides archived todos (pruned items disappear from the model view)', async () => {
  const { file, store, tools, ctx } = makeTools()
  try {
    await call(tools.addTodo, { content: '老待办' }, ctx)
    const card = store.listCategory('u1', 'todo')[0]
    store.archive('u1', [card.id], 'aged_todo', Date.now())
    const out = await call(tools.listTodo, {}, ctx)
    assert.equal(out, '暂无待办事项')
  } finally { cleanup(file) }
})
