import { beijingParts, beijingDateStr, beijingDateTimeStr } from './time.mjs'
import { parseSchedule } from './schedule.mjs'
import { GROUP_TAGS, GROUP_TAG_LABELS } from './group-profile-store.mjs'

/** 微信日报/周报的纯函数层（DESIGN-wechat-digest.md）：prompt 构造、JSON 解析、
 * 渲染。无 IO、无 LLM 调用——编排在 wechat-digest-runner.mjs，投递在
 * task-scheduler.mjs。分层动机同 daily-report.mjs（那套已被证明好测）。
 *
 * 产品定位（决定了这里每一段 prompt 的措辞）：**不是群摘要**，是"替用户读完他
 * 读不完的群，只捞和他有关、他会在意的东西"。所以 map 阶段按群性质用不同侧重，
 * reduce 阶段注入用户画像与偏好，输出固定三节：
 *   action_items  需要你行动（含隐性待办）
 *   work_updates  你该知道
 *   fun           值得一看（≤3 条）
 * 空节省略；三节全空是**正常结果**，不是失败。 */

const WEEK = '日一二三四五六'

/** 三节的顺序即渲染顺序；解析时也只认这三个 key。 */
export const DIGEST_SECTIONS = ['action_items', 'work_updates', 'fun']

export const SECTION_LABELS = {
  action_items: '需要你行动',
  work_updates: '你该知道',
  fun: '值得一看',
}

/** `fun` 是"顺手看看"，多了就变成噪音，反而稀释前两节。硬上限，解析时截断。 */
export const MAX_FUN_ITEMS = 3
/** 单节最多条数（action_items/work_updates）——再多用户就不看了。 */
export const MAX_SECTION_ITEMS = 8
/** 一次 map 送进 prompt 的单群消息上限（token 护栏）。 */
export const MAX_MESSAGES_PER_CHAT = 120
/** 单条消息正文截断长度（长链接/长转发不该吃掉整个预算）。 */
export const MAX_CONTENT_CHARS = 200
/** 一个用户一期最多扫多少个群（超出部分按活跃度截断，并**如实告知**）。 */
export const MAX_CHATS_PER_USER = 30
/** 自动打标时每群取的样本条数（比 map 小得多——判性质不需要读全文）。 */
export const TAG_SAMPLE_MESSAGES = 30

/** 没有画像（自动打标失败/还没跑）时的兜底性质。刻意选 `friends` 而不是 `work`：
 * 猜成工作群会把闲聊当决策捞上来（假阳性，用户要花注意力去否定它），猜成朋友群
 * 最多是少捞一点（假阴性，用户无感）。宁可漏，不可吵。 */
export const DEFAULT_TAG = 'friends'

/** 每种群性质"该捞什么"。这是本功能真正的产品逻辑所在——不是摘要规则，是
 * "什么东西对这个用户来说值得从这个群里被拎出来"。 */
export const TAG_FOCUS = {
  work: '@我或点名我的消息；做出的决策与结论；deadline/排期/责任人；共享的文件与链接；我不在场时发生的关键讨论（我需要补上下文的）。闲聊、表情接龙、纯附和一律不要。',
  family: '健康与就医安排；出行与接送；生日/节日/聚会；需要我出钱出力或到场的事；老人小孩相关的嘱托。日常问候和转发养生文不要。',
  friends: '高热度话题（回复密集、多人参与的那几条）；直接叫到我的邀约与约定；与我的兴趣画像重合的内容。刷屏、红包、单条无人回应的转发不要。',
  hobby: '高热度话题与有信息量的干货（教程/资源/评测/避坑）；与我的兴趣画像重合的内容；线下活动召集。灌水和重复转发不要。',
  notice: '结构化通知：时间、地点、对象、要交什么、截止到几号——按"待办候选"的形式抽出来。没有行动要求的纯公告不要。',
  deal: '与我的订单/服务/维修/物业相关的进展与要我配合的动作；报价与变更。群发广告不要。',
  dead: '',
}

