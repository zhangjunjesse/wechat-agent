import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { BindingService } from './services/binding-service.mjs'
import { MessageRouter } from './services/message-router.mjs'
import { PollingService } from './services/polling-service.mjs'
import { VerificationService } from './services/verification-service.mjs'
import { resolveUserPath } from './services/user-sandbox.mjs'
import { renderPage } from './ui-page.mjs'
import { renderReportPage } from './services/daily-report.mjs'
import { renderDigestPage } from './services/wechat-digest.mjs'

/** 注册核验成功后自动订阅的公共任务（ADR-0031，2026-09-17 变更：从只有「每日
 * 资讯」扩到「所有人默认订阅微信日报和微信周报」，产品需求直接指示）。名字必须
 * 与 `deploy/global-tasks.json` 里的 `name` 完全一致；对不上时 `subscribe` 抛
 * 「公共任务「X」不存在」，由 `buildOnVerified` 吞掉并上报，不拦核验本身。
 *
 * 这个列表只对**新用户**（核验通过那一刻）生效——它是"在某个一次性时刻施加
 * 一次"的默认值，不是"系统持续确保所有人都订阅"的强制状态。**存量**用户由
 * `scripts/backfill-default-subscriptions.mjs` 一次性回填，且该脚本刻意不挂在
 * 服务启动路径上：任何形式的"每次启动都把已核验用户订阅补齐"，都会让用户的
 * 退订在下次重启后被悄悄撤销——退订功能等于永久失效。默认订阅之后，用户自己
 * 的订阅/退订状态就是唯一权威，系统不会再覆盖它。详见 ADR-0031 2026-09-17 变更
 * 记录。 */
export const DEFAULT_SUBSCRIPTIONS = ['每日资讯', '微信日报', '微信周报']

