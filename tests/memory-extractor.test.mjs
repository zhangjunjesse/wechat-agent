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

test('buildExtractPrompt carries the v2 quality gates (writing-quality P0)', () => {
  const p = buildExtractPrompt('我习惯先看摘要', '好的', new Date('2026-09-14T04:00:00Z'))
  assert.match(p, /3 天后/)                 // 重要性门槛：3 天后还有用吗
  assert.match(p, /流水账/)                 // episodic 收紧：流水账即使发生也不提取
  assert.match(p, /交互偏好/)               // preference 向交互偏好倾斜
  assert.match(p, /帮我记着/)               // todo 门槛：明确要求才提取
  assert.match(p, /emotion/)                // 第一层评分所需的情感强度字段
  assert.match(p, /update.*覆盖旧信息/)      // 冲突解决语义（提高 update 触发率）
})

test('parseCards keeps emotion within 0-1, defaults to 0 when absent/unparsable', () => {
  const cards = parseCards('[{"type":"semantic","category":"fact","content":"A","emotion":0.8},{"type":"semantic","category":"fact","content":"B"},{"type":"semantic","category":"fact","content":"C","emotion":5},{"type":"semantic","category":"fact","content":"D","emotion":"x"}]')
  assert.equal(cards.length, 4)
  assert.equal(cards[0].emotion, 0.8)
  assert.equal(cards[1].emotion, 0)          // 缺失 → 0（评分层按 0.3 中性基线处理）
  assert.equal(cards[2].emotion, 1)          // 上界截断
  assert.equal(cards[3].emotion, 0)          // 不可解析
})
