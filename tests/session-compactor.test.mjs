import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionCompactor, buildSummarizePrompt } from '../src/llm/session-compactor.mjs'
import { estimateMessagesTokens, estimateTokens } from '../src/services/tokenizer.mjs'

test('tokenizer estimates CJK and english roughly', () => {
  assert.equal(estimateTokens('你好'), 2)
  assert.ok(estimateTokens('hello world') >= 1)
})

test('compactor triggers by token ratio and folds oldest turns', async () => {
  let summarized = ''
  const compactor = new SessionCompactor({ summarize: async (turns) => { summarized = turns.map((t) => t.content).join('|'); return '摘要：讨论过天气' }, tokenBudget: 1000, threshold: 0.5, keepTurns: 3 })
  // build a transcript clearly over 500 tokens
  const transcript = []
  for (let i = 0; i < 40; i++) { transcript.push({ role: 'user', content: '这是一段用于测试折叠的较长中文内容'.repeat(3) }); transcript.push({ role: 'assistant', content: 'ok'.repeat(10) }) }
  assert.equal(compactor.needsFold(transcript), true)
  const r = await compactor.fold(transcript)
  assert.equal(r.folded, true)
  assert.equal(r.keptTranscript.length, 3) // keepTurns
  assert.match(r.summary, /摘要/)
  assert.ok(summarized.length > 0)
})

test('buildSummarizePrompt includes roles and content', () => {
  const p = buildSummarizePrompt([{ role: 'user', content: '你好' }, { role: 'assistant', content: '嗨' }])
  assert.match(p, /用户: 你好/)
  assert.match(p, /助手: 嗨/)
  assert.match(p, /只输出摘要本身/)
})