/** 日报 vs 周报的取数窗口（天）。直接由调度表达式推导，不另外加配置字段——
 * 配置里再写一个"周期=7天"就会和 schedule 出现两个真相源，改一个忘一个。 */
export function digestWindowDays(schedule) {
  try {
    return parseSchedule(schedule).type === 'weekly' ? 7 : 1
  } catch {
    return 1
  }
}

/** 窗口的人类可读说明（进 prompt，让模型知道自己在看多长的跨度）。 */
export function windowLabel(windowDays) {
  return windowDays >= 7 ? '过去 7 天' : '今天'
}

// ---------------- ① 群自动打标 ----------------

/** 批量群打标 prompt。`samples`: [{ chatWxid, chatName, lines: string[] }]。
 * 批量（不是一群一次调用）是刻意的：群性质靠**互相对比**最好判——一次看全，
 * "哪个是工作群哪个是通知群"比孤立看一个群准得多，也省 N-1 次调用。 */
export function buildGroupTagPrompt(samples = []) {
  const blocks = samples.map((s, i) => {
    const lines = (s.lines || []).slice(0, TAG_SAMPLE_MESSAGES).join('\n')
    return `### 群 ${i + 1}\nid: ${s.chatWxid}\n群名: ${s.chatName || '(无群名)'}\n最近消息样本:\n${lines || '(近 7 天无消息)'}`
  }).join('\n\n')
  return [
    '你在给一个人的微信群做性质分类，用于后续"只挑他会在意的内容"。请只依据群名和消息样本判断，不要臆测。',
    '',
    '可选标签（必须从中选一个）：',
    ...GROUP_TAGS.map((t) => `- ${t}：${tagHint(t)}`),
    '',
    blocks,
    '',
    '请严格按以下 JSON 输出，只输出 JSON，不要任何其他文字：',
    '{"groups":[{"chatWxid":"照抄上面的 id","tag":"标签","confidence":0.0~1.0}]}',
    'confidence 是你对这个判断的把握程度，拿不准就给低分（低于 0.5 的会被当作暂定，用户纠正后永久生效）。',
  ].join('\n')
}

function tagHint(tag) {
  return {
    work: '同事/项目/客户群，讨论工作事项',
    family: '家人亲戚群',
    friends: '朋友、同学、老乡等社交群',
    hobby: '围绕某个兴趣爱好的群（运动/游戏/读书/摄影等）',
    notice: '单向通知群（学校/小区/公司公告，少有讨论）',
    deal: '交易或服务群（商家/客服/维修/中介/拼单）',
    dead: '基本没人说话的死群，或纯广告群',
  }[tag] || ''
}

/** 解析打标结果 → [{ chatWxid, tag, confidence }]。未知标签/缺 id 的条目丢弃
 * （宁可少打一个标走 DEFAULT_TAG，也不要把垃圾写进画像表）。 */
export function parseGroupTagJson(text) {
  const obj = extractJson(text)
  if (!obj) return { ok: false, groups: [] }
  const list = Array.isArray(obj) ? obj : (Array.isArray(obj.groups) ? obj.groups : [])
  const groups = []
  for (const g of list) {
    if (!g || typeof g !== 'object') continue
    const chatWxid = String(g.chatWxid || g.chat_wxid || g.id || '').trim()
    const tag = String(g.tag || '').trim()
    if (!chatWxid || !GROUP_TAGS.includes(tag)) continue
    let confidence = Number(g.confidence)
    if (!Number.isFinite(confidence)) confidence = 0
    groups.push({ chatWxid, tag, confidence: Math.max(0, Math.min(1, confidence)) })
  }
  return { ok: groups.length > 0, groups }
}

// ---------------- ② map：逐群抽候选 ----------------

/** 把 WechatLogStore 的 messages 渲染成 prompt 里的消息行（带时间与发言人，
 * 因为候选条目**必须能溯源**——"来自 XX 群 · 时间"是这份日报可信度的全部）。 */