export function createApp({ provider, agent = { async respond({ text }) { return { text: `Echo: ${text}` } } }, clock, pollIntervalMs, store, verifier, profileStore, downloadTokens, userFilesRoot = process.env.USER_FILES_ROOT || 'data/user-files', contextTokens = null, reportStore = null, lark = null, taskStore = null, defaultSubscriptions = DEFAULT_SUBSCRIPTIONS, onVerifiedError = (error, name) => console.warn(`default subscription failed${name ? ` (${name})` : ''}: ${error?.message || error}`) }) {
  const owned = []
  let polling
  const lastPollLog = new Map() // providerBotId -> { at, error }
  const bindings = new BindingService({ provider, clock, store, onBound: async (binding) => { if (!binding.providerBotId) return; if (binding.providerSession) await provider.restoreSession?.(binding.providerSession); polling?.start(binding.providerBotId) } })
  const router = new MessageRouter({ provider, agent, bindings: owned, allowPeerUsers: true, requireVerified: process.env.NODE_ENV === 'production', contextProvider: async (key) => (await profileStore?.get(key)) || (await profileStore?.getByIlink?.(key)), contextTokens })
  // 核验通过 → 默认订阅（ADR-0031）。VerificationService 的 onVerified 钩子此前
  // 一直是 null（存在但没人接），这里是它的第一个使用者。
  const verification = verifier
    ? new VerificationService({ verifier, store: profileStore, onVerified: buildOnVerified({ taskStore, profileStore, provider, contextTokens, defaultSubscriptions, onError: onVerifiedError }) })
    : null
  // Polling failures (e.g. iLink session timeout -14) mark the binding as
  // expired so the UI can tell the user to re-bind; the error is logged once
  // per distinct message, not once per 1s poll tick.
  function onPollError(error, providerBotId) {
    const msg = error?.message || String(error)
    const live = owned.find((x) => x.providerBotId === providerBotId)
    if (live) {
      live.sessionExpired = true
      live.lastPollError = msg
    }
    const prev = lastPollLog.get(providerBotId)
    if (!prev || prev.error !== msg) {
      console.warn(`[poll:${providerBotId}] ${msg}`)
      lastPollLog.set(providerBotId, { at: Date.now(), error: msg })
    }
  }
  polling = new PollingService({ provider, router, intervalMs: pollIntervalMs, onError: onPollError })
  void bindings.restoreAndStart().then((records) => records.forEach(bind)).catch(() => {})
  function bind(binding) { const index = owned.findIndex((x) => x.id === binding.id); if (index >= 0) owned[index] = binding; else owned.push(binding) }

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true })
      if (req.method === 'GET' && url.pathname === '/') return html(res, 200, renderPage())
      if (req.method === 'GET' && (url.pathname === '/assistant-qr.jpg' || url.pathname === '/wechat-agent/assistant-qr.jpg')) return binary(res, 200, 'image/jpeg', await fs.readFile(process.env.ASSISTANT_QR_FILE || path.resolve('assistant-qr.jpg')))
      const fileMatch = url.pathname.match(/^(?:\/wechat-agent)?\/files\/([^/]+)$/)
      if (req.method === 'GET' && fileMatch) {
        // Files write_file/run_code produce live in a per-user sandbox with no
        // browsing UI and no way to attach an auth header from a WeChat-tapped
        // link (see ADR-0008) — the token itself, not a session, is the auth.
        if (!downloadTokens) return json(res, 503, { error: 'downloads_not_configured' })
        const entry = downloadTokens.resolve(fileMatch[1])
        if (!entry) return json(res, 404, { error: 'not_found_or_expired' })
        let full
        try { full = resolveUserPath(userFilesRoot, entry.userId, entry.relPath) } catch { return json(res, 404, { error: 'not_found_or_expired' }) }
        let data
        try { data = await fs.readFile(full) } catch { return json(res, 404, { error: 'not_found_or_expired' }) }
        const name = path.basename(entry.relPath)
        res.writeHead(200, { 'content-type': guessContentType(name), 'content-length': data.length, 'content-disposition': `attachment; filename="${encodeURIComponent(name)}"`, 'cache-control': 'private, no-store' })
        return res.end(data)
      }
      if (req.method === 'GET' && url.pathname === '/api/qr') { const payload = url.searchParams.get('payload') || ''; if (!payload || payload.length > 2000) return json(res, 400, { error: 'invalid_qr_payload' }); const { toDataURL } = await import('qrcode'); return json(res, 200, { dataUrl: await toDataURL(payload, { width: 320, margin: 2 }) }) }
      if (req.method === 'POST' && url.pathname === '/api/bindings') { await readJson(req); const binding = await bindings.start(assertHeader(req, 'x-user-id')); bind(binding); return json(res, 201, binding) }
      if (req.method === 'POST' && url.pathname === '/api/profile-verifications') { const body = await readJson(req); if (!verification) return json(res, 503, { error: 'verification_not_configured' }); return json(res, 201, verification.create({ userId: assertHeader(req, 'x-user-id'), ilinkUserId: body.ilinkUserId || '' })) }
      const verifyMatch = url.pathname.match(/^\/api\/profile-verifications\/([^/]+)$/)
      if (req.method === 'GET' && verifyMatch) { if (!verification) return json(res, 503, { error: 'verification_not_configured' }); return json(res, 200, await verification.check({ userId: assertHeader(req, 'x-user-id'), id: verifyMatch[1] })) }
      // 报告公网页（DESIGN-daily-report.md）：GET /reports/<id>、/cover、/poster，
      // 兼容反向代理子路径前缀（同 files 路由）。
      const reportCoverMatch = url.pathname.match(/^(?:\/wechat-agent)?\/reports\/([^/]+)\/cover$/)
      if (req.method === 'GET' && reportCoverMatch) {
        const id = safeDecode(reportCoverMatch[1])
        const report = reportStore?.getReport(id)
        if (!report?.coverPath) return json(res, 404, { error: 'cover_not_found' })
        let data
        try { data = await fs.readFile(report.coverPath) } catch { return json(res, 404, { error: 'cover_not_found' }) }
        const ext = path.extname(report.coverPath).toLowerCase()
        const type = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'application/octet-stream'
        res.writeHead(200, { 'content-type': type, 'content-length': data.length, 'cache-control': 'public, max-age=600' })
        return res.end(data)
      }
      const reportPosterMatch = url.pathname.match(/^(?:\/wechat-agent)?\/reports\/([^/]+)\/poster$/)
      if (req.method === 'GET' && reportPosterMatch) {
        const id = safeDecode(reportPosterMatch[1])
        const report = reportStore?.getReport(id)
        if (!report?.posterPath) return json(res, 404, { error: 'poster_not_found' })
        let data
        try { data = await fs.readFile(report.posterPath) } catch { return json(res, 404, { error: 'poster_not_found' }) }
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': data.length, 'cache-control': 'public, max-age=600' })
        return res.end(data)
      }
      const reportMatch = url.pathname.match(/^(?:\/wechat-agent)?\/reports\/([^/]+)$/)
      if (req.method === 'GET' && reportMatch) {
        const report = reportStore?.getReport(safeDecode(reportMatch[1]))
        if (!report) return json(res, 404, { error: 'report_not_found' })
        // 同一条 /reports/<id> 路由，两套模板：每日资讯走 ADR-0018 的新闻版式，
        // 微信日报/周报走分节 + 溯源版式（DESIGN-wechat-digest.md）。老数据
        // kind 默认 'report'，行为不变。
        return html(res, 200, report.kind === 'wechat-digest' ? renderDigestPage(report) : renderReportPage(report))
      }
      const profileMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)$/)
      if (req.method === 'GET' && profileMatch) return json(res, 200, { profile: await profileStore?.get(assertHeader(req, 'x-user-id')) })
      // 飞书 OAuth 回调（ADR-0021）：?code=xxx&state=<userId> → 换 token 存 LarkTokenStore。
      // 未配置 lark（LARK_APP_ID）时该路由 404，不影响现有功能。
      const larkCallbackMatch = url.pathname.match(/^(?:\/wechat-agent)?\/lark\/auth\/callback$/)
      if (req.method === 'GET' && larkCallbackMatch) {
        if (!lark?.client) return json(res, 404, { error: 'lark_not_configured' })
        const state = url.searchParams.get('state') || ''
        const code = url.searchParams.get('code') || ''
        if (!code || !state) return json(res, 400, { error: 'missing_code_or_state' })
        try {
          await lark.client.exchangeCode({ code, userId: state })
          return html(res, 200, '<!doctype html><meta charset="utf-8"><title>飞书已授权</title><style>body{font:16px system-ui;max-width:480px;margin:60px auto;padding:0 20px;line-height:1.7}h1{font-size:22px}</style><h1>✅ 飞书已授权</h1><p>授权成功。现在可以回到微信，让助手帮你读写飞书文档了。</p><p>如果这是重复授权，刷新即可，不影响已有配置。</p>')
        } catch (e) {
          return json(res, 400, { error: `lark_auth_failed: ${e.message}` })
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/chat') { const body = await readJson(req); const browserId = assertHeader(req, 'x-user-id'); const text = String(body.text || '').trim(); if (!text || text.length > 4000) return json(res, 400, { error: 'invalid_text' }); const profile = await profileStore?.get(browserId); if (process.env.NODE_ENV === 'production' && !profile?.nickname && !profile?.wxid) return json(res, 403, { error: 'verification_required', message: '请先完成身份验证。' }); const userId = await profileStore?.stableKey(browserId); const result = await agent.respond({ userId, text, profile }); return json(res, 200, { text: result.text, profile: profile ? { nickname: profile.nickname, wxid: profile.wxid } : null }) }
      const match = url.pathname.match(/^\/api\/bindings\/([^/]+)$/)
      if (req.method === 'GET' && match) { const binding = await bindings.refresh(assertHeader(req, 'x-user-id'), match[1]); bind(binding); const live = owned.find((x) => x.id === binding.id); return json(res, 200, { ...binding, sessionExpired: live?.sessionExpired === true || false, lastPollError: live?.lastPollError || '' }) }
      if (req.method === 'POST' && url.pathname === '/api/bot/webhook') return json(res, 200, await router.handleInbound(await readJson(req)))
      return json(res, 404, { error: 'not_found' })
    } catch (error) { return json(res, error.message === 'unauthorized' ? 401 : 400, { error: error.message }) }
  }
}
/** 构造 `VerificationService` 的 onVerified 钩子：核验通过即默认订阅
 * `defaultSubscriptions` 里的公共任务，并（若该链路有可用会话）发一条欢迎语。
 * 单独导出而不是内联进 `createApp`，是为了能脱离 HTTP 层直接测。
 *
 * **订阅键（这是整件事唯一容易做错的地方）**：必须与 `subscribe_task` 工具
 * （`ctx.context.userId`）和调度器 `#fanoutReport` 的
 * `profileStore.get(userId)` / `contextTokens.get(ilinkId)` 用**同一个**稳定
 * 租户键 = iLink `providerUserId`（ADR-0004）。证据链：
 *   - `message-router.mjs` `tenantKey = normalized.providerUserId || …` →
 *     `agent.respond({ userId: tenantKey })` → `agents-sdk-agent.mjs` 的
 *     `run(..., { context: { userId, … } })` → 工具里的 `ctx.context.userId`；
 *     所以 `tasks.subscribers` 里存的是 providerUserId。
 *   - `context-token-cache` 由 `message-router` 用 `normalized.providerUserId`
 *     写入，同一命名空间。
 *   - 而 `ProfileStore` 的**记录键**是网页那次性的 browser id（`x-user-id`），
 *     iLink id 只是记录里的 `ilinkUserId` 字段——两者是不同命名空间，靠
 *     `ProfileStore.get()` 里的 `#byIlink` 反查才对得上。
 * 这里传进来的 `userId` 正是 browser id，所以**必须**过一道 `stableKey()`
 * （ADR-0004 定义的规范解析：`profile.ilinkUserId || userId`）。调用时机也有讲究：
 * `VerificationService` 先 `store.put(userId, profile)` 再调本钩子，此刻
 * `#byIlink` 已建好索引，`stableKey` 才解析得出来。
 *
 * 失败一律吞掉并上报 `onError`：默认订阅是锦上添花，绝不能让它把「核验成功」
 * 这件事本身搞挂（HTTP 层 `check()` 的返回值是用户在网页上唯一的反馈）。 */
