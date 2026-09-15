import { beijingParts, beijingDateStr } from './time.mjs'
import { fingerprintOf } from './report-store.mjs'

/** 日报生成/解析/渲染（DESIGN-daily-report.md）。纯函数，无 IO。
 *
 * 管道的四态：
 *   - buildReportPrompt   ：把任务指令包装成带日期/范围/去重清单/JSON schema 的生成 prompt
 *   - parseReportJson      ：从 agent 回复中抽取并校验结构化 JSON
 *   - dedupeItems          ：与近 7 天指纹比对，机械去重（保底 ≥3 条）
 *   - renderWeChatDigest   ：微信推送的精简摘要文本
 *   - renderReportPage     ：移动端优先的响应式公网页面（内联 CSS 零依赖）
 */

const WEEK = '日一二三四五六'
const DEDUP_WINDOW_DAYS = 7
const MAX_ITEMS = 12

/** 包装任务指令为生成 prompt：日期、范围约束、去重清单、严格 JSON schema。
 * `cover=true` 时追加封面图指令——用 image-studio 技能出图（效果优于裸生图），
 * 要求把工具返回的相对路径原样放进 JSON 的 cover 字段。 */
export function buildReportPrompt(task, recentTitles = [], { cover = false } = {}) {
  const p = beijingParts(Date.now())
  const today = `今天是 ${beijingDateStr()}（周${WEEK[p.weekday]}）。`
  const lines = [
    `【定时任务「${task.name}」】${task.instruction}`,
    today,
    '资讯范围：以 AI、大模型、芯片、智能硬件等科技领域为主，兼顾当天全网重要的科技与商业新闻。只选择今天或昨天新发布的消息，优先有公众号原文或可信链接的条目。',
    '请挑选 5-8 条最有价值的。',
  ]
  if (recentTitles.length) {
    lines.push('近 7 天已报道过（请勿重复选择这些旧闻）：')
    lines.push(recentTitles.slice(0, 20).map((t) => `- ${t}`).join('\n'))
  }
  if (cover) {
    lines.push('同时用 image-studio 技能生成一张封面图：调用 use_skill 加载 image-studio，再用 image_generate（generate 模式，size=16:9）生成现代科技感抽象封面，不要包含任何文字/字母/数字/logo。把工具返回的图片相对路径（形如 images/xxx.png）原样填入 JSON 的 cover 字段。不要调用 send_file——封面会由系统自动处理。')
  }
  lines.push('请严格按照以下 JSON 结构输出，只输出 JSON，不要任何其他文字：')
  lines.push('{"focus":"今日关注点一句话","cover":"images/xxx.png（封面图相对路径，无封面则为空字符串）","items":[{"title":"标题（≤60字）","summary":"一句话摘要（≤80字）","source":"来源公众号","url":"原文链接"}]}')
  return lines.join('\n')
}

/** 从 agent 回复中抽取首个完整 JSON 对象/数组并校验。
 * 返回 { ok:true, focus, cover, items } 或 { ok:false }（任意环节失败都走降级直推原文）。 */
export function parseReportJson(text) {
  const raw = String(text || '')
  const start = raw.indexOf('{')
  if (start === -1) return { ok: false }
  let end = -1
  let depth = 0
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end === -1) return { ok: false }
  let obj
  try { obj = JSON.parse(raw.slice(start, end + 1)) } catch { return { ok: false } }
  if (!obj || typeof obj !== 'object') return { ok: false }
  const list = Array.isArray(obj) ? obj : (Array.isArray(obj.items) ? obj.items : [])
  const items = []
  for (const it of list) {
    if (!it || typeof it !== 'object') continue
    const title = String(it.title || '').trim()
    const summary = String(it.summary || '').trim()
    const source = String(it.source || '').trim()
    const url = String(it.url || '').trim()
    if (!title || title.length > 120) continue // 无标题/超长 → 丢弃
    if (url && !/^https?:\/\//.test(url)) continue // 非法链接 → 丢弃
    items.push({ title: title.slice(0, 120), summary: summary.slice(0, 200), source, url })
    if (items.length >= MAX_ITEMS) break
  }
  if (!items.length) return { ok: false }
  const focus = typeof obj.focus === 'string' ? obj.focus.trim() : ''
  const cover = typeof obj.cover === 'string' ? obj.cover.trim() : ''
  return { ok: true, focus, cover, items }
}

/** 机械去重：指纹命中近 7 天集合的条目删除；删后不足 3 条则保留原样（不可空报）。 */
export function dedupeItems(items, fingerprints) {
  if (!fingerprints || fingerprints.size === 0) return { items, dropped: 0 }
  const kept = items.filter((it) => !fingerprints.has(fingerprintOf(it.title)))
  if (kept.length >= 3) return { items: kept, dropped: items.length - kept.length }
  return { items, dropped: 0 }
}

