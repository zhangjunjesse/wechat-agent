import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, listen } from './app.mjs'
import { ILinkProvider } from './providers/ilink-provider.mjs'
import { BindingStore } from './services/binding-store.mjs'
import { AgentsSdkAgent } from './llm/agents-sdk-agent.mjs'
import { SessionStore } from './services/session-store.mjs'
import { MemoryStore } from './services/memory-store.mjs'
import { MemoryManager } from './llm/memory-manager.mjs'
import { MemoryExtractor } from './llm/memory-extractor.mjs'
import { SkillRegistry } from './skills/skill-registry.mjs'
import { buildTools } from './tools/index.mjs'

const provider = new ILinkProvider()
const store = new BindingStore({ file: process.env.BINDINGS_FILE || 'data/bindings.json' })
const verifier = process.env.WECHAT_SYNC_ACCESS_KEY ? new (await import('./services/remote-wechat-verifier.mjs')).RemoteWechatVerifier({ baseUrl: process.env.WECHAT_SYNC_BASE_URL || 'https://datadefender.cn', accessKey: process.env.WECHAT_SYNC_ACCESS_KEY }) : null
const profileStore = new (await import('./services/profile-store.mjs')).ProfileStore({ file: process.env.PROFILES_FILE || 'data/profiles.json' })
const sessionStore = new SessionStore({ file: process.env.SESSIONS_FILE || 'data/sessions.db' })
const memoryStore = new MemoryStore({ file: process.env.MEMORIES_FILE || 'data/memories.db' })
// Resolve skills relative to the source tree (repo root / container /app),
// independent of process CWD, so the declarative skills/ dir is always found.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const skillRegistry = new SkillRegistry({ dir: process.env.SKILLS_DIR || path.resolve(__dirname, '..', 'skills') })

// MemoryManager needs an extractor that talks to the same LLM the agent uses.
const llm = new (await import('openai')).default({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1' })
const memoryManager = new MemoryManager({
  store: memoryStore,
  extractor: new MemoryExtractor({ complete: async (messages, opts = {}) => {
    const r = await llm.chat.completions.create({ model: process.env.OPENAI_MODEL || 'deepseek-chat', messages, temperature: opts.temperature ?? 0, max_tokens: opts.maxTokens ?? 600 })
    return (r.choices?.[0]?.message?.content || '').trim()
  } }),
})

const tools = buildTools({ memoryManager, skillRegistry, fetchImpl: globalThis.fetch })

const sessionOpts = { sessionStore, memoryStore, tokenBudget: Number(process.env.SESSION_TOKEN_BUDGET || 128_000), threshold: Number(process.env.SESSION_FOLD_THRESHOLD || 0.8), keepTurns: Number(process.env.SESSION_KEEP_TURNS || 30) }
const agent = process.env.OPENAI_API_KEY ? new AgentsSdkAgent({ model: process.env.OPENAI_MODEL || 'deepseek-chat', baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY, ...sessionOpts, tools, skillRegistry }) : undefined

process.env.PUBLIC_BASE_PATH ||= '/wechat-agent/'
const app = createApp({ provider, store, verifier, profileStore, agent })
const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || '127.0.0.1'
await listen(app, { port, host })
console.log(`wechat-agent listening on http://${host}:${port}`)
