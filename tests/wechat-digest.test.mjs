import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DIGEST_SECTIONS,
  MAX_FUN_ITEMS,
  buildDigestMapPrompt,
  buildDigestReducePrompt,
  buildGroupTagPrompt,
  digestItemsOf,
  digestWindowDays,
  groupItemsBySection,
  parseDigestCandidates,
  parseDigestJson,
  parseGroupTagJson,
  renderDigestPage,
  renderDigestPoster,
  renderDigestPushText,
  renderQuietText,
  sourceLabel,
} from '../src/services/wechat-digest.mjs'

test('digestWindowDays derives the fetch window from the schedule, not a config field', () => {
  assert.equal(digestWindowDays('daily@21:30'), 1)
  assert.equal(digestWindowDays('hourly@00'), 1)
  // weekly@D：D=1 周一 … 7 周日（schedule.mjs 的实现语义）
  assert.equal(digestWindowDays('weekly@7@20:00'), 7)
  assert.equal(digestWindowDays('weekly@1@09:00'), 7)
  // 坏表达式不抛 —— 退化成日报窗口，由 parseSchedule 在写入时把关
  assert.equal(digestWindowDays('nonsense'), 1)
})

test('map prompt carries the tag-specific focus and the user identity', () => {
  const work = buildDigestMapPrompt({ chatName: '项目群', tag: 'work', nickname: '张三', messages: [{ tsMs: Date.UTC(2026, 8, 16, 6, 0), sender: '李四', content: '@张三 明天前给个答复' }] })
  assert.match(work, /项目群/)
  assert.match(work, /张三/)
  assert.match(work, /deadline/)
  assert.match(work, /@张三 明天前给个答复/)
  assert.match(work, /不是群聊摘要/)

  const family = buildDigestMapPrompt({ chatName: '家人群', tag: 'family', messages: [] })
  assert.match(family, /就医/)
  assert.doesNotMatch(family, /deadline/)
})

test('parseGroupTagJson keeps valid rows and drops garbage', () => {
  const ok = parseGroupTagJson('这是结果：\n{"groups":[{"chatWxid":"g1","tag":"work","confidence":0.8},{"chatWxid":"g2","tag":"不存在的标签"},{"tag":"family"},{"chatWxid":"g3","tag":"dead","confidence":9}]}')
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.groups, [
    { chatWxid: 'g1', tag: 'work', confidence: 0.8 },
    { chatWxid: 'g3', tag: 'dead', confidence: 1 }, // confidence 夹紧到 [0,1]
  ])
  assert.deepEqual(parseGroupTagJson('完全不是 JSON'), { ok: false, groups: [] })
})

test('buildGroupTagPrompt batches every sampled group into one call', () => {
  const p = buildGroupTagPrompt([
    { chatWxid: 'g1', chatName: '项目群', lines: ['[2026-09-16 14:00][李四] 上线排期'] },
    { chatWxid: 'g2', chatName: '', lines: [] },
  ])
  assert.match(p, /g1/)
  assert.match(p, /g2/)
  assert.match(p, /上线排期/)
  assert.match(p, /\(无群名\)/)
  assert.match(p, /\(近 7 天无消息\)/)
})

test('parseDigestCandidates backfills the chat name from our own side, not the model', () => {
  const r = parseDigestCandidates('{"candidates":[{"section":"action_items","title":"给李四回复接口方案","detail":"明天前","sender":"李四","at":"2026-09-16 14:00","chatName":"模型瞎编的群"},{"title":"没有 section 的条目"},{"title":""}]}', { chatName: '项目群' })
  assert.equal(r.ok, true)
  assert.equal(r.candidates.length, 2)
  assert.equal(r.candidates[0].chatName, '项目群') // 溯源信息只信我们查库那一侧
  assert.equal(r.candidates[0].section, 'action_items')
  assert.equal(r.candidates[1].section, 'work_updates') // 缺 section → 默认
  assert.deepEqual(parseDigestCandidates('不是 JSON'), { ok: false, candidates: [] })
})

test('reduce prompt injects the profile, preferences and (weekly only) previous titles', () => {
  const base = {
    taskName: '微信日报', instruction: '只捞和我有关的', nickname: '张三',
    candidates: [{ chatName: '项目群', at: '2026-09-16 14:00', sender: '李四', title: '接口方案', detail: '明天前' }],
    profileContent: '常年做后端，关注架构',
    preferences: ['不想再看到摄影群的图片刷屏'],
    previousTitles: ['上周的排期讨论'],
  }
  const daily = buildDigestReducePrompt({ ...base, windowDays: 1 })
  assert.match(daily, /常年做后端/)
  assert.match(daily, /不想再看到摄影群的图片刷屏/)
  assert.match(daily, /必须遵守/)
  assert.match(daily, /\[项目群\]\[2026-09-16 14:00\]\[李四\] 接口方案 — 明天前/)
  assert.doesNotMatch(daily, /上周的排期讨论/) // 日报不做趋势对比

  const weekly = buildDigestReducePrompt({ ...base, windowDays: 7 })
  assert.match(weekly, /上周的排期讨论/)
  assert.match(weekly, /趋势对比/)
  assert.match(weekly, /过去 7 天/)

  // 没有候选时也能构造（runner 其实会短路，不会走到这里）
  assert.match(buildDigestReducePrompt({ ...base, candidates: [] }), /本期没有任何候选/)
})

