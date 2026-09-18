import test from 'node:test'
import assert from 'node:assert/strict'
import { createTriage } from '../src/llm/triage.mjs'

const TASK_JSON = JSON.stringify({
  kind: 'task',
  ack: '收到。你要把季度总结导出PDF再写摘要，我分两步做',
  plan: [
    { subject: '导出季度总结为PDF', description: 'd1', activeForm: '正在导出', dependsOn: [] },
    { subject: '按PDF写摘要', description: 'd2', activeForm: '正在写摘要', dependsOn: [0] },
  ],
})

function make(responses) {
  const calls = []
  const complete = async (messages) => {
    calls.push(messages)
    const r = responses.shift()
    if (r instanceof Error) throw r
    if (typeof r === 'function') return r()
    return r
  }
  return { triage: createTriage({ complete, timeoutMs: 200 }), calls }
}

test('valid task JSON → validated plan with deps; prompt carries context/tasks/attachments', async () => {
  const { triage, calls } = make([TASK_JSON])
  const r = await triage({
    text: '把季度总结导出PDF再写摘要发我',
    transcript: [{ role: 'user', content: '早' }, { role: 'assistant', content: '早呀' }],
    activeTasks: [{ id: 7, subject: '旧任务', status: 'in_progress' }],
    attachments: [{ name: '季度总结.docx', path: 'inbox/季度总结.docx' }],
  })
  assert.equal(r.kind, 'task')
  assert.equal(r.plan.length, 2)
  assert.deepEqual(r.plan[1].dependsOn, [0])
  assert.match(r.ack, /分两步/)
  // 输入完整性：最近对话 / 活跃任务（追问判 chat 的依据）/ 附件路径
  const user = calls[0].find((m) => m.role === 'user').content
  assert.match(user, /早呀/)
  assert.match(user, /#7 旧任务/)
  assert.match(user, /inbox\/季度总结\.docx/)
})

test('R1 degrade to chat: LLM throws / times out / unparsable-after-retry', async () => {
  const a = make([new Error('gateway 500')])
  assert.equal((await a.triage({ text: 'x' })).kind, 'chat')
  const b = make([() => new Promise(() => {})]) // 永不返回 → 超时
  assert.equal((await b.triage({ text: 'x' })).kind, 'chat')
  const c = make(['这不是json', '还不是json']) // 首次坏 → 带纠正提示重试一次 → 仍坏 → chat
  const rc = await c.triage({ text: 'x' })
  assert.equal(rc.kind, 'chat')
  assert.equal(c.calls.length, 2, '解析失败应恰好重试一次')
  assert.match(c.calls[1].at(-1).content, /不是合法 JSON/)
})

test('R2 plan validation degrades to chat: size / empty subject / bad dep / cycle', async () => {
  const mk = (plan) => JSON.stringify({ kind: 'task', ack: 'a', plan })
  const size = make([mk(Array.from({ length: 6 }, (_, i) => ({ subject: `s${i}`, dependsOn: [] })))])
  assert.equal((await size.triage({ text: 'x' })).kind, 'chat')
  const empty = make([mk([{ subject: '  ', dependsOn: [] }])])
  assert.equal((await empty.triage({ text: 'x' })).kind, 'chat')
  const bad = make([mk([{ subject: 'a', dependsOn: [5] }])])
  assert.equal((await bad.triage({ text: 'x' })).kind, 'chat')
  const cyc = make([mk([{ subject: 'a', dependsOn: [1] }, { subject: 'b', dependsOn: [0] }])])
  assert.equal((await cyc.triage({ text: 'x' })).kind, 'chat')
})

test('R3 ack fallback + truncation; code-fence tolerated; broken JSON repaired', async () => {
  const noAck = make([JSON.stringify({ kind: 'task', plan: [{ subject: '导出文档', dependsOn: [] }] })])
  const r1 = await noAck.triage({ text: 'x' })
  assert.match(r1.ack, /收到，我来办：导出文档/)
  const longAck = make([JSON.stringify({ kind: 'task', ack: '啊'.repeat(200), plan: [{ subject: 's', dependsOn: [] }] })])
  assert.ok((await longAck.triage({ text: 'x' })).ack.length <= 81)
  const fenced = make(['```json\n' + TASK_JSON + '\n```'])
  assert.equal((await fenced.triage({ text: 'x' })).kind, 'task')
  // 真实事故形态：字符串值内未转义引号 → json-repair 兜住
  const broken = '{"kind":"task","ack":"收到","plan":[{"subject":"导出"报告"","description":"","activeForm":"","dependsOn":[]}]}'
  const rep = make([broken])
  const rr = await rep.triage({ text: 'x' })
  assert.equal(rr.kind, 'task')
  assert.equal(rr.plan[0].subject, '导出"报告"')
})

test('chat verdicts pass through untouched', async () => {
  const { triage } = make([JSON.stringify({ kind: 'chat' })])
  assert.deepEqual(await triage({ text: '你好' }), { kind: 'chat' })
})

test('string-array plan is normalized, not rejected (real small-model output shape)', async () => {
  const { triage } = make([JSON.stringify({ kind: 'task', ack: '好的我来办', plan: ['汇总今天的动态', '生成图片报告并发送'] })])
  const r = await triage({ text: '总结昆山农商今天的消息做成图片报告' })
  assert.equal(r.kind, 'task')
  assert.deepEqual(r.plan.map((p) => p.subject), ['汇总今天的动态', '生成图片报告并发送'])
  assert.deepEqual(r.plan[0].dependsOn, [])
})

test('sub-second empty gateway response: plain retry once, then degrade with distinct reason', async () => {
  const ok = make(['', TASK_JSON]) // 第一次空 → 原样重试 → 成功
  const r1 = await ok.triage({ text: 'x' })
  assert.equal(r1.kind, 'task')
  assert.equal(ok.calls.length, 2)
  const bad = make(['', '   ']) // 两次都空 → triage_empty（不与坏 JSON 混淆）
  const r2 = await bad.triage({ text: 'x' })
  assert.equal(r2.kind, 'chat')
  assert.equal(r2.reason, 'triage_empty')
})

test('unparsable reason carries a truncated raw snippet for diagnostics', async () => {
  const { triage } = make(['我不是JSON我是散文', '还是散文'])
  const r = await triage({ text: 'x' })
  assert.equal(r.kind, 'chat')
  assert.match(r.reason, /^triage_unparsable:.*散文/)
})