export function renderMessageLines(messages = []) {
  return messages.slice(-MAX_MESSAGES_PER_CHAT).map((m) => {
    const body = String(m.content || '').slice(0, MAX_CONTENT_CHARS)
    return `[${beijingDateTimeStr(m.tsMs)}][${m.sender || '未知'}] ${body}`
  })
}

/** 单群候选抽取 prompt。`tag` 决定侧重（TAG_FOCUS），`nickname` 让模型知道
 * "我"是谁（@我、点名我要认得出来）。 */
export function buildDigestMapPrompt({ chatName, tag = DEFAULT_TAG, nickname = '', messages = [], windowDays = 1 } = {}) {
  const focus = TAG_FOCUS[tag] || TAG_FOCUS[DEFAULT_TAG]
  const lines = renderMessageLines(messages)
  return [
    `你在替一个人（微信昵称：${nickname || '未知'}）读他来不及看的微信群，只挑**和他有关、他会在意**的内容。这不是群聊摘要，不要复述群里发生了什么。`,
    `群名：${chatName || '(无群名)'}｜群性质：${GROUP_TAG_LABELS[tag] || tag}｜范围：${windowLabel(windowDays)}`,
    `这个群要重点看的：${focus}`,
    '',
    '判断"他会在意"的标准：他不看就会错过某件事、或会耽误别人。凑不满不要硬凑——没有就返回空数组，空结果是完全正常的。',
    '',
    '消息记录：',
    lines.length ? lines.join('\n') : '(本时段无消息)',
    '',
    '请严格按以下 JSON 输出，只输出 JSON，不要任何其他文字：',
    '{"candidates":[{"section":"action_items|work_updates|fun","title":"一句话说清是什么（≤40字）","detail":"补充说明，含关键的人/时间/数字（≤80字）","sender":"相关发言人","at":"YYYY-MM-DD HH:mm（该消息的时间，照抄上面的时间戳）"}]}',
    'section 含义：action_items = 需要他做点什么（包括没人明说但实际上得他去办的隐性待办）；work_updates = 他该知道但不用动手；fun = 值得一看的轻松内容。',
  ].join('\n')
}

/** 解析单群候选。`chatName` 由调用方回填（不信模型自报的群名——溯源信息必须
 * 来自我们自己查库的那一侧，否则模型一旦串群，用户就被指到错误的出处）。 */
export function parseDigestCandidates(text, { chatName = '' } = {}) {
  const obj = extractJson(text)
  if (!obj) return { ok: false, candidates: [] }
  const list = Array.isArray(obj) ? obj : (Array.isArray(obj.candidates) ? obj.candidates : [])
  const candidates = []
  for (const c of list) {
    if (!c || typeof c !== 'object') continue
    const title = String(c.title || '').trim()
    if (!title) continue
    const section = DIGEST_SECTIONS.includes(c.section) ? c.section : 'work_updates'
    candidates.push({
      section,
      title: title.slice(0, 80),
      detail: String(c.detail || '').trim().slice(0, 200),
      sender: String(c.sender || '').trim().slice(0, 40),
      at: String(c.at || '').trim().slice(0, 20),
      chatName: String(chatName || ''),
    })
    if (candidates.length >= MAX_SECTION_ITEMS * 3) break
  }
  return { ok: true, candidates }
}

// ---------------- ③ reduce：合成三节 ----------------

/** 合成 prompt。注入用户画像（memory_profiles）与 preference 记忆，是"他会在意
 * 什么"的唯一真实依据；`previousTitles`（周报）用于趋势对比。 */
