export function renderPage() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<base href="${process.env.PUBLIC_BASE_PATH || '/wechat-agent/'}">
<title>微信个人助手</title>
<style>
*{box-sizing:border-box}
:root{--ink:#101828;--muted:#667085;--line:#eaecf0;--brand:#3b5bdb;--brand-d:#2c4099;--ok:#027a48;--warn:#b54708;--bg:#f4f6fb;--card:#fff}
html,body{margin:0;padding:0}
body{font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);background:radial-gradient(1100px 500px at 78% -8%,#dbe4ff 0,transparent 55%),var(--bg);min-height:100vh}
button{font:inherit;cursor:pointer;border:0}
.wrap{max-width:1040px;margin:0 auto;padding:44px 22px 64px}
.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:42px}
.brand{display:flex;align-items:center;gap:11px;font-weight:760;font-size:17px;color:var(--ink)}
.logo{width:38px;height:38px;border-radius:12px;background:linear-gradient(145deg,#5b78f0,#3350c4);display:grid;place-items:center;color:#fff;box-shadow:0 8px 18px #3b5bdb3a}
.badge{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted);background:#fff;border:1px solid var(--line);padding:7px 12px;border-radius:30px}
.badge .dot{width:7px;height:7px;border-radius:50%;background:#17b26a;box-shadow:0 0 0 4px #17b26a1c}
.hero{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;margin-bottom:34px}
.eyebrow{font-size:12px;font-weight:740;letter-spacing:1.4px;text-transform:uppercase;color:var(--brand)}
.hero h1{font-size:30px;font-weight:800;letter-spacing:-.8px;margin:10px 0 8px;color:var(--ink)}
.hero p{color:var(--muted);margin:0;max-width:520px;font-size:14.5px}
.pill{white-space:nowrap;background:#eef2ff;color:var(--brand-d);border-radius:30px;padding:9px 15px;font-size:12.5px;font-weight:650}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;overflow:hidden;box-shadow:0 14px 40px #1a2a5a10,0 2px 8px #1a2a5a08}
.cardHead{padding:22px 24px 16px;border-bottom:1px solid var(--line);display:flex;gap:13px;align-items:center}
.step{width:30px;height:30px;flex:none;border-radius:10px;background:#eef2ff;color:var(--brand);display:grid;place-items:center;font-weight:800}
.cardHead h2{font-size:16px;margin:0}
.cardHead small{display:block;color:var(--muted);font-weight:400;margin-top:2px}
.body{padding:22px 24px}
.status{display:flex;gap:11px;align-items:flex-start;padding:13px 15px;border-radius:12px;background:#f8fafc;border:1px solid var(--line);color:var(--muted);font-size:14px;min-height:50px}
.status .ico{width:22px;flex:none;text-align:center;font-size:18px;line-height:1.3}
.status.pulse .ico{animation:spin 1.4s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.status.ok{background:#ecfdf3;border-color:#abefc6;color:var(--ok)}
.status.warn{background:#fff6ed;border-color:#fedf89;color:var(--warn)}
.qrbox{margin-top:18px;display:flex;align-items:center;justify-content:center;min-height:250px;background:radial-gradient(400px 260px at 50% 20%,#fff 0,#f3f5fb 100%);border:1px solid var(--line);border-radius:16px}
.qrbox img{width:210px;height:210px;object-fit:contain;background:#fff;border-radius:12px;box-shadow:0 10px 26px #1a2a5a18}
.qrbox .empty{color:#98a2b3;font-size:13px}
.cta{display:flex;justify-content:center;margin-top:16px}
.btn{border-radius:12px;padding:13px 22px;font-weight:700;color:#fff;background:linear-gradient(135deg,#4a67e8,var(--brand-d));box-shadow:0 8px 18px #3b5bdb30;transition:.15s;font-size:14.5px}
.btn:hover{transform:translateY(-1px);filter:brightness(1.04)}
.verify{margin-top:24px;border-top:1px solid var(--line);padding-top:22px}
.verify h3{font-size:15px;margin:0 0 5px;display:flex;align-items:center;gap:8px}
.verify p{color:var(--muted);margin:0 0 16px;font-size:14px}
.assistant{width:200px;border:1px solid var(--line);border-radius:14px;display:block;margin:0 0 12px;background:#fff;padding:6px}
.error{color:#d92d20;font-size:13px;margin-top:6px}
.code{margin-top:14px;padding:17px;border:1px solid #fedf89;background:#fff8ef;color:var(--warn);border-radius:14px;white-space:pre-wrap;font-weight:800;font-size:21px;line-height:1.5}
.code.success{border-color:#abefc6;background:#ecfdf3;color:var(--ok)}
.spin{animation:spin 1.4s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
.chat{display:none}
.chat.on{display:block}
.readybar{margin-bottom:16px;padding:14px 16px;border-radius:13px;background:#ecfdf3;border:1px solid #abefc6;color:var(--ok);display:flex;gap:10px;align-items:center;font-weight:600}
.foot{color:#98a2b3;text-align:center;font-size:12.5px;margin-top:26px}
@media(max-width:820px){.wrap{padding:26px 16px 46px}.hero{flex-direction:column;align-items:flex-start;gap:14px}.grid{grid-template-columns:1fr}.pill{margin-top:0}}
</style></head><body><div class="wrap"><header class="top"><div class="brand"><span class="logo"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 11.5a7.5 7.5 0 0 1-9.9 7.1L5 20l1.5-4.2A7.5 7.5 0 1 1 20 11.5Z"/><path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01"/></svg></span>微信个人助手</div><div class="badge"><span class="dot"></span>本服务运行正常</div></header><section class="hero"><div><div class="eyebrow">AI Personal Assistant</div><h1>你的微信里，多了一位懂你的助手</h1><p>扫码绑定、核验身份即可使用。你的会话、昵称与上下文彼此隔离，互不可见。</p></div><div class="pill">腾讯 iLink · DeepSeek</div></section><div class="grid">
<section class="card"><div class="cardHead"><span class="step">1</span><div><h2>绑定微信 Bot</h2><small>用微信扫码确认连接</small></div></div><div class="body"><div id="status" class="status"><span class="ico" id="statusIco">•</span><span id="statusText">点击下方按钮，获取你的专属二维码</span></div><div class="qrbox"><img id="botQr" alt="二维码" style="display:none"><span class="empty" id="botEmpty" style="display:block">二维码将在这里显示</span></div><div class="cta"><button class="btn" id="start">获取绑定二维码</button></div></div></section>
<section class="card"><div class="cardHead"><span class="step">2</span><div><h2>核验微信身份</h2><small>验证通过后才能使用助手</small></div></div><div class="body"><div id="verify" style="display:none"><h3><span class="step">2</span>添加「助手」并验证</h3><p>扫描下方二维码添加联系人 <b>助手</b>，然后向助手发送页面显示的 6 位数字验证码。</p><img class="assistant" id="assistantImg" src="assistant-qr.jpg?v=3" alt="助手二维码" onerror="this.style.display='none';document.getElementById('qrError').style.display='block'"><div class="error" id="qrError" style="display:none">助手二维码加载失败，请刷新重试。</div><div id="hint" class="code"><span class="spin">⟳</span> 正在生成验证码…</div></div><div id="preVerify" style="color:#98a2b3;font-size:13px">尚未绑定，请先完成第一步。</div></div></section>
</div>
<section id="chat" class="card chat"><div class="cardHead"><span class="step" style="color:#027a48;background:#ecfdf3">✓</span><div><h2>连接成功</h2><small>身份已核验</small></div></div><div class="body"><div class="readybar">✓ 你的微信身份已确认，现在可以开始使用</div><div style="color:var(--muted);font-size:14px">请回到微信，直接在对话中向「助手」发送消息即可开始。</div></div></section>
<div class="foot">身份资料仅用于匹配你的微信记录 · 未核验用户不会使用 AI 服务</div></div><script>
const $=id=>document.getElementById(id);let bindTimer,verifyTimer,verifyId,hasBound=false;
const STATUS_LABEL={pending:'等待你扫码确认',scanned:'二维码已扫描，请在手机上确认',bound:'绑定成功'}
async function pollVerify(user){if(!verifyId)return;const r=await fetch('api/profile-verifications/'+verifyId,{headers:{'x-user-id':user}});if(!r.ok)return;const x=await r.json();if(x.status==='verified'){$('hint').textContent='✓ 身份核验成功\\n昵称：'+(x.profile.nickname||'未知')+'\\nwxid：'+x.profile.wxid;$('hint').classList.add('success');$('chat').classList.add('on');clearInterval(verifyTimer);return}if(x.status==='expired'){$('hint').textContent='验证码已过期，请返回重新绑定。';$('hint').classList.add('warn');clearInterval(verifyTimer)}}
async function startVerify(user,b){if(verifyId||hasBound)return;hasBound=true;$('verify').style.display='block';$('preVerify').style.display='none';const r=await fetch('api/profile-verifications',{method:'POST',headers:{'x-user-id':user,'content-type':'application/json'},body:JSON.stringify({ilinkUserId:b.profile?.providerUserId||b.providerBotId})});const x=await r.json();if(!r.ok){$('hint').textContent='验证码生成失败：'+(x.error||r.status);return}verifyId=x.id;$('hint').textContent='请向微信「助手」发送下面 6 位数字：\\n\\n'+x.code;verifyTimer=setInterval(()=>pollVerify(user),1000);pollVerify(user)}
function setStatus(txt,kind,ico){const s=$('status');$('statusText').textContent=txt;$('statusIco').textContent=ico||'•';s.className='status'+(kind?' '+kind:'')}
async function pollBind(user,id){const r=await fetch('api/bindings/'+id,{headers:{'x-user-id':user}});const b=await r.json();if(!r.ok){setStatus('绑定状态查询失败，请重试。',null,'!');return}const label=STATUS_LABEL[b.status]||b.status;setStatus(label,b.status==='bound'?'ok':b.status==='scanned'?'':'pulse',b.status==='bound'?'✓':'⟳');if(b.status==='bound'){startVerify(user,b);clearInterval(bindTimer)}}
$('start').onclick=async()=>{clearInterval(bindTimer);clearInterval(verifyTimer);verifyId=null;hasBound=false;$('verify').style.display='none';$('preVerify').style.display='block';$('chat').classList.remove('on');const user='u_'+crypto.randomUUID().slice(0,12);try{sessionStorage.setItem('wa-user',user)}catch(e){}setStatus('正在为你生成二维码…',null,'⟳');const r=await fetch('api/bindings',{method:'POST',headers:{'x-user-id':user},body:'{}'});const b=await r.json();if(!r.ok){setStatus('绑定失败：'+(b.error||'请重试'),'warn','!');return}$('botEmpty').style.display='none';$('botQr').src='';const q=await fetch('api/qr?payload='+encodeURIComponent(b.qrPayload));if(q.ok){$('botQr').src=(await q.json()).dataUrl;$('botQr').style.display='block'}setStatus('请使用微信扫描二维码，并在手机上确认登录',null,'⟳');bindTimer=setInterval(()=>pollBind(user,b.id),2000)};
</script></body></html>`
}
