import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { BindingService } from './services/binding-service.mjs'
import { MessageRouter } from './services/message-router.mjs'
import { PollingService } from './services/polling-service.mjs'
import { VerificationService } from './services/verification-service.mjs'

export function createApp({ provider, agent = { async respond({ text }) { return { text: `Echo: ${text}` } } }, clock, pollIntervalMs, store, verifier, profileStore }) {
  const owned = []
  let polling
  const bindings = new BindingService({ provider, clock, store, onBound: async (binding) => { if (!binding.providerBotId) return; if (binding.providerSession) await provider.restoreSession?.(binding.providerSession); polling?.start(binding.providerBotId) } })
  const router = new MessageRouter({ provider, agent, bindings: owned, allowPeerUsers: true, requireVerified: process.env.NODE_ENV === 'production', contextProvider: async (userId) => profileStore?.get(userId) })
  // Verification changes the user's authorization/profile only. iLink does not
  // support reliable unsolicited replies without a prior context_token, so do
  // not pretend to send a success message after verification.
  polling = new PollingService({ provider, router, intervalMs: pollIntervalMs })
  void bindings.restoreAndStart().then((records) => records.forEach(bind)).catch(() => {})
  function bind(binding) { const index = owned.findIndex((x) => x.id === binding.id); if (index >= 0) owned[index] = binding; else owned.push(binding) }

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true })
      if (req.method === 'GET' && url.pathname === '/') return html(res, 200, page())
      if (req.method === 'GET' && (url.pathname === '/assistant-qr.jpg' || url.pathname === '/wechat-agent/assistant-qr.jpg')) return binary(res, 200, 'image/jpeg', await fs.readFile(process.env.ASSISTANT_QR_FILE || path.resolve('assistant-qr.jpg')))
      if (req.method === 'GET' && url.pathname === '/api/qr') { const payload = url.searchParams.get('payload') || ''; if (!payload || payload.length > 2000) return json(res, 400, { error: 'invalid_qr_payload' }); const { toDataURL } = await import('qrcode'); return json(res, 200, { dataUrl: await toDataURL(payload, { width: 320, margin: 2 }) }) }
      if (req.method === 'POST' && url.pathname === '/api/bindings') { await readJson(req); const binding = await bindings.start(assertHeader(req, 'x-user-id')); bind(binding); return json(res, 201, binding) }
      if (req.method === 'POST' && url.pathname === '/api/profile-verifications') { const body = await readJson(req); if (!verification) return json(res, 503, { error: 'verification_not_configured' }); return json(res, 201, verification.create({ userId: assertHeader(req, 'x-user-id'), ilinkUserId: body.ilinkUserId || '' })) }
      const verifyMatch = url.pathname.match(/^\/api\/profile-verifications\/([^/]+)$/)
      if (req.method === 'GET' && verifyMatch) { if (!verification) return json(res, 503, { error: 'verification_not_configured' }); return json(res, 200, await verification.check({ userId: assertHeader(req, 'x-user-id'), id: verifyMatch[1] })) }
      const profileMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)$/)
      if (req.method === 'GET' && profileMatch) return json(res, 200, { profile: await profileStore?.get(assertHeader(req, 'x-user-id')) })
      if (req.method === 'POST' && url.pathname === '/api/chat') { const body = await readJson(req); const userId = assertHeader(req, 'x-user-id'); const text = String(body.text || '').trim(); if (!text || text.length > 4000) return json(res, 400, { error: 'invalid_text' }); const profile = await profileStore?.get(userId); if (process.env.NODE_ENV === 'production' && !profile?.nickname && !profile?.wxid) return json(res, 403, { error: 'verification_required', message: '请先完成身份验证。' }); const result = await agent.respond({ userId, text, profile }); return json(res, 200, { text: result.text, profile: profile ? { nickname: profile.nickname, wxid: profile.wxid } : null }) }
      const match = url.pathname.match(/^\/api\/bindings\/([^/]+)$/)
      if (req.method === 'GET' && match) { const binding = await bindings.refresh(assertHeader(req, 'x-user-id'), match[1]); bind(binding); return json(res, 200, binding) }
      if (req.method === 'POST' && url.pathname === '/api/bot/webhook') return json(res, 200, await router.handleInbound(await readJson(req)))
      return json(res, 404, { error: 'not_found' })
    } catch (error) { return json(res, error.message === 'unauthorized' ? 401 : 400, { error: error.message }) }
  }
}
export function listen(app, { port = 8787, host = '127.0.0.1' } = {}) { const server = http.createServer(app); return new Promise((resolve) => server.listen(port, host, () => resolve(server))) }
function assertHeader(req, name) { const value = req.headers[name]; if (typeof value !== 'string' || !value.trim()) throw new Error('unauthorized'); return value }
function readJson(req) { return new Promise((resolve, reject) => { let data = ''; req.on('data', (chunk) => { data += chunk; if (data.length > 1_000_000) reject(new Error('body_too_large')) }); req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch { reject(new Error('invalid_json')) } }); req.on('error', reject) }) }
function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)) }
function html(res, status, body) { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(body) }
function binary(res, status, contentType, body) { res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'private, max-age=300' }); res.end(body) }
function page() { const basePath = process.env.PUBLIC_BASE_PATH || '/'; return `<!doctype html><meta charset="utf-8"><base href="${basePath}"><title>微信个人助手</title><style>body{font:16px system-ui;max-width:680px;margin:30px auto;padding:0 16px}input,button{font:16px;padding:9px;margin:4px 0}#qr{max-width:360px;display:block;margin-top:20px}#status{white-space:pre-wrap;color:#555}.verify{margin-top:22px;border-top:1px solid #ddd;padding-top:18px}.code{white-space:pre-wrap;background:#fff7ed;border:2px solid #f97316;padding:16px;font-size:24px;font-weight:700;color:#9a3412}.chat{border-top:1px solid #ddd;margin-top:22px;padding-top:18px}.log{min-height:100px;border:1px solid #ddd;padding:10px;margin-bottom:8px}</style><h1>微信个人助手</h1><p>先绑定 Bot，再验证微信昵称，验证通过后才能使用助手。</p><input id="user" placeholder="用户标识" value="test-user"><button id="start">获取 Bot 绑定二维码</button><div id="status"></div><img id="qr" alt="Bot 绑定二维码"><section id="verify" class="verify" style="display:none"><h2>第二步：验证微信身份</h2><p>请扫描二维码添加微信联系人 <b>助手</b>，然后向助手发送下方 6 位数字验证码。</p><img src="assistant-qr.jpg?v=2" alt="助手微信二维码" style="width:320px;background:#fff" onerror="this.style.display='none';document.getElementById('qrError').style.display='block'"><div id="qrError" style="display:none;color:#b42318">助手二维码暂时无法加载，请联系管理员。</div><p id="verifyHint" class="code">正在生成验证码…</p></section><section id="chat" class="chat" style="display:none"><h2>验证成功</h2><p>微信 Bot 已完成绑定和身份核验。请直接回到微信与 Bot 对话。</p></section><script>
const $=id=>document.getElementById(id);let bindingTimer=null,verificationTimer=null,verificationId=null;
async function checkVerification(user){if(!verificationId)return;const r=await fetch('api/profile-verifications/'+verificationId,{headers:{'x-user-id':user}});if(!r.ok)return;const x=await r.json();if(x.status==='verified'){$('verifyHint').textContent='已核验昵称：'+(x.profile.nickname||'未知')+'\\nwxid：'+x.profile.wxid;$('chat').style.display='block';clearInterval(verificationTimer)}}
async function createVerification(user,b){if(verificationId)return;const r=await fetch('api/profile-verifications',{method:'POST',headers:{'x-user-id':user,'content-type':'application/json'},body:JSON.stringify({ilinkUserId:b.profile?.providerUserId||b.providerBotId})});const x=await r.json();if(!r.ok){$('verifyHint').textContent='验证码生成失败：'+(x.error||r.status);return}verificationId=x.id;$('verifyHint').textContent='请向微信“助手”发送下面 6 位数字：\\n\\n'+x.code;verificationTimer=setInterval(()=>checkVerification(user),1000);checkVerification(user)}
async function checkBinding(user,id){const r=await fetch('api/bindings/'+id,{headers:{'x-user-id':user}});const b=await r.json();if(!r.ok){$('status').textContent=b.error||'绑定状态查询失败';return}$('status').textContent='状态：'+b.status;if(b.status==='bound'){$('verify').style.display='block';await createVerification(user,b);clearInterval(bindingTimer)}}
$('start').onclick=async()=>{clearInterval(bindingTimer);clearInterval(verificationTimer);verificationId=null;const user=$('user').value.trim();if(!user){$('status').textContent='请输入用户标识';return}const r=await fetch('api/bindings',{method:'POST',headers:{'x-user-id':user},body:'{}'});const b=await r.json();if(!r.ok){$('status').textContent=b.error||'绑定失败';return}$('status').textContent='请扫描二维码并确认登录\\n状态：pending';const q=await fetch('api/qr?payload='+encodeURIComponent(b.qrPayload));if(q.ok)$('qr').src=(await q.json()).dataUrl;bindingTimer=setInterval(()=>checkBinding(user,b.id),2000)};
</script>` }