test('parseDigestJson distinguishes "unparsable" from "legitimately empty"', () => {
  const full = parseDigestJson(`前言\n{"focus":"今天主要是项目群","action_items":[{"title":"回复接口方案","summary":"李四等答复","source":"项目群","at":"2026-09-16 14:00"}],"work_updates":[{"title":"排期确定"}],"fun":[{"title":"A"},{"title":"B"},{"title":"C"},{"title":"D"}]}`)
  assert.equal(full.ok, true)
  assert.equal(full.empty, false)
  assert.equal(full.focus, '今天主要是项目群')
  assert.equal(full.sections.action_items.length, 1)
  assert.equal(full.sections.fun.length, MAX_FUN_ITEMS) // 硬上限截断
  assert.equal(full.count, 1 + 1 + MAX_FUN_ITEMS)

  // 合法 JSON、三节全空 → ok:true + empty:true（正常结果，不是失败，不该重试）
  const quiet = parseDigestJson('{"focus":"","action_items":[],"work_updates":[],"fun":[]}')
  assert.equal(quiet.ok, true)
  assert.equal(quiet.empty, true)
  assert.deepEqual(quiet.sections, {})

  // 真的解析不了 → ok:false（走降级 + 重试）
  assert.equal(parseDigestJson('模型今天罢工了').ok, false)
  assert.equal(parseDigestJson('').ok, false)
  // 空节被省略，而不是留一个空数组
  const partial = parseDigestJson('{"action_items":[{"title":"只有这一条"}]}')
  assert.deepEqual(Object.keys(partial.sections), ['action_items'])
})

test('items carry a "来自 XX 群 · 时间" trace and round-trip back into sections', () => {
  assert.equal(sourceLabel({ source: '项目群', at: '2026-09-16 14:30' }), '来自 项目群 · 09-16 14:30')
  assert.equal(sourceLabel({ source: '项目群', at: '2026-09-16' }), '来自 项目群 · 09-16')
  assert.equal(sourceLabel({ source: '项目群', at: '模型编的时间' }), '来自 项目群')
  assert.equal(sourceLabel({ source: '', at: '' }), '')

  const items = digestItemsOf({
    fun: [{ title: 'F', summary: '', source: '摄影群', at: '2026-09-16 20:00' }],
    action_items: [{ title: 'A', summary: 'a', source: '项目群', at: '2026-09-16 14:00' }],
  })
  // 顺序固定按 DIGEST_SECTIONS（action_items 在 fun 之前），与输入对象的键序无关
  assert.deepEqual(items.map((i) => i.section), ['action_items', 'fun'])
  assert.equal(items[0].source, '来自 项目群 · 09-16 14:00')
  assert.equal(items[0].url, '')

  const grouped = groupItemsBySection(items)
  assert.deepEqual(Object.keys(grouped), ['action_items', 'fun'])
  assert.equal(grouped.action_items[0].title, 'A')
  // 没有 section 的老数据落进 work_updates，不会凭空消失
  assert.equal(groupItemsBySection([{ title: 'X' }]).work_updates.length, 1)
})

test('push text counts the sections and always offers the feedback hook', () => {
  const report = {
    name: '微信日报',
    items: [
      { title: 'A', section: 'action_items' },
      { title: 'B', section: 'work_updates' },
      { title: 'C', section: 'work_updates' },
    ],
  }
  const text = renderDigestPushText(report, { reportUrl: 'https://x.test/reports/rp-1' })
  assert.match(text, /微信日报 已送达/)
  assert.match(text, /需要你行动 1 条/)
  assert.match(text, /你该知道 2 条/)
  assert.doesNotMatch(text, /值得一看/) // 空节不出现
  assert.match(text, /https:\/\/x\.test\/reports\/rp-1/)
  assert.match(text, /哪条没用？直接回我/) // 反馈闭环入口
  assert.match(renderDigestPushText(report, { resend: true }), /补发/)
})

test('quiet-day text differs between daily and weekly', () => {
  assert.match(renderQuietText('微信日报', { windowDays: 1 }), /今天各群平静/)
  assert.match(renderQuietText('微信周报', { windowDays: 7 }), /这一周各群都挺平静/)
})

test('poster and page render every section with its trace and escape user content', () => {
  const report = {
    name: '微信日报',
    runAt: Date.UTC(2026, 8, 16, 13, 30),
    focus: '今天主要是项目群',
    items: [
      { title: '回复<接口>方案', summary: '李四等答复', source: '来自 项目群 · 09-16 14:00', section: 'action_items' },
      { title: '排期确定', summary: '', source: '来自 项目群 · 09-16 15:00', section: 'work_updates' },
    ],
  }
  for (const html of [renderDigestPoster(report), renderDigestPage(report)]) {
    assert.match(html, /微信日报/)
    assert.match(html, /需要你行动/)
    assert.match(html, /你该知道/)
    assert.doesNotMatch(html, /值得一看/)
    assert.match(html, /来自 项目群 · 09-16 14:00/)
    assert.match(html, /今天主要是项目群/)
    // XSS：群名/标题来自聊天记录，必须转义
    assert.match(html, /回复&lt;接口&gt;方案/)
    assert.doesNotMatch(html, /回复<接口>方案/)
  }
  // 公网页在空报告上也不崩
  const empty = renderDigestPage({ name: '微信日报', runAt: Date.now(), focus: '', items: [] })
  assert.match(empty, /各群平静/)
})

test('section keys are the contract shared by parser, renderer and store', () => {
  assert.deepEqual(DIGEST_SECTIONS, ['action_items', 'work_updates', 'fun'])
})