export function buildOnVerified({ taskStore, profileStore = null, provider = null, contextTokens = null, defaultSubscriptions = DEFAULT_SUBSCRIPTIONS, onError = () => {} } = {}) {
  const names = (defaultSubscriptions || []).map((n) => String(n).trim()).filter(Boolean)
  if (!taskStore || !names.length) return null
  return async ({ userId, profile } = {}) => {
    try {
      const key = String((await profileStore?.stableKey?.(userId)) || profile?.ilinkUserId || userId || '')
      if (!key) return
      const subscribed = []
      for (const name of names) {
        try {
          // 重复核验（用户重新走一遍网页流程）不重复订阅、也不重复发欢迎语。
          // `taskStore.subscribe` 本身已经幂等，这道检查是为了后者。
          if (taskStore.isSubscribed(name, key)) continue
          taskStore.subscribe(name, key)
          subscribed.push(name)
        } catch (error) { onError(error, name) }
      }
      if (!subscribed.length) return
      // 欢迎语是 best-effort：核验走的是网页（没有 iLink 会话），只有该用户此前
      // 给 Bot 发过消息、缓存里有 contextToken 时才发得出去。发不出去就只订阅。
      const cached = contextTokens?.get?.(key)
      if (typeof provider?.sendText !== 'function' || !cached?.contextToken) return
      await provider.sendText({ providerBotId: cached.providerBotId, toProviderUserId: key, contextToken: cached.contextToken, text: welcomeText(subscribed) })
    } catch (error) { onError(error) }
  }
}

