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
 * `topics`（ADR-0019）：用户订阅的个性化主题，注入后要求优先选这些主题的新闻；
 * 无主题 = 公共版（范围默认）。 */
export function buildReportPrompt(task, recentTitles = [], { topics = [] } = {}) {
  const p = beijingParts(Date.now())
  const today = `今天是 ${beijingDateStr()}（周${WEEK[p.weekday]}）。`
  const lines = [
    `【定时任务「${task.name}」】${task.instruction}`,
    today,
    '资讯范围：以 AI、大模型、芯片、智能硬件等科技领域为主，兼顾当天全网重要的科技与商业新闻。只选择今天或昨天新发布的消息，优先有公众号原文或可信链接的条目。',
    '请挑选 5-8 条最有价值的。',
  ]
  if (topics.length) {
    lines.push(`用户订阅的个性化主题：${topics.join('、')}。请优先挑选这些主题相关的重要新闻；若当天该主题没有足够新消息，再补充相近领域。`)
  }
  if (recentTitles.length) {
    lines.push('近 7 天已报道过（请勿重复选择这些旧闻）：')
    lines.push(recentTitles.slice(0, 20).map((t) => `- ${t}`).join('\n'))
  }
  lines.push('请严格按照以下 JSON 结构输出，只输出 JSON，不要任何其他文字：')
  lines.push('{"focus":"今日关注点一句话","items":[{"title":"标题（≤60字）","summary":"一句话摘要（≤80字）","source":"来源公众号","url":"原文链接"}]}')
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
  const focus = normalizeFocus(typeof obj.focus === 'string' ? obj.focus : '')
  const cover = typeof obj.cover === 'string' ? obj.cover.trim() : ''
  return { ok: true, focus, cover, items }
}

/** focus 归一化：agent 偶发把 schema 提示词「今日关注点一句话」带进值（如
 * 「今日关注点：智谱…」），渲染层统一去掉该前缀，避免「今日关注：今日关注点：…」。 */
