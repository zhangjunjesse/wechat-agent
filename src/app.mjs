import http from 'node:http'
import { BindingService } from './services/binding-service.mjs'
import { MessageRouter } from './services/message-router.mjs'

export function createApp({ provider, agent = { async respond({ text }) { return { text: `Echo: ${text}` } } }, clock }) {
  const bindings = new BindingService({ provider, clock })
  const owned = []
  const router = new MessageRouter({
    provider,
    agent,
    bindings: owned,
  })
  const bind = (binding) => {
    const index = owned.findIndex((item) => item.id === binding.id)
    if (index >= 0) owned[index] = binding
    else owned.push(binding)
  }

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true })
      if (req.method === 'GET' && url.pathname === '/') return json(res, 200, { service: 'wechat-agent', binding: '/api/bindings', webhook: '/api/bot/webhook' })
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
