import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { BindingService } from './services/binding-service.mjs'
import { MessageRouter } from './services/message-router.mjs'
import { PollingService } from './services/polling-service.mjs'
import { VerificationService } from './services/verification-service.mjs'
import { RemoteWechatVerifier } from './services/remote-wechat-verifier.mjs'

export function createApp({ provider, agent = { async respond({ text }) { return { text: `Echo: ${text}` } } }, clock, pollIntervalMs, store, verifier, profileStore }) {
  const owned = []
  let polling
  const bindings = new BindingService({ provider, clock, store, onBound: async (binding) => { if (!binding.providerBotId) return; if (binding.providerSession) await provider.restoreSession?.(binding.providerSession); polling?.start(binding.providerBotId) } })
  const router = new MessageRouter({ provider, agent, bindings: owned, allowPeerUsers: true, contextProvider: async (userId) => profileStore?.get(userId) })
  const verification = verifier ? new VerificationService({ verifier, store: profileStore }) : null
  polling = new PollingService({ provider, router, intervalMs: pollIntervalMs, onError: (error, botId) => console.error('[poll]', botId, error.message), onEvent: (event) => console.log('[event]', JSON.stringify({ providerBotId: event.providerBotId, providerMessageId: event.providerMessageId, providerUserId: event.providerUserId, text: event.text, hasContext: Boolean(event.contextToken) })) })
  void bindings.restoreAndStart().then((records) => records.forEach(bind)).catch((error) => polling.onError?.(error, 'restore'))
  const bind = (binding) => {
    const index = owned.findIndex((item) => item.id === binding.id)
    if (index >= 0) owned[index] = binding
    else owned.push(binding)
  }

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true })
      if (req.method === 'GET' && url.pathname === '/') return html(res, 200, page())
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        const body = await readJson(req)
        const userId = assertHeader(req, 'x-user-id')
        const text = String(body.text || '').trim()
        if (!text || text.length > 4000) return json(res, 400, { error: 'invalid_text' })
        const profile = await profileStore?.get(userId)
        const result = await agent.respond({ userId, text, profile })
        return json(res, 200, { text: result.text, profile: profile ? { nickname: profile.nickname, wxid: profile.wxid } : null })
      }
      if (req.method === 'GET' && url.pathname === '/assistant-qr.jpg') {
        const file = process.env.ASSISTANT_QR_FILE || path.resolve('assistant-qr.jpg')
        return binary(res, 200, 'image/jpeg', await fs.readFile(file))
      }
      if (req.method === 'GET' && url.pathname === '/api/qr') {
        const payload = url.searchParams.get('payload') || ''
        if (!payload || payload.length > 2000) return json(res, 400, { error: 'invalid_qr_payload' })
        const { toDataURL } = await import('qrcode')
        return json(res, 200, { dataUrl: await toDataURL(payload, { width: 320, margin: 2 }) })
      }
      if (req.method === 'POST' && url.pathname === '/api/bindings') {
        await readJson(req)
        const binding = await bindings.start(assertHeader(req, 'x-user-id'))
        bind(binding)
        return json(res, 201, binding)
      }
      if (req.method === 'POST' && url.pathname === '/api/profile-verifications') {
        const body = await readJson(req)
        if (!verification) return json(res, 503, { error: 'verification_not_configured' })
        return json(res, 201, verification.create({ userId: assertHeader(req, 'x-user-id'), ilinkUserId: body.ilinkUserId || '' }))
      }
      const verifyMatch = url.pathname.match(/^\/api\/profile-verifications\/([^/]+)$/)
      if (req.method === 'GET' && verifyMatch) {
        if (!verification) return json(res, 503, { error: 'verification_not_configured' })
        return json(res, 200, await verification.check({ userId: assertHeader(req, 'x-user-id'), id: verifyMatch[1] }))
      }
      const profileMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)$/)
      if (req.method === 'GET' && profileMatch) {
        if (!verification) return json(res, 503, { error: 'verification_not_configured' })
        return json(res, 200, { profile: (await profileStore?.get(assertHeader(req, 'x-user-id'))) || verification.profile(assertHeader(req, 'x-user-id')) })
      }
      const match = url.pathname.match(/^\/api\/bindings\/([^/]+)$/)
      if (req.method === 'GET' && match) {
        const binding = await bindings.refresh(assertHeader(req, 'x-user-id'), match[1])
        bind(binding)
        return json(res, 200, binding)
      }
      if (req.method === 'POST' && url.pathname === '/api/bot/webhook') {
        const body = await readJson(req)
        return json(res, 200, await router.handleInbound(body))
      }
      return json(res, 404, { error: 'not_found' })
    } catch (error) {
      return json(res, error.message === 'unauthorized' ? 401 : 400, { error: error.message })
    }
  }
}