export function buildDigestReducePrompt({ taskName = '微信日报', instruction = '', candidates = [], profileContent = '', preferences = [], previousTitles = [], nickname = '', windowDays = 1, now = Date.now() } = {}) {
  const p = beijingParts(now)
  const weekly = windowDays >= 7
  const lines = [
    `【定时任务「${taskName}」】${instruction}`,
    `今天是 ${beijingDateStr(now)}（周${WEEK[p.weekday]}）。本期覆盖${windowLabel(windowDays)}。`,
    `对象：${nickname || '这位用户'}。你在替他把多个群里的候选条目合并成一份他愿意读完的简报。`,
    '',
  ]
  if (profileContent) lines.push(`他的画像（来自长期记忆，用于判断什么值得给他）：\n${profileContent}`, '')
  if (preferences.length) {
    lines.push('他明确表达过的偏好（**必须遵守**，包括他说过"不想再看到"的东西）：')
    lines.push(preferences.map((t) => `- ${t}`).join('\n'), '')
  }
  if (weekly && previousTitles.length) {
    lines.push('上一期已经报过的条目（用于做趋势对比：哪些关切在反复出现、哪些话题热度起落；不要原样重复它们）：')
    lines.push(previousTitles.slice(0, 30).map((t) => `- ${t}`).join('\n'), '')
  }
  lines.push('各群抽出的候选条目（格式：[群名][时间][发言人] 标题 — 补充）：')
  lines.push(candidates.length
    ? candidates.map((c) => `[${c.chatName}][${c.at || '时间未知'}][${c.sender || '未知'}] ${c.title}${c.detail ? ` — ${c.detail}` : ''}`).join('\n')
    : '(本期没有任何候选)')
  lines.push('')
  lines.push('合并规则：')
  lines.push('- 同一件事在多个群出现 → 合成一条，source 写最能说明出处的那个群。')
  lines.push('- 与他的偏好冲突、或他明确说过不想看的 → 直接丢掉，不要"保留但降权"。')
  lines.push(`- action_items 与 work_updates 各最多 ${MAX_SECTION_ITEMS} 条，fun 最多 ${MAX_FUN_ITEMS} 条。`)
  lines.push('- **凑不满就少给，一条都没有就给空数组**。这份简报的价值在于"打开就有用"，宁可今天只有一条，也不要用无关内容填满。')
  if (weekly) lines.push('- 周报还要在 focus 里点出这一周反复出现的关切、或与上周相比明显的变化。')
  lines.push('')
  lines.push('请严格按以下 JSON 输出，只输出 JSON，不要任何其他文字：')
  lines.push('{"focus":"一句话总结本期（没有值得说的就给空字符串）","action_items":[{"title":"≤40字","summary":"≤80字","source":"群名","at":"YYYY-MM-DD HH:mm"}],"work_updates":[...同结构...],"fun":[...同结构...]}')
  return lines.join('\n')
}

/** 解析三节 JSON。`ok:false` 只代表**解析失败**（走降级）；三节都空但 JSON 合法
 * 是 `ok:true, empty:true`——"今天各群平静"是正常结果，不能当成生成失败去重试，
 * 否则每个安静的日子都会触发一轮无谓的重试和一条"生成失败"话术。 */
export function parseDigestJson(text) {
  const obj = extractJson(text)
  if (!obj || Array.isArray(obj)) return { ok: false }
  const sections = {}
  let total = 0
  for (const key of DIGEST_SECTIONS) {
    const cap = key === 'fun' ? MAX_FUN_ITEMS : MAX_SECTION_ITEMS
    const list = Array.isArray(obj[key]) ? obj[key] : []
    const items = []
    for (const it of list) {
      if (!it || typeof it !== 'object') continue
      const title = String(it.title || '').trim()
      if (!title) continue
      items.push({
        title: title.slice(0, 80),
        summary: String(it.summary || it.detail || '').trim().slice(0, 200),
        source: String(it.source || it.chatName || '').trim().slice(0, 40),
        at: String(it.at || '').trim().slice(0, 20),
      })
      if (items.length >= cap) break
    }
    if (items.length) sections[key] = items
    total += items.length
  }
  return { ok: true, empty: total === 0, focus: String(obj.focus || '').trim().slice(0, 120), sections, count: total }
}

