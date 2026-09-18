import test from 'node:test'
import assert from 'node:assert/strict'
import { createTriage } from '../src/llm/triage.mjs'

const PLAN_JSON = JSON.stringify({
  plan: [
    { subject: '导出季度总结为PDF', description: 'd1', activeForm: '正在导出', dependsOn: [] },
    { subject: '按PDF写摘要', description: 'd2', activeForm: '正在写摘要', dependsOn: [0] },
  ],
})

function make(responses) {
  const calls = []
  const complete = async (messages, opts) => {
    calls.push({ messages, opts })
    const r = responses.shift()
    if (r instanceof Error) throw r
    if (typeof r === 'function') return r()
    return r
  }
  return { triage: createTriage({ complete, timeoutMs: 200, planTimeoutMs: 200 }), calls }
}

// ============ classify（快路：kind + ack，小输出） ============

test('classify: task verdict with ack; prompt carries context/tasks/attachments; small output budget', async () => {
  const { triage, calls } = make([JSON.stringify({ kind: 'task', ack: '收到，我分两步做好发你' })])
  const r = await triage.classify({
    text: '把季度总结导出PDF再写摘要发我',
    transcript: [{ role: 'user', content: '早' }, { role: 'assistant', content: '早呀' }],
    activeTasks: [{ id: 7, subject: '旧任务', status: 'in_progress' }],
    attachments: [{ name: '季度总结.docx', path: 'inbox/季度总结.docx' }],
  })
  assert.deepEqual(r, { kind: 'task', ack: '收到，我分两步做好发你' })
  const user = calls[0].messages.find((m) => m.role === 'user').content
  assert.match(user, /早呀/)
  assert.match(user, /#7 旧任务/)
  assert.match(user, /inbox\/季度总结\.docx/)
  assert.ok(calls[0].opts.maxTokens <= 200, '快路输出预算必须小（回执延迟 = 这一跳）')
})

test('classify R1 degrade to chat: throw / timeout / empty-twice / unparsable (with raw snippet)', async () => {
  const a = make([new Error('gateway 500')])
  assert.equal((await a.triage.classify({ text: 'x' })).kind, 'chat')
  const b = make([() => new Promise(() => {})])
  assert.equal((await b.triage.classify({ text: 'x' })).kind, 'chat')
  const c = make(['', '  ']) // 亚秒空返回：原样重试一次，仍空 → triage_empty
  const rc = await c.triage.classify({ text: 'x' })
  assert.equal(rc.reason, 'triage_empty')
  assert.equal(c.calls.length, 2)
  const d = make(['我是散文不是JSON'])
  const rd = await d.triage.classify({ text: 'x' })
  assert.match(rd.reason, /^triage_unparsable:.*散文/)
})

test('classify: empty-then-good retries transparently; ack fallback and truncation', async () => {
  const ok = make(['', JSON.stringify({ kind: 'task', ack: 'a' })])
  assert.equal((await ok.triage.classify({ text: 'x' })).kind, 'task')
  const noAck = make([JSON.stringify({ kind: 'task' })])
  const r = await noAck.triage.classify({ text: '总结昆山农商今天的消息' })
  assert.match(r.ack, /收到，这就去办：总结昆山农商/)
  const longAck = make([JSON.stringify({ kind: 'task', ack: '啊'.repeat(200) })])
  assert.ok((await longAck.triage.classify({ text: 'x' })).ack.length <= 81)
  const chat = make([JSON.stringify({ kind: 'chat' })])
  assert.deepEqual(await chat.triage.classify({ text: '你好' }), { kind: 'chat' })
})

// ============ plan（慢路：回执后生成，失败返回 null） ============

test('plan: valid object plan; string-array plan normalized (real small-model shape); ack passed in prompt', async () => {
  const a = make([PLAN_JSON])
  const p1 = await a.triage.plan({ text: 'x', ack: '收到，我分两步做' })
  assert.equal(p1.length, 2)
  assert.deepEqual(p1[1].dependsOn, [0])
  assert.match(a.calls[0].messages.find((m) => m.role === 'user').content, /收到，我分两步做/)
  const b = make([JSON.stringify({ plan: ['汇总今天的动态', '生成图片报告并发送'] })])
  const p2 = await b.triage.plan({ text: '总结昆山农商做成图片报告', ack: 'a' })
  assert.deepEqual(p2.map((x) => x.subject), ['汇总今天的动态', '生成图片报告并发送'])
})

test('plan returns null on: throw / empty-twice / bad JSON after hint-retry / oversize / bad dep / cycle', async () => {
  const mk = (plan) => JSON.stringify({ plan })
  assert.equal(await make([new Error('boom')]).triage.plan({ text: 'x' }), null)
  assert.equal(await make(['', '']).triage.plan({ text: 'x' }), null)
  const badJson = make(['散文', '还是散文'])
  assert.equal(await badJson.triage.plan({ text: 'x' }), null)
  assert.equal(badJson.calls.length, 2, '坏 JSON 应带纠正提示重试一次')
  assert.equal(await make([mk(Array.from({ length: 6 }, (_, i) => `s${i}`))]).triage.plan({ text: 'x' }), null)
  assert.equal(await make([mk([{ subject: 'a', dependsOn: [5] }])]).triage.plan({ text: 'x' }), null)
  assert.equal(await make([mk([{ subject: 'a', dependsOn: [1] }, { subject: 'b', dependsOn: [0] }])]).triage.plan({ text: 'x' }), null)
})

test('plan: broken JSON with unescaped quotes is repaired (json-repair reuse)', async () => {
  const broken = '{"plan":[{"subject":"导出"报告"","description":"","activeForm":"","dependsOn":[]}]}'
  const { triage } = make([broken])
  const p = await triage.plan({ text: 'x' })
  assert.equal(p[0].subject, '导出"报告"')
})
