import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryExtractor, parseCards, buildExtractPrompt } from '../src/llm/memory-extractor.mjs'

test('parseCards handles valid JSON array and filters bad entries', () => {
  const cards = parseCards('好的，以下是提取结果：[{"action":"add","type":"identity","content":"会员号12345"},{"action":"update","type":"preference","subject":"饮食","content":"对花生过敏"},{"type":"bad","content":"x"},{"action":"add","type":"fact","content":""}]')
  assert.equal(cards.length, 2)
  assert.equal(cards[0].type, 'identity')
  assert.equal(cards[1].action, 'update')
})

test('parseCards returns [] for non-JSON / empty', () => {
  assert.deepEqual(parseCards('没有值得记住的'), [])
  assert.deepEqual(parseCards(''), [])
})

test('extractor invokes complete and parses', async () => {
  const extractor = new MemoryExtractor({ complete: async (messages) => { assert.ok(messages[0].content.includes('记忆提取器')); return '[{"action":"add","type":"fact","content":"有两辆车"}]' } })
  const cards = await extractor.extract('我有两辆车', '好的')
  assert.equal(cards.length, 1)
  assert.equal(cards[0].content, '有两辆车')
})

test('buildExtractPrompt asks for the four types', () => {
  const p = buildExtractPrompt('我叫张三', '你好张三')
  assert.match(p, /identity/)
  assert.match(p, /preference/)
  assert.match(p, /fact/)
  assert.match(p, /todo/)
})
