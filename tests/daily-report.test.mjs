import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReportPrompt, parseReportJson, dedupeItems, renderWeChatDigest, renderReportPage } from '../src/services/daily-report.mjs'
import { fingerprintOf } from '../src/services/report-store.mjs'

test('buildReportPrompt carries task, dedup list, cover instruction and JSON schema', () => {
  const task = { name: '每日早报', instruction: '生成早报' }
  const p = buildReportPrompt(task, ['旧闻1', '旧闻2'])
  assert.match(p, /【定时任务「每日早报」】/)
  assert.match(p, /生成早报/)
  assert.match(p, /旧闻1/)
  assert.match(p, /近 7 天已报道/)
  assert.match(p, /"items"/)
  assert.match(p, /只输出 JSON/)
  // cover 指令仅在 cover=true 时出现
  assert.doesNotMatch(p, /image-studio/)
  const pc = buildReportPrompt(task, [], { cover: true })
  assert.match(pc, /image-studio/)
  assert.match(pc, /image_generate/)
  assert.match(pc, /16:9/)
  assert.match(pc, /"cover"/)
})

test('parseReportJson handles plain, fenced, wrapped and invalid inputs', () => {
  const valid = { focus: '关注', items: [{ title: 'T1', summary: 'S1', source: '源', url: 'https://x.com' }] }
  assert.deepEqual(parseReportJson(JSON.stringify(valid)), { ok: true, focus: '关注', cover: '', items: valid.items })
  assert.equal(parseReportJson('```json\n' + JSON.stringify(valid) + '\n```').ok, true)
  const wrapped = parseReportJson('好的，这是日报：' + JSON.stringify(valid))
  assert.equal(wrapped.ok, true)
  // cover 字段透传
  const withCover = parseReportJson(JSON.stringify({ cover: 'images/cov.png', items: [{ title: 'A', summary: 's' }] }))
  assert.equal(withCover.cover, 'images/cov.png')
  // 非法输入全部降级
  assert.equal(parseReportJson('抱歉无法生成').ok, false)
  assert.equal(parseReportJson('{"items":[]}').ok, false)
  assert.equal(parseReportJson('{"items":"not-an-array"}').ok, false)
  assert.equal(parseReportJson('').ok, false)
  // 坏条目被丢弃：非法 url、超长标题、缺 title
  const mixed = parseReportJson(JSON.stringify({
    items: [
      { title: 'A', summary: 's', url: 'ftp://nope' },
      { title: 'B', summary: 's' },
      { title: 'x'.repeat(200), summary: 's' },
      { summary: 'no title' },
    ],
  }))
  assert.equal(mixed.ok, true)
  assert.deepEqual(mixed.items.map((i) => i.title), ['B'])
})

test('dedupeItems drops 7-day duplicates but keeps a floor of 3', () => {
  const items = [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }]
  // 命中 3 条 → 只剩 1 条 < 3 → 保底不删
  const r = dedupeItems(items, new Set([fingerprintOf('A'), fingerprintOf('B'), fingerprintOf('C')]))
  assert.deepEqual(r.items.map((i) => i.title), ['A', 'B', 'C', 'D'])
  assert.equal(r.dropped, 0)
  // 命中 2 条 → 剩 2 条仍 < 3 → 保底不删
  const r2 = dedupeItems(items, new Set([fingerprintOf('A'), fingerprintOf('B')]))
  assert.deepEqual(r2.items.map((i) => i.title), ['A', 'B', 'C', 'D'])
  assert.equal(r2.dropped, 0)
  // 5 条里命中 2 条 → 剩 3 条 ≥ 3 → 正常删
  const items5 = [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }, { title: 'E' }]
  const r3 = dedupeItems(items5, new Set([fingerprintOf('A'), fingerprintOf('B')]))
  assert.deepEqual(r3.items.map((i) => i.title), ['C', 'D', 'E'])
  assert.equal(r3.dropped, 2)
  // 空集合不动
  const r4 = dedupeItems(items, new Set())
  assert.equal(r4.dropped, 0)
  assert.equal(r4.items.length, 4)
  // 指纹归一化参与比对
  const r5 = dedupeItems([{ title: 'OpenAI 发布新模型！' }, { title: '别的' }, { title: '丙' }, { title: '丁' }], new Set([fingerprintOf('openai发布新模型')]))
  assert.deepEqual(r5.items.map((i) => i.title), ['别的', '丙', '丁'])
})

test('renderWeChatDigest contains items, focus and report URL', () => {
  const report = { id: 'rp-x', name: '每日早报', runAt: Date.UTC(2026, 8, 16, 0, 30), focus: '关注点', items: [{ title: 'T1', summary: 'S1', source: '公众号A', url: 'https://a.com' }] }
  const t = renderWeChatDigest({ report, reportUrl: 'https://h.example/reports/rp-x' })
  assert.match(t, /T1/)
  assert.match(t, /S1/)
  assert.match(t, /公众号A/)
  assert.match(t, /https:\/\/a\.com/)
  assert.match(t, /关注点/)
  assert.match(t, /https:\/\/h\.example\/reports\/rp-x/)
  assert.match(t, /第N条展开讲讲/)
  assert.match(t, /9月16日/)
})

test('renderReportPage is responsive HTML with escaped content', () => {
  const report = {
    id: 'rp-x', name: '每日早报', runAt: Date.UTC(2026, 8, 16, 0, 30), focus: '关注',
    coverPath: '/tmp/cov.png',
    items: [{ title: '<script>alert(1)</script>', summary: 's', source: 'src', url: 'https://a.com' }],
  }
  const html = renderReportPage(report)
  assert.match(html, /<meta name="viewport"/)
  assert.match(html, /阅读原文/)
  assert.match(html, /<img class="cover"/)
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /关注/)
  // 无封面时不出 <img class="cover">
  const html2 = renderReportPage({ ...report, coverPath: '' })
  assert.doesNotMatch(html2, /<img class="cover"/)
})
