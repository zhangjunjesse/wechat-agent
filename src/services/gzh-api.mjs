import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** RedFoxHub (redfox.hk) 公众号搜索 API 的 Node 封装（ADR-0013，路线 A）。
 *
 * 与参考实现 `gzh_tool.py`（wechat-gzh-research 技能）同一套协议：
 *   - searchArticle: POST /story/api/gzhData/searchArticle — 关键词搜文章列表
 *   - queryWork:     POST /story/api/gzhData/queryWork — 按 workUuid 抓正文
 * 鉴权：请求头 X-API-KEY；key 来源优先级 REDFOX_API_KEY 环境变量 >
 * ~/.qoder/apis/redfox.json（与 gzh-search-crawler 生态共用同一份配置）。
 *
 * 纯 HTTP 实现（无 Python 依赖），供 gzh_search / gzh_content 工具使用。 */

const SEARCH_URL = 'https://redfox.hk/story/api/gzhData/searchArticle'
const DETAIL_URL = 'https://redfox.hk/story/api/gzhData/queryWork'
export const SEARCH_SOURCE = '公众号搜索爬虫-GitHub'
export const DETAIL_SOURCE = '公众号投资博主蒸馏-GitHub'
export const KEYWORD_MAX_CHARS = 10

const CONFIG_PATH = path.join(os.homedir(), '.qoder', 'apis', 'redfox.json')
const RATE_LIMIT_BACKOFF_MS = 5000

/** Resolve the RedFoxHub API key: env first, then the shared config file
 * (~/.qoder/apis/redfox.json, the gzh-search-crawler convention). */
export function getGzhApiKey({ env = process.env, configPath = CONFIG_PATH } = {}) {
  if (env.REDFOX_API_KEY) return env.REDFOX_API_KEY
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    return cfg.api_key || cfg.REDFOX_API_KEY || null
  } catch {
    return null
  }
}

async function postJson(url, body, { apiKey, fetchImpl, timeoutMs = 30_000, retryOnRateLimit = true }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = { 'Content-Type': 'application/json' }
    if (apiKey) headers['X-API-KEY'] = apiKey
    const resp = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const result = await resp.json()
    let code = result?.code
    if (code === 3108 && retryOnRateLimit) {
      // server-side rate limit: one short backoff-and-retry (same as gzh_tool.py)
      await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS))
      return postJson(url, body, { apiKey, fetchImpl, timeoutMs, retryOnRateLimit: false })
    }
    if (![200, 2000].includes(code)) throw new Error(`API 返回错误码 ${code}：${result?.msg || '(无详细信息)'}`)
    return result
  } finally {
    clearTimeout(timer)
  }
}

/** Keyword search for WeChat official-account articles. Returns a plain list of
 * articles ({workUuid,title,author,summary,readCount,likeCount,publishTime,url})
 * after offset-driven pagination with dedupe (page size is server-controlled,
 * ~20/page; at most `maxPages` pages). */
export async function gzhSearch({ keyword, count = 20, apiKey, fetchImpl = globalThis.fetch, maxPages = 5 } = {}) {
  const kw = String(keyword || '').trim()
  if (!kw) throw new Error('关键词不能为空')
  if (kw.length > KEYWORD_MAX_CHARS) throw new Error(`关键词过长（${kw.length} 字符），API 限制不超过 ${KEYWORD_MAX_CHARS} 字符`)

  const seen = new Set()
  const out = []
  let offset = 0
  for (let page = 0; page < maxPages && out.length < count; page++) {
    const result = await postJson(SEARCH_URL, { keyword: kw, offset, sortType: 'default', source: SEARCH_SOURCE }, { apiKey, fetchImpl })
    const data = result?.data || {}
    const batch = Array.isArray(data) ? data : (data.list || [])
    let added = 0
    for (const a of batch) {
      const id = a.workUuid || a.uuid
      if (id && seen.has(id)) continue
      if (id) seen.add(id)
      out.push({
        workUuid: a.workUuid || a.uuid || '',
        title: a.title || '',
        author: a.author || '',
        summary: a.summary || '',
        readCount: a.readCount,
        likeCount: a.likeCount,
        shareCount: a.shareCount,
        publishTime: a.publishTime,
        url: a.workUrl || a.sourceUrl || '',
      })
      added++
    }
    if (Array.isArray(data) || (data?.hasMore ?? 0) !== 1 || added === 0) break
    offset += batch.length
  }
  return out.slice(0, count)
}

/** Fetch one article's full body by workUuid (from gzhSearch results). */
export async function gzhContent({ workUuid, apiKey, fetchImpl = globalThis.fetch } = {}) {
  if (!workUuid) throw new Error('workUuid 不能为空')
  const result = await postJson(DETAIL_URL, { workUuid, source: DETAIL_SOURCE }, { apiKey, fetchImpl })
  let data = result?.data
  if (Array.isArray(data) && data.length) data = data[0]
  if (!data || typeof data !== 'object') throw new Error('返回数据格式异常，未找到正文字段')
  return {
    workUuid,
    title: data.title || '',
    author: data.author || '',
    publishTime: data.publishTime,
    summary: data.summary || '',
    content: data.content || '',
    contentLength: (data.content || '').length,
    url: data.workUrl || data.sourceUrl || '',
  }
}
