import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { ReportStore, fingerprintOf, reportIdOf } from '../src/services/report-store.mjs'

function setup() {
  const file = path.join(os.tmpdir(), `rp-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const store = new ReportStore({ file })
  return { file, store }
}

test('save/get roundtrip with items and stable per-task-day id', () => {
  const { file, store } = setup()
  try {
    // UTC 2026-09-16 00:30 = 北京 2026-09-16 08:30
    const t = Date.UTC(2026, 8, 16, 0, 30)
    const a = store.saveReport({
      taskId: 'global-每日早报', name: '每日早报', runAt: t, focus: '关注AI', rawText: 'raw',
      coverPath: '/tmp/cov.png', posterPath: '/data/reports/rp-x.png',
      items: [{ title: 'Title A', summary: 'sum', source: '公众号', url: 'https://a.com' }],
    })
    assert.ok(a.id.startsWith('rp-'))
    assert.match(a.id, /-20260916$/)
    assert.equal(a.coverPath, '/tmp/cov.png')
    assert.equal(a.posterPath, '/data/reports/rp-x.png')
    assert.equal(a.items.length, 1)
    // 同任务同一天 upsert：id 不变、内容被替换、旧 item 行清除
    const b = store.saveReport({ taskId: 'global-每日早报', name: '每日早报', runAt: t, items: [{ title: 'New', summary: 's2', source: '', url: '' }] })
    assert.equal(b.id, a.id)
    assert.equal(b.items.length, 1)
    assert.equal(b.items[0].title, 'New')
    assert.equal(b.posterPath, '') // upsert 未传 poster → 清空
    const got = store.getReport(a.id)
    assert.equal(got.items[0].title, 'New')
    assert.equal(got.focus, '') // upsert 后 focus 为空（本次未传）
    assert.equal(store.getReport('nope'), null)
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})

test('legacy reports table without poster_path column migrates on open', () => {
  const file = path.join(os.tmpdir(), `rp-old-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE reports (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, name TEXT NOT NULL, run_at INTEGER NOT NULL,
      focus TEXT NOT NULL DEFAULT '', raw_text TEXT NOT NULL DEFAULT '', cover_path TEXT NOT NULL DEFAULT '',
      items_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE report_items (
      report_id TEXT NOT NULL, idx INTEGER NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (report_id, idx)
    );
  `)
  db.close()
  const store = new ReportStore({ file })
  try {
    const r = store.saveReport({ taskId: 't', name: 't', runAt: Date.now(), posterPath: '/x/y.png', items: [{ title: 'A', summary: 's' }] })
    assert.equal(store.getReport(r.id).posterPath, '/x/y.png')
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})

test('legacy reports table without kind/section columns migrates on open, old data defaults to report/plain (D8, ADR-0031/DESIGN-wechat-digest)', () => {
  const file = path.join(os.tmpdir(), `rp-old-kind-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  // 复刻 ADR-0027 之后、DESIGN-wechat-digest 之前的真实老库形状：有 poster_path/
  // user_id/topic，但没有 kind/section——这正是本次要新增迁移覆盖的那道缝。
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE reports (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT '',
      topic TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, run_at INTEGER NOT NULL,
      focus TEXT NOT NULL DEFAULT '', raw_text TEXT NOT NULL DEFAULT '', cover_path TEXT NOT NULL DEFAULT '',
      poster_path TEXT NOT NULL DEFAULT '', items_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE report_items (
      report_id TEXT NOT NULL, idx INTEGER NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (report_id, idx)
    );
  `)
  db.prepare(`INSERT INTO reports (id, task_id, user_id, topic, name, run_at, focus, raw_text, cover_path, poster_path, items_count, created_at)
    VALUES ('rp-old', 'global-每日早报', '', '', '每日早报', ?, '老焦点', 'raw', '', '/x/cov.png', 1, ?)`).run(Date.now(), Date.now())
  db.prepare(`INSERT INTO report_items (report_id, idx, title, summary, source, url, fingerprint) VALUES ('rp-old', 0, '老标题', '老摘要', '老来源', '', 'fp')`).run()
  db.close()

  const store = new ReportStore({ file })
  try {
    // 老数据一字未动：kind 落在迁移的默认值 'report'，section 落在 ''——
    // 行为与迁移前完全一致（app.mjs 据此路由到每日资讯模板，不是 digest 模板）。
    const old = store.getReport('rp-old')
    assert.equal(old.kind, 'report')
    assert.equal(old.items[0].section, '')
    assert.equal(old.focus, '老焦点')

    // 迁移后新写入的 digest 报告能正常带 kind + section 落库（新老数据同库共存）。
    const fresh = store.saveReport({
      taskId: 'global-微信日报', name: '微信日报', runAt: Date.now(), kind: 'wechat-digest',
      items: [{ title: '新标题', summary: '', source: '项目群', section: 'action_items' }],
    })
    assert.equal(store.getReport(fresh.id).kind, 'wechat-digest')
    assert.equal(store.getReport(fresh.id).items[0].section, 'action_items')
    // 老行依旧不受影响
    assert.equal(store.getReport('rp-old').kind, 'report')
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})

test('reportIdOf differs across days, stable within a day', () => {
  const day1 = Date.UTC(2026, 8, 16, 0, 30)
  const day2 = Date.UTC(2026, 8, 17, 0, 30)
  assert.equal(reportIdOf('global-x', day1), reportIdOf('global-x', day1))
  assert.notEqual(reportIdOf('global-x', day1), reportIdOf('global-x', day2))
  assert.notEqual(reportIdOf('global-x', day1), reportIdOf('global-y', day1))
})

test('fingerprint normalization ignores punctuation, whitespace and case', () => {
  assert.equal(fingerprintOf('OpenAI 发布新模型！'), fingerprintOf('openai发布新模型'))
  assert.equal(fingerprintOf('a,b;c。d'), fingerprintOf('abcd'))
  assert.notEqual(fingerprintOf('标题A'), fingerprintOf('标题B'))
})

test('recentFingerprints/recentTitles respect the 7-day window', () => {
  const { file, store } = setup()
  try {
    const now = Date.now()
    store.saveReport({ taskId: 't1', name: 't', runAt: now - 86_400_000, items: [{ title: '新鲜新闻', summary: '', source: '', url: '' }] })
    store.saveReport({ taskId: 't1', name: 't', runAt: now - 8 * 86_400_000, items: [{ title: '陈旧新闻', summary: '', source: '', url: '' }] })
    const fp = store.recentFingerprints('t1', 7)
    assert.ok(fp.has(fingerprintOf('新鲜新闻')))
    assert.ok(!fp.has(fingerprintOf('陈旧新闻')))
    assert.deepEqual(store.recentTitles('t1', 7, 20), ['新鲜新闻'])
    // 其他任务互不影响
    assert.equal(store.recentFingerprints('t2', 7).size, 0)
    const list = store.listReports('t1', 5)
    assert.equal(list.length, 2)
    assert.equal(list[0].name, 't')
    assert.equal(list[0].itemsCount, 1)
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})

test('recentFingerprints/recentTitles accept an injectable `now` (fixes 2026-09-16 flake)', () => {
  // 根因：task-scheduler.mjs 自己的 now() 可注入（测试用固定日期），但过去
  // 没有把它传给 ReportStore，store 内部一直用真实 Date.now() 算 7 天窗口——
  // 测试固定在 2026-09-10 附近的 fixture，跑到第 7 天真实日期就会窗口对不上、
  // 假失败。这里验证：传 now 后，窗口以 now 为基准，与真实墙钟时间无关。
  const { file, store } = setup()
  try {
    const fixedNow = Date.UTC(2026, 8, 10, 0, 0, 30) // 与真实今天（远早于/晚于）无关
    store.saveReport({ taskId: 't1', name: 't', runAt: fixedNow - 86_400_000, items: [{ title: '固定昨日', summary: '', source: '', url: '' }] })
    store.saveReport({ taskId: 't1', name: 't', runAt: fixedNow - 8 * 86_400_000, items: [{ title: '固定过期', summary: '', source: '', url: '' }] })
    // 不传 now：按真实当前时间算窗口，两条记录相对"真实现在"都很旧 → 都不在 7 天内
    assert.deepEqual(store.recentTitles('t1', 7, 20), [])
    assert.equal(store.recentFingerprints('t1', 7).size, 0)
    // 传 now=fixedNow：窗口以 fixedNow 为基准，昨日在窗口内、8 天前不在
    assert.deepEqual(store.recentTitles('t1', 7, 20, { now: fixedNow }), ['固定昨日'])
    assert.ok(store.recentFingerprints('t1', 7, { now: fixedNow }).has(fingerprintOf('固定昨日')))
    assert.ok(!store.recentFingerprints('t1', 7, { now: fixedNow }).has(fingerprintOf('固定过期')))
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})

test('reportIdOf: topic changes the id, but omitting it reproduces the pre-ADR-0027 id exactly (ADR-0027)', () => {
  const day = Date.UTC(2026, 8, 16, 0, 30)
  // 不传 topic：与老哈希输入完全一致（老数据 id 不受这次迁移影响）
  assert.equal(reportIdOf('global-x', day, 'u1'), reportIdOf('global-x', day, 'u1', ''))
  // 传了不同 topic：id 互不相同，且都不同于「同用户无主题」的 id
  const noTopic = reportIdOf('global-x', day, 'u1')
  const ai = reportIdOf('global-x', day, 'u1', 'AI')
  const chip = reportIdOf('global-x', day, 'u1', '芯片')
  assert.notEqual(ai, noTopic)
  assert.notEqual(chip, noTopic)
  assert.notEqual(ai, chip)
  // 同一 (task, user, topic, day) 稳定
  assert.equal(ai, reportIdOf('global-x', day, 'u1', 'AI'))
})

test('a user with multiple topics gets fully isolated reports: distinct ids, dedup windows and listReports (ADR-0027)', () => {
  const { file, store } = setup()
  try {
    const now = Date.now()
    const ai = store.saveReport({ taskId: 't1', name: '早报', runAt: now, userId: 'u1', topic: 'AI', items: [{ title: 'AI新闻', summary: '', source: '', url: '' }] })
    const chip = store.saveReport({ taskId: 't1', name: '早报', runAt: now, userId: 'u1', topic: '芯片', items: [{ title: '芯片新闻', summary: '', source: '', url: '' }] })
    // 同一用户、同一天、不同主题 → 不同 id，互不覆盖
    assert.notEqual(ai.id, chip.id)
    assert.equal(store.getReport(ai.id).topic, 'AI')
    assert.equal(store.getReport(chip.id).topic, '芯片')
    assert.equal(store.getReport(ai.id).items[0].title, 'AI新闻')
    assert.equal(store.getReport(chip.id).items[0].title, '芯片新闻')
    // 去重窗口按 (用户, 主题) 隔离：AI 的指纹不出现在芯片的窗口里，反之亦然
    assert.ok(store.recentFingerprints('t1', 7, { userId: 'u1', topic: 'AI' }).has(fingerprintOf('AI新闻')))
    assert.ok(!store.recentFingerprints('t1', 7, { userId: 'u1', topic: 'AI' }).has(fingerprintOf('芯片新闻')))
    assert.ok(store.recentFingerprints('t1', 7, { userId: 'u1', topic: '芯片' }).has(fingerprintOf('芯片新闻')))
    assert.ok(!store.recentFingerprints('t1', 7, { userId: 'u1', topic: '芯片' }).has(fingerprintOf('AI新闻')))
    assert.deepEqual(store.recentTitles('t1', 7, 20, { userId: 'u1', topic: 'AI' }), ['AI新闻'])
    // listReports 按主题过滤；不传 topic（默认 ''）既不匹配 AI 也不匹配芯片
    assert.deepEqual(store.listReports('t1', 5, { userId: 'u1', topic: 'AI' }).map((r) => r.id), [ai.id])
    assert.deepEqual(store.listReports('t1', 5, { userId: 'u1', topic: '芯片' }).map((r) => r.id), [chip.id])
    assert.equal(store.listReports('t1', 5, { userId: 'u1' }).length, 0)
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})

test('user-scoped reports are isolated from the shared version (ADR-0019)', () => {
  const { file, store } = setup()
  try {
    const now = Date.now()
    const shared = store.saveReport({ taskId: 't1', name: '早报', runAt: now, items: [{ title: '公共新闻', summary: '', source: '', url: '' }] })
    const mine = store.saveReport({ taskId: 't1', name: '早报', runAt: now, userId: 'u1', items: [{ title: '个性化新闻', summary: '', source: '', url: '' }] })
    // id 不同（用户维度隔离，互不覆盖）
    assert.notEqual(shared.id, mine.id)
    assert.equal(store.getReport(shared.id).userId, '')
    assert.equal(store.getReport(mine.id).userId, 'u1')
    // 去重窗口按用户维度隔离
    assert.ok(store.recentFingerprints('t1', 7).has(fingerprintOf('公共新闻')))
    assert.ok(!store.recentFingerprints('t1', 7).has(fingerprintOf('个性化新闻')))
    assert.ok(store.recentFingerprints('t1', 7, { userId: 'u1' }).has(fingerprintOf('个性化新闻')))
    assert.ok(!store.recentFingerprints('t1', 7, { userId: 'u1' }).has(fingerprintOf('公共新闻')))
    // listReports 按维度过滤
    assert.deepEqual(store.listReports('t1', 5).map((r) => r.id), [shared.id])
    assert.deepEqual(store.listReports('t1', 5, { userId: 'u1' }).map((r) => r.id), [mine.id])
  } finally {
    store.close(); fs.rmSync(file, { force: true })
  }
})