/** 微信推送的精简摘要文本。`greeting` 为空时不加问候行（由调度器按订阅者拼接）。 */
export function renderWeChatDigest({ report, reportUrl = '', greeting = '' }) {
  const p = beijingParts(report.runAt)
  const date = `${p.month}月${p.day}日`
  const lines = []
  if (greeting) lines.push(`${greeting}，今日早报已送达 👇`)
  lines.push(`📰 ${report.name} · ${date}`)
  report.items.forEach((it, i) => {
    lines.push(`${i + 1}. ${it.title}`)
    const src = it.source ? `（${it.source}${it.url ? `｜${it.url}` : ''}）` : (it.url ? `（${it.url}）` : '')
    if (it.summary) lines.push(`　${it.summary}${src}`)
  })
  if (report.focus) lines.push(`🎯 今日关注：${report.focus}`)
  if (reportUrl) lines.push(`📄 完整版：${reportUrl}`)
  lines.push('💬 想深入了解某条？回复我「第N条展开讲讲」即可。')
  return lines.join('\n')
}

/** 移动端优先的响应式公网页面（内联 CSS，风格对齐 ui-page）。 */
export function renderReportPage(report) {
  const p = beijingParts(report.runAt)
  const date = `${p.year}年${p.month}月${p.day}日`
  const coverHtml = report.coverPath ? `<img class="cover" src="cover" alt="封面">` : ''
  const itemsHtml = report.items.map((it, i) => `
        <article class="item">
          <div class="no">${String(i + 1).padStart(2, '0')}</div>
          <div class="ib">
            <h3>${esc(it.title)}</h3>
            ${it.summary ? `<p>${esc(it.summary)}</p>` : ''}
            <div class="meta">${esc(it.source)}${it.url ? ` · <a href="${esc(it.url)}" target="_blank" rel="noopener">阅读原文 ↗</a>` : ''}</div>
          </div>
        </article>`).join('')
  const focusHtml = report.focus ? `<div class="focus">🎯 今日关注：${esc(report.focus)}</div>` : ''
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(report.name)} · ${date}</title>
<style>
*{box-sizing:border-box}
:root{--ink:#101828;--muted:#667085;--line:#eaecf0;--brand:#3b5bdb;--brand-d:#2c4099;--bg:#f4f6fb;--card:#fff}
html,body{margin:0;padding:0}
body{font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);background:radial-gradient(900px 420px at 85% -10%,#dbe4ff 0,transparent 55%),var(--bg);min-height:100vh}
.wrap{max-width:720px;margin:0 auto;padding:36px 18px 56px}
.head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px}
.brand{display:flex;align-items:center;gap:10px;font-weight:760;font-size:16px}
.logo{width:34px;height:34px;border-radius:11px;background:linear-gradient(145deg,#5b78f0,#3350c4);display:grid;place-items:center;color:#fff;font-size:16px}
.date{color:var(--muted);font-size:13px;white-space:nowrap}
.cover{width:100%;border-radius:18px;display:block;margin:0 0 18px;box-shadow:0 14px 40px #1a2a5a14}
h1{font-size:26px;font-weight:800;letter-spacing:-.5px;margin:2px 0 6px}
.sub{color:var(--muted);font-size:14px;margin:0 0 20px}
.focus{background:#eef2ff;border:1px solid #d6e0ff;color:var(--brand-d);border-radius:14px;padding:13px 16px;font-size:14.5px;margin-bottom:20px;font-weight:600}
.item{display:flex;gap:14px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px;margin-bottom:12px;box-shadow:0 8px 24px #1a2a5a0a}
.no{flex:none;width:32px;height:32px;border-radius:10px;background:#eef2ff;color:var(--brand);display:grid;place-items:center;font-weight:800;font-size:14px}
.ib{min-width:0}
.ib h3{margin:0 0 6px;font-size:15.5px;font-weight:740;line-height:1.5}
.ib p{margin:0 0 8px;color:#475467;font-size:14px}
.meta{color:var(--muted);font-size:12.5px}
.meta a{color:var(--brand);text-decoration:none;font-weight:650}
.foot{color:#98a2b3;text-align:center;font-size:12.5px;margin-top:30px}
</style></head><body><div class="wrap">
<header class="head"><div class="brand"><span class="logo">📰</span>${esc(report.name)}</div><div class="date">${date}</div></header>
${coverHtml}
<h1>${esc(report.name)}</h1>
<p class="sub">每日精选 · ${date}</p>
${focusHtml}
${itemsHtml}
<div class="foot">由微信个人助手定时生成 · 内容来源见各条目原文链接</div>
</div></body></html>`
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
