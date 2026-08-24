import crypto from 'node:crypto'

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const APP_ID = 'bot'
const CLIENT_VERSION = '131336' // 2.1.8

/**
 * Tencent iLink Bot adapter. Credentials stay in memory until the application
 * adds encrypted persistence. The protocol is 1:1 only; iLink does not support
 * group chats or a general public-account identity lookup.
 */
export class ILinkProvider {
  #fetch
  #now
  #baseUrl
  #sessions = new Map()

  constructor({ fetchImpl = globalThis.fetch, now = () => Date.now(), baseUrl = DEFAULT_BASE_URL } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required')
    this.#fetch = fetchImpl
    this.#now = now
    this.#baseUrl = baseUrl.replace(/\/$/, '')
  }

  async createBindingQr({ userId }) {
    const qr = await this.#get('ilink/bot/get_bot_qrcode?bot_type=3')
    if (!qr.qrcode || !qr.qrcode_img_content) throw new Error('iLink QR response missing qrcode')
    const bindingRef = crypto.randomUUID()
    this.#sessions.set(bindingRef, {
      userId, qrcode: qr.qrcode, status: 'pending',
      botId: '', token: '', baseUrl: '', profile: null, cursor: '',
    })
    return { bindingRef, qrPayload: qr.qrcode_img_content, expiresAt: this.#now() + 480_000 }
  }

  async getBindingStatus({ bindingRef }) {
    const session = this.#sessions.get(bindingRef)
    if (!session) throw new Error('unknown binding')
    if (session.status === 'bound') return this.#bound(session)
    const status = await this.#get(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.qrcode)}`)
    if (status.status === 'wait') return { status: 'pending' }
    if (status.status === 'scaned') { session.status = 'scanned'; return { status: 'scanned' } }
    if (status.status === 'expired') { session.status = 'expired'; return { status: 'expired' } }
    if (status.status !== 'confirmed') return { status: session.status }
    if (!status.ilink_bot_id || !status.bot_token) throw new Error('iLink confirmation missing bot credentials')
    session.status = 'bound'
    session.botId = status.ilink_bot_id
    session.token = status.bot_token
    session.baseUrl = (status.baseurl || this.#baseUrl).replace(/\/$/, '')
    session.profile = {
      providerUserId: status.ilink_user_id || status.ilink_bot_id,
      username: '',
      nickname: '',
      avatarUrl: '',
    }
    return this.#bound(session)
  }

  async pollEvents({ providerBotId }) {
    const session = this.#find(providerBotId)
    if (!session) throw new Error('bound session not available')
    const response = await this.#post(session, 'ilink/bot/getupdates', { get_updates_buf: session.cursor || '' }, 35_000)
    if (response.get_updates_buf) session.cursor = response.get_updates_buf
    return { status: 'ok', events: (response.msgs || []).filter((m) => m.message_type === 1).flatMap((m) => {
      const text = (m.item_list || []).find((i) => i.type === 1)?.text_item?.text || ''
      if (!text || !m.from_user_id) return []
      return [{ providerBotId: session.botId, providerMessageId: String(m.message_id || m.client_id || ''), providerUserId: m.from_user_id, text, occurredAt: this.#now(), contextToken: m.context_token || '' }]
    }) }
  }

  async sendText({ providerBotId, toProviderUserId, text, contextToken }) {
    const session = this.#find(providerBotId)
    if (!session) throw new Error('bound session not available')
    if (!contextToken) throw new Error('iLink contextToken is required to send')
    const clientId = `ilink-${this.#now()}-${crypto.randomBytes(4).toString('hex')}`
    const result = await this.#post(session, 'ilink/bot/sendmessage', {
      msg: { from_user_id: '', to_user_id: toProviderUserId, client_id: clientId, message_type: 2, message_state: 2, context_token: contextToken, item_list: [{ type: 1, text_item: { text: String(text) } }] },
    })
    if (result.ret && result.ret !== 0) throw new Error(`iLink send failed: ${result.ret}`)
    return { providerMessageId: clientId }
  }

  #find(botId) { return [...this.#sessions.values()].find((s) => s.botId === botId || s.profile?.providerUserId === botId) }
  #bound(s) { return { status: 'bound', providerBotId: s.botId, profile: s.profile } }

  async #get(path) {
    const response = await this.#fetch(`${this.#baseUrl}/${path}`, { headers: { 'iLink-App-Id': APP_ID, 'iLink-App-ClientVersion': CLIENT_VERSION } })
    if (!response.ok) throw new Error(`iLink GET failed: ${response.status}`)
    return response.json()
  }

  async #post(session, path, payload, timeout = 15_000) {
    const body = JSON.stringify({ ...payload, base_info: { channel_version: 'wechat-agent/0.1.0' } })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const response = await this.#fetch(`${session.baseUrl}/${path}`, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token', Authorization: `Bearer ${session.token}`, 'iLink-App-Id': APP_ID, 'iLink-App-ClientVersion': CLIENT_VERSION, 'X-WECHAT-UIN': Buffer.from(String(Math.floor(Math.random() * 2 ** 32))).toString('base64') },
        body,
      })
      if (!response.ok) throw new Error(`iLink POST failed: ${response.status}`)
      return response.json()
    } finally { clearTimeout(timer) }
  }
}
