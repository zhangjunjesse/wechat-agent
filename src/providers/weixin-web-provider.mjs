import crypto from 'node:crypto'

/**
 * Minimal Web Weixin provider based on the public WeixinBot protocol notes.
 * This adapter intentionally keeps credentials in memory only. It is not a
 * claim that the legacy Web WeChat endpoints work for every account.
 */
export class WeixinWebProvider {
  #fetch
  #now
  #sessions = new Map()
  #loginBase
  #apiBase

  constructor({ fetchImpl = globalThis.fetch, now = () => Date.now(), loginBase = 'https://login.weixin.qq.com', apiBase = 'https://wx.qq.com/cgi-bin/mmwebwx-bin' } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required')
    this.#fetch = fetchImpl
    this.#now = now
    this.#loginBase = loginBase.replace(/\/$/, '')
    this.#apiBase = apiBase.replace(/\/$/, '')
  }

  async createBindingQr({ userId }) {
    const uuid = await this.#requestUuid()
    const bindingRef = crypto.randomUUID()
    this.#sessions.set(bindingRef, { userId, uuid, status: 'pending', createdAt: this.#now(), cookie: '', baseRequest: null, profile: null })
    return { bindingRef, qrPayload: `${this.#loginBase}/l/${encodeURIComponent(uuid)}`, expiresAt: this.#now() + 180_000 }
  }

  async getBindingStatus({ bindingRef }) {
    const session = this.#sessions.get(bindingRef)
    if (!session) throw new Error('unknown binding')
    if (session.status === 'bound') return this.#boundResult(session)
    const login = await this.#pollLogin(session)
    if (login.code === 408) { session.status = 'expired'; return { status: 'expired' } }
    if (login.code === 201) { session.status = 'scanned'; return { status: 'scanned' } }
    if (login.code !== 200 || !login.redirectUri) return { status: session.status }
    await this.#completeLogin(session, login.redirectUri)
    session.status = 'bound'
    return this.#boundResult(session)
  }

  async pollEvents({ providerBotId }) {
    const session = this.#findSession(providerBotId)
    if (!session?.syncKey) throw new Error('bound session not available')
    const params = new URLSearchParams({ r: String(this.#now()), sid: session.baseRequest.Sid, uin: String(session.baseRequest.Uin), skey: session.baseRequest.Skey, deviceid: session.baseRequest.DeviceID, synckey: syncKeyText(session.syncKey), _: String(this.#now()) })
    const check = await this.#fetch(`https://webpush.weixin.qq.com/cgi-bin/mmwebwx-bin/synccheck?${params}`)
    const checkText = await check.text()
    const retcode = checkText.match(/retcode:\s*["']?(\d+)/)?.[1] || '0'
    const selector = checkText.match(/selector:\s*["']?(\d+)/)?.[1] || '0'
    if (retcode !== '0') return { status: 'disconnected', events: [] }
    if (selector === '0') return { status: 'idle', events: [] }
    const synced = await this.#postJson(`${session.baseUrl}/webwxsync?sid=${encodeURIComponent(session.baseRequest.Sid)}&skey=${encodeURIComponent(session.baseRequest.Skey)}&pass_ticket=${encodeURIComponent(session.passTicket)}`, { BaseRequest: session.baseRequest, SyncKey: session.syncKey, rr: ~Math.floor(this.#now() / 1000) }, session)
    if (synced?.SyncKey) session.syncKey = synced.SyncKey
    return { status: 'ok', events: (synced?.AddMsgList || []).map(normalizeInbound) }
  }

  async sendText({ providerBotId, toProviderUserId, text }) {
    const session = this.#findSession(providerBotId)
    if (!session?.baseRequest) throw new Error('bound session not available')
    const localId = String(this.#now())
    const body = {
      BaseRequest: session.baseRequest,
      Msg: { Type: 1, Content: String(text), FromUserName: session.user.UserName, ToUserName: toProviderUserId, LocalID: localId, ClientMsgId: localId },
    }
    const result = await this.#postJson(`${session.baseUrl}/webwxsendmsg?pass_ticket=${encodeURIComponent(session.passTicket)}`, body, session)
    if (result?.BaseResponse?.Ret !== 0) throw new Error(`send failed: ${result?.BaseResponse?.ErrMsg || result?.BaseResponse?.Ret}`)
    return { providerMessageId: localId }
  }

  async #requestUuid() {
    const params = new URLSearchParams({ appid: 'wx782c26e4c19acffb', fun: 'new', lang: 'zh_CN', _: String(this.#now()) })
    const response = await this.#fetch(`${this.#loginBase}/jslogin?${params}`, { method: 'POST' })
    const text = await response.text()
    const match = text.match(/window\.QRLogin\.code\s*=\s*(\d+).*?window\.QRLogin\.uuid\s*=\s*["']([^"']+)/s)
    if (!match || match[1] !== '200') throw new Error(`uuid request failed: ${text.slice(0, 160)}`)
    return match[2]
  }

  async #pollLogin(session) {
    const params = new URLSearchParams({ tip: session.status === 'scanned' ? '0' : '1', uuid: session.uuid, _: String(this.#now()) })
    const response = await this.#fetch(`${this.#loginBase}/cgi-bin/mmwebwx-bin/login?${params}`)
    const text = await response.text()
    const code = Number(text.match(/window\.code\s*=\s*(\d+)/)?.[1] || 0)
    const redirectUri = text.match(/window\.redirect_uri\s*=\s*["']([^"']+)/)?.[1] || ''
    return { code, redirectUri }
  }

  async #completeLogin(session, redirectUri) {
    const response = await this.#fetch(`${redirectUri}&fun=new&version=v2`, { headers: { Cookie: session.cookie } })
    const xml = await response.text()
    const get = (name) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] || ''
    const ticket = get('ticket')
    session.passTicket = get('pass_ticket')
    session.baseUrl = new URL(redirectUri).origin + '/cgi-bin/mmwebwx-bin'
    session.baseRequest = { Uin: Number(get('wxuin')), Sid: get('wxsid'), Skey: get('skey'), DeviceID: `e${String(Math.floor(Math.random() * 1e15)).padStart(15, '0')}` }
    if (!ticket || !session.baseRequest.Sid) throw new Error('login page missing session fields')
    const init = await this.#postJson(`${session.baseUrl}/webwxinit?pass_ticket=${encodeURIComponent(session.passTicket)}&skey=${encodeURIComponent(session.baseRequest.Skey)}&r=${this.#now()}`, { BaseRequest: session.baseRequest }, session)
    if (init?.BaseResponse?.Ret !== 0) throw new Error('webwxinit failed')
    session.user = init.User || {}
    session.syncKey = init.SyncKey || { Count: 0, List: [] }
    session.profile = { providerUserId: session.user.UserName || '', username: session.user.Alias || '', nickname: session.user.NickName || '', avatarUrl: session.user.HeadImgUrl || '' }
  }

  async #postJson(url, body, session) {
    const response = await this.#fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', Cookie: session.cookie }, body: JSON.stringify(body) })
    return response.json()
  }

  #findSession(providerBotId) {
    return [...this.#sessions.values()].find((x) => x.profile?.providerUserId === providerBotId || x.profile?.username === providerBotId || x.user?.UserName === providerBotId)
  }

  #boundResult(session) { return { status: 'bound', providerBotId: session.profile.providerUserId, profile: session.profile } }
}

function syncKeyText(syncKey) {
  return (syncKey?.List || []).map((item) => `${item.Key}_${item.Val}`).join('|')
}

function normalizeInbound(message) {
  return {
    providerBotId: message.ToUserName,
    providerMessageId: String(message.NewMsgId || message.MsgId || ''),
    providerUserId: message.FromUserName,
    text: String(message.Content || ''),
    occurredAt: Number(message.CreateTime || 0) * 1000,
    msgType: Number(message.MsgType || 0),
  }
}
