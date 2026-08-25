import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryExtractor, parseCards, buildExtractPrompt } from '../src/llm/memory-extractor.mjs'

test('parseCards handles valid JSON with type/category/context/due', () => {
  const cards = parseCards('结果：[{"action":"add","type":"semantic","category":"identity","content":"会员号12345","context":"用户主动告知会员号"},{"action":"update","type":"semantic","category":"preference","subject":"饮食","content":"对花生过敏"},{"action":"add","type":"episodic","category":"todo","content":"下周一交方案","due":"2026-09-01"},{"type":"bad","content":"x"}]')
  assert.equal(cards.length, 3)
  assert.equal(cards[0].type, 'semantic')
  assert.equal(cards[0].category, 'identity')
  assert.match(cards[0].context, /主动告知/)
  assert.equal(cards[2].type, 'episodic')
  assert.equal(cards[2].category, 'todo')
  assert.ok(cards[2].due > 0)
})

test('parseCards returns [] for non-JSON / empty', () => {
  assert.deepEqual(parseCards('没有值得记住的'), [])
  assert.deepEqual(parseCards(''), [])
})

test('buildExtractPrompt asks for episodic/semantic + categories + due', () => {
  const p = buildExtractPrompt('我叫张三', '你好张三', new Date('2026-08-24T10:00:00'))
  assert.match(p, /episodic/)
  assert.match(p, /semantic/)
  assert.match(p, /identity/)
  assert.match(p, /preference/)
  assert.match(p, /fact/)
  assert.match(p, /todo/)
  assert.match(p, /due/)
  assert.match(p, /2026-08-24/)
})