/** 三节 → ReportStore 的 items 形状（含 `section` 列与"来自 XX 群 · 时间"溯源）。
 * 顺序固定按 DIGEST_SECTIONS，渲染层据此分组，不需要再排序。 */
export function digestItemsOf(sections = {}) {
  const items = []
  for (const key of DIGEST_SECTIONS) {
    for (const it of sections[key] || []) {
      items.push({
        title: it.title,
        summary: it.summary || '',
        source: sourceLabel(it),
        url: '',
        section: key,
      })
    }
  }
  return items
}

/** 溯源串："来自 XX 群 · 09-16 14:30"。缺群名/缺时间时降级但不编造。 */
export function sourceLabel({ source = '', at = '' } = {}) {
  const where = source ? `来自 ${source}` : ''
  const when = shortTime(at)
  return [where, when].filter(Boolean).join(' · ')
}

function shortTime(at) {
  const m = String(at || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/)
  if (!m) return ''
  return m[4] != null ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : `${m[2]}-${m[3]}`
}

/** 把 report.items（带 section）分回三节，供渲染用。 */
export function groupItemsBySection(items = []) {
  const out = {}
  for (const key of DIGEST_SECTIONS) {
    const list = items.filter((it) => (it.section || 'work_updates') === key)
    if (list.length) out[key] = list
  }
  return out
}

// ---------------- ④ 渲染 ----------------

/** 三节全空时的一句话短文本（不发海报）。 */
export function renderQuietText(taskName, { windowDays = 1 } = {}) {
  return windowDays >= 7
    ? `📭 ${taskName}：这一周各群都挺平静，没有需要你处理或知道的事。`
    : `📭 ${taskName}：今天各群平静，没有需要你处理或知道的事。`
}

/** 海报配套的短描述。末尾的"哪条没用？直接回我"是反馈闭环的入口——用户一句
 * "以后别给我推 XX"会被主 agent 写成 preference 记忆，下一期 reduce prompt
 * 就读得到（见 DESIGN-wechat-digest.md §反馈闭环）。 */
