/** 飞书开放平台 API 客户端（ADR-0021）。
 *
 * 用户级授权：每个用户通过 OAuth 授权自己的飞书（user_access_token），
 * agent 代表该用户操作其文档——bot 身份访问不了用户个人云空间文档。
 *
 * 覆盖接口（均为飞书开放平台文档化接口）：
 *   - 网页授权 URL        GET  /open-apis/authen/v1/index
 *   - code 换 token       POST /open-apis/authen/v1/oidc/access_token
 *   - 刷新 token          POST /open-apis/authen/v1/oidc/refresh_access_token
 *   - 读文档（markdown）   GET  /open-apis/docx/v1/documents/{id}/raw_content
 *   - 搜索文档            POST /open-apis/suite/docs-api/search/object
 *   - 新建 docx           POST /open-apis/docx/v1/documents
 *   - 追加子块            POST /open-apis/docx/v1/documents/{id}/blocks/{block_id}/children
 *
 * token 存 LarkTokenStore（per-user）；每次调用前 ensureToken 检查过期并自动刷新。
 * fetchImpl 可注入（测试用 mock）。 */
export class LarkClient {
  #appId
  #appSecret
  #store
  #fetch
  #baseUrl

  constructor({ appId, appSecret, tokenStore, fetchImpl = globalThis.fetch, baseUrl = 'https://open.feishu.cn' }) {
    if (!appId || !appSecret) throw new Error('未配置 LARK_APP_ID / LARK_APP_SECRET')
    this.#appId = appId
    this.#appSecret = appSecret
    this.#store = tokenStore
    this.#fetch = fetchImpl
    this.#baseUrl = baseUrl.replace(/\/$/, '')
  }

  /** 暴露 token 存储（工具查询授权状态用）。 */
  get tokenStore() {
    return this.#store
  }