function welcomeText(names) {
  const list = names.map((n) => `「${n}」`).join('、')
  return `✅ 身份已核验，欢迎使用微信个人助手。\n我已默认为你订阅${list}，到点自动推送到这个对话，不用做任何设置。\n不想收了随时回我「退订${names[0]}」；想看看还有什么可订的，回我「有哪些公共任务」。`
}

export function listen(app, { port = 8787, host = '127.0.0.1' } = {}) { const server = http.createServer(app); return new Promise((resolve) => server.listen(port, host, () => resolve(server))) }
function assertHeader(req, name) { const value = req.headers[name]; if (typeof value !== 'string' || !value.trim()) throw new Error('unauthorized'); return value }
function readJson(req) { return new Promise((resolve, reject) => { let data = ''; req.on('data', (chunk) => { data += chunk; if (data.length > 1_000_000) reject(new Error('body_too_large')) }); req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch { reject(new Error('invalid_json')) } }); req.on('error', reject) }) }
function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)) }
function html(res, status, body) { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(body) }
function binary(res, status, contentType, body) { res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'private, max-age=300' }); res.end(body) }
const CONTENT_TYPES = { '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8' }
function guessContentType(filename) { return CONTENT_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream' }
function safeDecode(s) { try { return decodeURIComponent(s) } catch { return s } }
function page() { const basePath = process.env.PUBLIC_BASE_PATH || '/'; return `<!doctype html><meta charset="utf-8"><base href="${basePath}"><title>微信个人助手</title><style>body{font:16px system-ui;max-width:680px;margin:30px auto;padding:0 16px}input,button{font:16px;padding:9px;margin:4px 0}#qr{max-width:360px;display:block;margin-top:20px}#status{white-space:pre-wrap;color:#555}.verify{margin-top:22px;border-top:1px solid #ddd;padding-top:18px}.code{white-space:pre-wrap;background:#fff7ed;border:2px solid #f97316;padding:16px;font-size:24px;font-weight:700;color:#9a3412}.chat{border-top:1px solid #ddd;margin-top:22px;padding-top:18px}.log{min-height:100px;border:1px solid #ddd;padding:10px;margin-bottom:8px}</style><h1>微信个人助手</h1><p>先绑定 Bot，再验证微信昵称，验证通过后才能使用助手。</p><input id="user" placeholder="用户标识" value="test-user"><button id="start">获取 Bot 绑定二维码</button><div id="status"></div><img id="qr" alt="Bot 绑定二维码"><section id="verify" class="verify" style="display:none"><h2>第二步：验证微信身份</h2><p>请扫描二维码添加微信联系人 <b>助手</b>，然后向助手发送下方 6 位数字验证码。</p><img src="assistant-qr.jpg?v=2" alt="助手微信二维码" style="width:320px;background:#fff" onerror="this.style.display='none';document.getElementById('qrError').style.display='block'"><div id="qrError" style="display:none;color:#b42318">助手二维码暂时无法加载，请联系管理员。</div><p id="verifyHint" class="code">正在生成验证码…</p></section><section id="chat" class="chat" style="display:none"><h2>验证成功</h2><p>微信 Bot 已完成绑定和身份核验。请直接回到微信与 Bot 对话。</p></section><script>
const $=id=>document.getElementById(id);let bindingTimer=null,verificationTimer=null,verificationId=null;
async function checkVerification(user){if(!verificationId)return;const r=await fetch('api/profile-verifications/'+verificationId,{headers:{'x-user-id':user}});if(!r.ok)return;const x=await r.json();if(x.status==='verified'){$('verifyHint').textContent='已核验昵称：'+(x.profile.nickname||'未知')+'\\nwxid：'+x.profile.wxid;$('chat').style.display='block';clearInterval(verificationTimer)}}
async function createVerification(user,b){if(verificationId)return;const r=await fetch('api/profile-verifications',{method:'POST',headers:{'x-user-id':user,'content-type':'application/json'},body:JSON.stringify({ilinkUserId:b.profile?.providerUserId||b.providerBotId})});const x=await r.json();if(!r.ok){$('verifyHint').textContent='验证码生成失败：'+(x.error||r.status);return}verificationId=x.id;$('verifyHint').textContent='请向微信“助手”发送下面 6 位数字：\\n\\n'+x.code;verificationTimer=setInterval(()=>checkVerification(user),1000);checkVerification(user)}
async function checkBinding(user,id){const r=await fetch('api/bindings/'+id,{headers:{'x-user-id':user}});const b=await r.json();if(!r.ok){$('status').textContent=b.error||'绑定状态查询失败';return}$('status').textContent='状态：'+b.status;if(b.status==='bound'){$('verify').style.display='block';await createVerification(user,b);clearInterval(bindingTimer)}}
$('start').onclick=async()=>{clearInterval(bindingTimer);clearInterval(verificationTimer);verificationId=null;const user=$('user').value.trim();if(!user){$('status').textContent='请输入用户标识';return}const r=await fetch('api/bindings',{method:'POST',headers:{'x-user-id':user},body:'{}'});const b=await r.json();if(!r.ok){$('status').textContent=b.error||'绑定失败';return}$('status').textContent='请扫描二维码并确认登录\\n状态：pending';const q=await fetch('api/qr?payload='+encodeURIComponent(b.qrPayload));if(q.ok)$('qr').src=(await q.json()).dataUrl;bindingTimer=setInterval(()=>checkBinding(user,b.id),2000)};
</script>` }