export function normalizeFocus(focus) {
  return String(focus || '').trim().replace(/^今日关注点[:：]?/, '').trim()
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

/** 微信推送的海报长图 HTML（ADR-0018 图文一体 + ADR-0019 主题个性化）。
 * 纯 CSS 科技风头图、无 AI 图、无裸 URL（完整版地址放推送短描述）。
 * `report.topics`（可选）：个性化主题徽标（如「AI · 芯片」）替代默认 tag；
 * 底部含订阅引导（想定制主题 → 回复「订阅 XX 主题」）。
 * 交给 poster-render 渲染成 PNG 后作为原生图片消息发送。 */
export function renderReportPoster(report) {
  const p = beijingParts(report.runAt)
  const date = `${p.year}.${String(p.month).padStart(2, '0')}.${String(p.day).padStart(2, '0')}`
  const weekday = WEEK[p.weekday]
  const topics = Array.isArray(report.topics) ? report.topics.filter(Boolean) : []
  const tag = topics.length ? topics.join(' · ') : 'AI · 科技 · 产业'
  const hint = topics.length
    ? `当前主题：${topics.join('、')} · 想调整？回复「订阅 新主题」`
    : `想定制感兴趣的主题？回复「订阅 AI 主题」，日报会更贴合你`
  const itemsHtml = report.items.map((it, i) => `
  <div class="item"><div class="no">${String(i + 1).padStart(2, '0')}</div><div class="body"><h3>${esc(it.title)}</h3>${it.summary ? `<p>${esc(it.summary)}</p>` : ''}<span class="src">${esc(it.source)}</span></div></div>`).join('')
  const focusHtml = report.focus ? `<div class="focus"><div class="t">今日关注</div><div class="c">${esc(report.focus)}</div></div>` : ''
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:750px;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif;background:#0d1020;color:#e8eaf2;-webkit-font-smoothing:antialiased}
.wrap{padding:40px 40px 38px;background:linear-gradient(180deg,#10152e 0%,#0d1020 100%)}
.hero{position:relative;overflow:hidden;height:340px;border-radius:26px;margin-bottom:36px;background:linear-gradient(140deg,#18204a 0%,#1c2b63 45%,#27357e 100%);box-shadow:0 24px 60px rgba(0,0,0,.45)}
.hero .grid{position:absolute;inset:0;background-image:repeating-linear-gradient(0deg,rgba(120,150,255,.14) 0 1px,transparent 1px 44px),repeating-linear-gradient(90deg,rgba(120,150,255,.14) 0 1px,transparent 1px 44px);mask-image:linear-gradient(180deg,rgba(0,0,0,.7),transparent 78%)}
.hero .glow{position:absolute;width:520px;height:520px;border-radius:50%;background:radial-gradient(circle,rgba(91,120,240,.55),transparent 65%);top:-180px;right:-120px;filter:blur(6px)}
.hero .glow2{position:absolute;width:380px;height:380px;border-radius:50%;background:radial-gradient(circle,rgba(64,214,255,.28),transparent 62%);bottom:-160px;left:-100px}
.hero .brand{position:absolute;top:30px;left:34px;display:flex;align-items:center;gap:12px;color:#aeb8f0;font-size:19px;font-weight:700;letter-spacing:1px}
.hero .brand .logo{width:44px;height:44px;border-radius:14px;background:linear-gradient(145deg,#5b78f0,#3350c4);display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:850;color:#fff;box-shadow:0 10px 22px rgba(59,91,219,.4)}
.hero .tag{position:absolute;right:34px;top:36px;font-size:16px;color:#7f8fd9;letter-spacing:3px;border:1px solid rgba(140,160,255,.35);padding:8px 16px;border-radius:30px}
.hero .title{position:absolute;left:34px;bottom:64px;font-size:56px;font-weight:850;letter-spacing:4px;color:#fff;text-shadow:0 6px 30px rgba(91,120,240,.55)}
.hero .date{position:absolute;left:36px;bottom:26px;font-size:19px;color:#93a3d8;letter-spacing:2px}
.hero .bar{position:absolute;left:34px;bottom:-1px;width:120px;height:5px;border-radius:4px;background:linear-gradient(90deg,#5b78f0,#40d6ff)}
.focus{background:linear-gradient(90deg,#242e5c,#2d3a72);border:1px solid #42539b;border-radius:20px;padding:24px 26px;margin-bottom:34px}
.focus .t{font-size:20px;font-weight:800;color:#8fa4ff;letter-spacing:2px;margin-bottom:10px}
.focus .t::before{content:"";display:inline-block;width:10px;height:10px;border-radius:3px;background:#40d6ff;margin-right:10px}
.focus .c{font-size:22px;line-height:1.6;color:#eef1ff;font-weight:600}
.item{display:flex;gap:22px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.09);border-radius:22px;padding:26px 26px 24px;margin-bottom:20px}
.item .no{flex:none;width:52px;height:52px;border-radius:16px;background:linear-gradient(145deg,#4a67e8,#3350c4);display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;color:#fff}
.item .body{min-width:0}
.item h3{font-size:24px;font-weight:750;line-height:1.45;color:#fff;margin-bottom:10px}
.item p{font-size:20px;line-height:1.6;color:#b9c0dc;margin-bottom:14px}
.item .src{display:inline-flex;align-items:center;gap:8px;font-size:17px;color:#8fa4ff;font-weight:650}
.item .src::before{content:"";width:14px;height:14px;border-radius:50%;background:#5b78f0}
.foot{margin-top:36px;padding-top:26px;border-top:1px solid rgba(255,255,255,.12);text-align:center}
.foot .hint{font-size:17px;color:#7c86b3;line-height:1.5}
.foot .guide{margin-top:10px;font-size:17px;color:#8fa4ff;font-weight:650}
</style></head><body><div class="wrap">
  <div class="hero"><div class="grid"></div><div class="glow"></div><div class="glow2"></div>
    <div class="brand"><span class="logo">早</span>微信个人助手 · ${esc(report.name)}</div>
    <div class="tag">${esc(tag)}</div>
    <div class="title">${esc(report.name)}</div>
    <div class="date">${date} · 周${weekday}</div>
    <div class="bar"></div>
  </div>
  ${focusHtml}
  ${itemsHtml}
  <div class="foot">
    <div class="hint">想深入了解某条？回复「第N条展开讲讲」</div>
    <div class="guide">${esc(hint)}</div>
  </div>
</div></body></html>`
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