  /** 用户 OAuth 授权 URL（微信里发给用户点开授权）。state 绑定 user_id 防 CSRF。 */
  authUrl({ redirectUri, state }) {
    const q = new URLSearchParams({ app_id: this.#appId, redirect_uri: redirectUri, state })
    return `${this.#baseUrl}/open-apis/authen/v1/index?${q.toString()}`
  }

  /** 应用级 tenant_access_token（oidc 系列接口要求带它作为 Bearer，否则 20014）。 */
  async #tenantToken() {
    const body = await this.#post('/open-apis/auth/v3/tenant_access_token/internal', { app_id: this.#appId, app_secret: this.#appSecret })
    const t = body?.tenant_access_token
    if (!t) throw new Error(`获取应用 token 失败：${JSON.stringify(body).slice(0, 200)}`)
    return t
  }

  /** 授权回调：用 code 换 token 并存库（oidc 接口：body 只需 grant_type+code，鉴权走 Bearer tenant）。 */
  async exchangeCode({ code, userId }) {
    const tenant = await this.#tenantToken()
    const body = await this.#post('/open-apis/authen/v1/oidc/access_token', {
      grant_type: 'authorization_code', code,
    }, tenant)
    const d = body?.data || {}
    if (!d.access_token) throw new Error(`换 token 失败：${JSON.stringify(body).slice(0, 200)}`)
    this.#store.set({
      userId, accessToken: d.access_token, refreshToken: d.refresh_token || '',
      expiresIn: d.expires_in || 7200, refreshExpiresIn: d.refresh_expires_in || 0, openId: d.open_id || '',
    })
    return this.#store.get(userId)
  }

  /** 确保返回有效 user_access_token（过期自动刷新）。 */
  async ensureToken(userId) {
    const t = this.#store.get(userId)
    if (!t?.accessToken) throw new Error('尚未授权飞书，请先让用户完成授权')
    if (Date.now() < t.expiresAt) return t.accessToken
    if (!t.refreshToken || Date.now() >= t.refreshExpiresAt) {
      throw new Error('飞书授权已过期，请让用户重新授权')
    }
    const tenant = await this.#tenantToken()
    const body = await this.#post('/open-apis/authen/v1/oidc/refresh_access_token', {
      grant_type: 'refresh_token', refresh_token: t.refreshToken,
    }, tenant)
    const d = body?.data || {}
    if (!d.access_token) throw new Error(`刷新 token 失败：${JSON.stringify(body).slice(0, 200)}`)
    this.#store.set({
      userId, accessToken: d.access_token, refreshToken: d.refresh_token || t.refreshToken,
      expiresIn: d.expires_in || 7200, refreshExpiresIn: d.refresh_expires_in || 30 * 86400, openId: t.openId,
    })
    return d.access_token
  }

  /** 读文档正文 → markdown 文本。docId 支持传完整 URL 自动提取。 */
  async readDoc(userId, docId) {
    const id = extractDocId(docId)
    const token = await this.ensureToken(userId)
    const body = await this.#get(`/open-apis/docx/v1/documents/${encodeURIComponent(id)}/raw_content`, token)
    const content = body?.data?.content || ''
    return { docId: id, content, length: content.length }
  }

  /** 搜索用户可访问的文档（飞书文档搜索）。 */
  async searchDocs(userId, keyword, count = 10) {
    const token = await this.ensureToken(userId)
    const body = await this.#post('/open-apis/suite/docs-api/search/object', { search_key: keyword, count: Math.min(Math.max(count, 1), 20) }, token)
    const items = (body?.data?.entities || []).filter((e) => e.docs)
    return items.map((e) => ({
      title: e.title || e.docs?.title || '',
      url: e.url || e.docs?.url || '',
      type: e.type || e.docs?.obj_type || '',
    }))
  }

  /** 新建 docx 文档，返回 { documentId, url }。 */
  async createDoc(userId, { title = '无标题文档', folderToken = '' } = {}) {
    const token = await this.ensureToken(userId)
    const body = await this.#post('/open-apis/docx/v1/documents', { title, folder_token: folderToken }, token)
    const doc = body?.data?.document || {}
    if (!doc.document_id) throw new Error(`创建文档失败：${JSON.stringify(body).slice(0, 200)}`)
    return { documentId: doc.document_id, url: doc.url || `https://feishu.cn/docx/${doc.document_id}` }
  }

  /** 向文档某块追加子块（默认追加到 body 末尾）。blocks: [{ content: 文本 }] */
  async appendBlocks(userId, docId, { blocks = [], parentBlockId = '' } = {}) {
    const id = extractDocId(docId)
    const token = await this.ensureToken(userId)
    const parent = parentBlockId || 'document' // body 的 block_id 为 "document"
    const children = blocks.map((b) => ({
      block_type: 2, // text
      text: { elements: [{ text_run: { content: String(b.content ?? '') } }] },
    }))
    if (!children.length) return { appended: 0 }
    const body = await this.#post(`/open-apis/docx/v1/documents/${encodeURIComponent(id)}/blocks/${encodeURIComponent(parent)}/children`, { children }, token)
    const created = body?.data?.children || []
    return { appended: created.length }
  }

  /** 导出云文档为文件（pdf/docx），返回 { fileName, buffer }。
   * 飞书导出是异步任务：创建 → 轮询 job_status → 下载 file_token。
   * 需要应用具备导出权限（drive:export:readonly 等）。 */
  async exportDoc(userId, docId, { ext = 'pdf' } = {}) {
    const id = extractDocId(docId)
    const token = await this.ensureToken(userId)
    // 文档标题（用于文件名；取不到就退回 doc id）
    let title = id
    try {
      const meta = await this.#get(`/open-apis/docx/v1/documents/${encodeURIComponent(id)}`, token)
      title = meta?.data?.document?.title || id
    } catch { /* 标题拿不到不致命 */ }
    const created = await this.#post('/open-apis/drive/v1/export_tasks', { file_extension: ext, token: id, type: 'docx' }, token)
    const ticket = created?.data?.ticket
    if (!ticket) throw new Error(`创建导出任务失败：${JSON.stringify(created).slice(0, 200)}`)
    const deadline = Date.now() + 120_000
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500))
      const st = await this.#get(`/open-apis/drive/v1/export_tasks/${encodeURIComponent(ticket)}?token=${encodeURIComponent(id)}`, token)
      const job = st?.data?.result || {}
      if (job.job_status === 0) {
        if (!job.file_token) throw new Error('导出完成但缺少 file_token')
        const buffer = await this.#getBuffer(`/open-apis/drive/v1/export_tasks/file/${encodeURIComponent(job.file_token)}/download`, token)
        return { title, ext, buffer, fileName: `${sanitizeName(title)}.${ext}` }
      }
      if (job.job_status === 3 || job.job_error_msg) throw new Error(`导出失败：${job.job_error_msg || JSON.stringify(job).slice(0, 150)}`)
      if (Date.now() > deadline) throw new Error('导出超时（>120s）')
    }
  }

  // ---- 内部：带错误解析的 HTTP ----

  async #get(pathname, token) {
    const resp = await this.#fetch(`${this.#baseUrl}${pathname}`, { headers: { Authorization: `Bearer ${token}` } })
    return this.#parse(resp)
  }

  async #getBuffer(pathname, token) {
    const resp = await this.#fetch(`${this.#baseUrl}${pathname}`, { headers: { Authorization: `Bearer ${token}` } })
    if (!resp.ok) {
      let detail = ''
      try { const b = await resp.json(); detail = b.msg || b.message || '' } catch { /* binary error */ }
      throw new Error(detail ? `飞书 API 错误(${resp.status}): ${detail}` : `飞书 API 错误 HTTP ${resp.status}`)
    }
    return Buffer.from(await resp.arrayBuffer())
  }

  async #post(pathname, payload, token = null) {
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    const resp = await this.#fetch(`${this.#baseUrl}${pathname}`, { method: 'POST', headers, body: JSON.stringify(payload) })
    return this.#parse(resp)
  }

  async #parse(resp) {
    let body = {}
    try { body = await resp.json() } catch { /* non-json */ }
    if (!resp.ok || (body.code !== undefined && body.code !== 0)) {
      // 飞书业务错误：code + msg/message（新版用 message 字段）
      const detail = body.msg || body.message || ''
      throw new Error(detail ? `飞书 API 错误(${body.code}): ${detail}` : `飞书 API 错误 HTTP ${resp.status}`)
    }
    return body
  }
}

/** 从完整 URL 或裸 id 提取文档 id（支持 feishu.cn/docx/xxx、docs.feishu.cn/docx/xxx、xxx）。 */
export function extractDocId(input) {
  const s = String(input || '').trim()
  const m = s.match(/\/docx\/([A-Za-z0-9]+)/)
  if (m) return m[1]
  const m2 = s.match(/^([A-Za-z0-9]{10,})$/)
  if (m2) return m2[1]
  throw new Error(`无法识别文档地址：${input}（支持 docx 链接或文档 id）`)
}

/** 文件名安全化（去掉路径分隔符与控制字符，限长）。 */
export function sanitizeName(name) {
  return String(name || 'document')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'document'
}
