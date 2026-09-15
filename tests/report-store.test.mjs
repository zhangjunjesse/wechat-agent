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