export function renderDigestPushText(report, { reportUrl = '', resend = false } = {}) {
  const counts = DIGEST_SECTIONS
    .map((k) => ({ k, n: (report.items || []).filter((it) => (it.section || 'work_updates') === k).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${SECTION_LABELS[x.k]} ${x.n} 条`)
    .join(' · ')
  const head = resend ? `🔁 ${report.name}（补发）` : `📬 ${report.name} 已送达`
  const lines = [head]
  if (counts) lines.push(counts)
  if (reportUrl) lines.push('想看每条的出处和上下文：', reportUrl)
  lines.push('哪条没用？直接回我（比如「以后别给我推 XX 群的闲聊」），下次就不给你了。')
  return lines.join('\n')
}

/** 微信推送的海报长图 HTML（复用 poster-render 的 HTML→PNG 通道）。
 * 视觉上刻意与每日资讯（renderReportPoster 的深色科技风）**区分开**：这份是
 * 私人简报，用浅色纸感 + 分节卡片，一眼能看出"这是我的群，不是新闻"。 */
export function renderDigestPoster(report) {
  const p = beijingParts(report.runAt)
  const date = `${p.year}.${String(p.month).padStart(2, '0')}.${String(p.day).padStart(2, '0')}`
  const sections = groupItemsBySection(report.items || [])
  const body = DIGEST_SECTIONS.filter((k) => sections[k]).map((k) => `
  <section class="sec sec-${k}">
    <div class="sec-h"><span class="dot"></span>${esc(SECTION_LABELS[k])}<span class="n">${sections[k].length}</span></div>
    ${sections[k].map((it) => `
    <div class="item"><h3>${esc(it.title)}</h3>${it.summary ? `<p>${esc(it.summary)}</p>` : ''}${it.source ? `<span class="src">${esc(it.source)}</span>` : ''}</div>`).join('')}
  </section>`).join('')
  const focusHtml = report.focus ? `<div class="focus">${esc(report.focus)}</div>` : ''
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:750px;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif;background:#f6f4ef;color:#2b2b2b;-webkit-font-smoothing:antialiased}
.wrap{padding:40px 40px 38px}
.hero{border-radius:24px;padding:38px 34px 32px;margin-bottom:30px;background:linear-gradient(135deg,#fff 0%,#fdf6ec 100%);border:1px solid #ece5d8;box-shadow:0 14px 36px rgba(120,100,60,.10)}
.hero .brand{display:flex;align-items:center;gap:12px;font-size:19px;color:#a08a5e;font-weight:700;letter-spacing:1px;margin-bottom:22px}
.hero .brand .logo{width:44px;height:44px;border-radius:14px;background:linear-gradient(145deg,#e8b94a,#d59a2c);display:flex;align-items:center;justify-content:center;font-size:21px;color:#fff}
.hero .title{font-size:50px;font-weight:850;letter-spacing:3px;color:#1f1f1f}
.hero .date{margin-top:12px;font-size:19px;color:#9a8f7d;letter-spacing:2px}
.focus{margin-top:22px;padding:18px 20px;border-radius:16px;background:#fff8e8;border:1px solid #f0dfb8;font-size:21px;line-height:1.6;color:#6b5626;font-weight:600}
.sec{margin-bottom:30px}
.sec-h{display:flex;align-items:center;gap:12px;font-size:24px;font-weight:800;color:#1f1f1f;margin-bottom:16px}
.sec-h .dot{width:14px;height:14px;border-radius:5px;background:#d59a2c}
.sec-action_items .dot{background:#e2574c}
.sec-work_updates .dot{background:#3b7bd6}
.sec-fun .dot{background:#4aab7a}
.sec-h .n{font-size:17px;font-weight:700;color:#fff;background:#c9b48a;border-radius:20px;padding:2px 12px;margin-left:2px}
.item{background:#fff;border:1px solid #ece5d8;border-radius:18px;padding:22px 24px 20px;margin-bottom:14px;box-shadow:0 6px 18px rgba(120,100,60,.06)}
.item h3{font-size:23px;font-weight:750;line-height:1.5;color:#1f1f1f;margin-bottom:8px}
.item p{font-size:19px;line-height:1.65;color:#5b5b5b;margin-bottom:12px}
.item .src{display:inline-block;font-size:16px;color:#a08a5e;background:#faf5ea;border:1px solid #efe6d2;border-radius:16px;padding:4px 12px;font-weight:650}
.foot{margin-top:30px;padding-top:24px;border-top:1px solid #e4dccc;text-align:center}
.foot .hint{font-size:17px;color:#9a8f7d;line-height:1.6}
</style></head><body><div class="wrap">
  <div class="hero">
    <div class="brand"><span class="logo">微</span>微信个人助手</div>
    <div class="title">${esc(report.name)}</div>
    <div class="date">${date} · 周${WEEK[p.weekday]}</div>
    ${focusHtml}
  </div>
  ${body}
  <div class="foot"><div class="hint">只挑和你有关的，没挑对就直接回我一句，下次改</div></div>
</div></body></html>`
}

/** 公网 H5 页（app.mjs 按 report.kind 路由到这里）。与每日资讯的页面同一套
 * 排版骨架、不同配色与分节结构；每条都带"来自 XX 群 · 时间"溯源。 */
export function renderDigestPage(report) {
  const p = beijingParts(report.runAt)
  const date = `${p.year}年${p.month}月${p.day}日`
  const sections = groupItemsBySection(report.items || [])
  const body = DIGEST_SECTIONS.filter((k) => sections[k]).map((k) => `
      <section class="sec sec-${k}">
        <h2><span class="dot"></span>${esc(SECTION_LABELS[k])}<span class="n">${sections[k].length}</span></h2>
        ${sections[k].map((it) => `
        <article class="item">
          <h3>${esc(it.title)}</h3>
          ${it.summary ? `<p>${esc(it.summary)}</p>` : ''}
          ${it.source ? `<div class="meta">${esc(it.source)}</div>` : ''}
        </article>`).join('')}
      </section>`).join('')
  const empty = body ? '' : '<p class="empty">本期各群平静，没有需要你处理或知道的事。</p>'
  const focusHtml = report.focus ? `<div class="focus">${esc(report.focus)}</div>` : ''
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(report.name)} · ${date}</title>
<style>
*{box-sizing:border-box}
:root{--ink:#2b2b2b;--muted:#9a8f7d;--line:#ece5d8;--gold:#a08a5e;--bg:#f6f4ef;--card:#fff}
html,body{margin:0;padding:0}
body{font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);background:var(--bg);min-height:100vh}
.wrap{max-width:720px;margin:0 auto;padding:36px 18px 56px}
.head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px}
.brand{display:flex;align-items:center;gap:10px;font-weight:760;font-size:16px}
.logo{width:34px;height:34px;border-radius:11px;background:linear-gradient(145deg,#e8b94a,#d59a2c);display:grid;place-items:center;color:#fff;font-size:16px}
.date{color:var(--muted);font-size:13px;white-space:nowrap}
h1{font-size:26px;font-weight:800;letter-spacing:-.5px;margin:2px 0 6px}
.sub{color:var(--muted);font-size:14px;margin:0 0 20px}
.focus{background:#fff8e8;border:1px solid #f0dfb8;color:#6b5626;border-radius:14px;padding:13px 16px;font-size:14.5px;margin-bottom:22px;font-weight:600}
.sec{margin-bottom:26px}
.sec h2{display:flex;align-items:center;gap:9px;font-size:17px;font-weight:800;margin:0 0 12px}
.sec h2 .dot{width:10px;height:10px;border-radius:4px;background:#d59a2c}
.sec-action_items h2 .dot{background:#e2574c}
.sec-work_updates h2 .dot{background:#3b7bd6}
.sec-fun h2 .dot{background:#4aab7a}
.sec h2 .n{font-size:12px;font-weight:700;color:#fff;background:#c9b48a;border-radius:20px;padding:1px 9px}
.item{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px;margin-bottom:11px;box-shadow:0 6px 18px rgba(120,100,60,.05)}
.item h3{margin:0 0 6px;font-size:15.5px;font-weight:740;line-height:1.5}
.item p{margin:0 0 9px;color:#5b5b5b;font-size:14px}
.meta{color:var(--gold);font-size:12.5px;font-weight:650}
.empty{color:var(--muted);text-align:center;padding:40px 0}
.foot{color:#b3aa99;text-align:center;font-size:12.5px;margin-top:30px}
</style></head><body><div class="wrap">
<header class="head"><div class="brand"><span class="logo">微</span>${esc(report.name)}</div><div class="date">${date}</div></header>
<h1>${esc(report.name)}</h1>
<p class="sub">只挑和你有关的 · ${date}</p>
${focusHtml}
${body}${empty}
<div class="foot">由微信个人助手定时生成 · 每条都标注了出处群与时间</div>
</div></body></html>`
}

// ---------------- 工具 ----------------

/** 抽取回复里第一个完整 JSON 对象/数组并 parse。与 daily-report.parseReportJson
 * 同一套括号配平做法（模型经常在 JSON 前后夹解释性文字）。 */
function extractJson(text) {
  const raw = String(text || '')
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const start = raw.indexOf(open)
    if (start === -1) continue
    let depth = 0
    for (let i = start; i < raw.length; i++) {
      if (raw[i] === open) depth++
      else if (raw[i] === close) {
        depth--
        if (depth === 0) {
          try { return JSON.parse(raw.slice(start, i + 1)) } catch { break }
        }
      }
    }
  }
  return null
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