export function listen(app, { port = 8787, host = '127.0.0.1' } = {}) {
  const server = http.createServer(app)
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)))
}

function assertHeader(req, name) {
  const value = req.headers[name]
  if (typeof value !== 'string' || !value.trim()) throw new Error('unauthorized')
  return value
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk; if (data.length > 1_000_000) reject(new Error('body_too_large')) })
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch { reject(new Error('invalid_json')) } })
    req.on('error', reject)
  })
}
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body)
}
function binary(res, status, contentType, body) {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'private, max-age=300' })
  res.end(body)
}
function page() {
  const basePath = process.env.PUBLIC_BASE_PATH || '/'
  return `<!doctype html><meta charset="utf-8"><base href="${basePath}"><title>WeChat Agent</title>
  <style>body{font:16px system-ui;max-width:640px;margin:40px auto}input,button{font:16px;padding:8px;margin:4px 0}#qr{max-width:360px;display:block;margin-top:20px}#status{white-space:pre-wrap;color:#555}</style>
  <h1>WeChat Agent</h1><p>扫码绑定微信 Bot，核验昵称后即可开始对话。</p>
  <section id="chat" style="display:none;margin-top:28px;border-top:1px solid #ddd;padding-top:18px"><h2>个人助手</h2><div id="chatlog" style="min-height:100px;border:1px solid #ddd;padding:10px;margin-bottom:8px"></div><input id="chattext" placeholder="输入消息"><button id="send">发送</button></section>
  <input id="user" placeholder="测试用户标识" value="test-user"><button id="start">获取 Bot 绑定二维码</button><div id="status"></div><img id="qr" alt="Bot 绑定二维码">
  <section id="verify" style="display:none;margin-top:28px;border-top:1px solid #ddd;padding-top:18px"><h2>第二步：添加微信“助手”并验证昵称</h2><p>请用微信扫描下方二维码，添加联系人 <b>助手</b>。添加后，请向助手发送页面提供的一次性验证码。</p><img src="/assistant-qr.jpg" alt="助手微信二维码" style="max-width:320px;display:block"><p id="verifyHint">验证码功能将在绑定成功后启用。</p></section>
  <script>
  const $=id=>document.getElementById(id); let timer;
  $('start').onclick=async()=>{clearInterval(timer);const user=$('user').value.trim();if(!user)return;
    const r=await fetch('api/bindings',{method:'POST',headers:{'x-user-id':user},body:'{}'});const b=await r.json();
    if(!r.ok){$('status').textContent=b.error;return} $('status').textContent='请使用微信扫描二维码并确认登录\\n状态：pending';
    const p=b.qrPayload||''; const qr=await fetch('api/qr?payload='+encodeURIComponent(p)); if(qr.ok){$('qr').src=(await qr.json()).dataUrl}else{$('qr').removeAttribute('src');$('status').textContent+='\\n二维码内容：'+p}
    timer=setInterval(async()=>{const x=await fetch('api/bindings/'+b.id,{headers:{'x-user-id':user}});const s=await x.json();$('status').textContent='状态：'+s.status+(s.profile?'\\n用户：'+(s.profile.nickname||'')+' '+(s.profile.username||''):'');if(s.status==='bound'){$('verify').style.display='block';$('verifyHint').textContent='Bot 已绑定。请添加“助手”，再向助手发送一次性验证码。';if(!window.verifyId){const v=await fetch('api/profile-verifications',{method:'POST',headers:{'x-user-id':user,'content-type':'application/json'},body:JSON.stringify({ilinkUserId:s.profile?.providerUserId||s.providerBotId})});if(v.ok){const t=await v.json();window.verifyId=t.id;$('verifyHint').textContent=t.instruction+'\\n验证码：'+t.code;setInterval(async()=>{const z=await fetch('api/profile-verifications/'+t.id,{headers:{'x-user-id':user}});if(z.ok){const q=await z.json();if(q.status==='verified'){$('verifyHint').textContent='已核验昵称：'+q.profile.nickname+'\\nwxid：'+q.profile.wxid;$('chat').style.display='block'}}},3000)}}}if(['bound','expired','failed'].includes(s.status))clearInterval(timer)},2000)
  };
  $('send').onclick=async()=>{const text=$('chattext').value.trim();if(!text)return;$('chattext').value='';$('chatlog').innerHTML+='<div><b>我：</b>'+text+'</div>';const r=await fetch('api/chat',{method:'POST',headers:{'x-user-id':$('user').value,'content-type':'application/json'},body:JSON.stringify({text})});const j=await r.json();$('chatlog').innerHTML+='<div><b>Agent：</b>'+((j.text||j.error||'').replaceAll('<','&lt;'))+'</div>'};
  </script>`
}
