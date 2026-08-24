import http from 'node:http'
import { BindingService } from './services/binding-service.mjs'
import { MessageRouter } from './services/message-router.mjs'
import { PollingService } from './services/polling-service.mjs'

export function createApp({ provider, agent = { async respond({ text }) { return { text: `Echo: ${text}` } } }, clock, pollIntervalMs, store }) {
  const owned = []
  let polling
  const bindings = new BindingService({ provider, clock, store, onBound: async (binding) => { if (binding.providerBotId) polling?.start(binding.providerBotId) } })
  const router = new MessageRouter({ provider, agent, bindings: owned })
  polling = new PollingService({ provider, router, intervalMs: pollIntervalMs })
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
function page() {
  return `<!doctype html><meta charset="utf-8"><title>WeChat Agent</title>
  <style>body{font:16px system-ui;max-width:640px;margin:40px auto}input,button{font:16px;padding:8px;margin:4px 0}#qr{max-width:360px;display:block;margin-top:20px}#status{white-space:pre-wrap;color:#555}</style>
  <h1>WeChat Agent</h1><p>输入测试用户标识后创建绑定。</p>
  <input id="user" placeholder="测试用户标识" value="test-user"><button id="start">获取二维码</button><div id="status"></div><img id="qr" alt="二维码">
  <script>
  const $=id=>document.getElementById(id); let timer;
  $('start').onclick=async()=>{clearInterval(timer);const user=$('user').value.trim();if(!user)return;
    const r=await fetch('/api/bindings',{method:'POST',headers:{'x-user-id':user},body:'{}'});const b=await r.json();
    if(!r.ok){$('status').textContent=b.error;return} $('status').textContent='请使用微信扫描二维码并确认登录\\n状态：pending';
    const p=b.qrPayload||''; const qr=await fetch('/api/qr?payload='+encodeURIComponent(p)); if(qr.ok){$('qr').src=(await qr.json()).dataUrl}else{$('qr').removeAttribute('src');$('status').textContent+='\\n二维码内容：'+p}
    timer=setInterval(async()=>{const x=await fetch('/api/bindings/'+b.id,{headers:{'x-user-id':user}});const s=await x.json();$('status').textContent='状态：'+s.status+(s.profile?'\\n用户：'+(s.profile.nickname||'')+' '+(s.profile.username||''):'');if(['bound','expired','failed'].includes(s.status))clearInterval(timer)},2000)
  };
  </script>`
}
