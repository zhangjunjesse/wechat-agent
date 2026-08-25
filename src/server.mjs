import { createApp, listen } from './app.mjs'
import { ILinkProvider } from './providers/ilink-provider.mjs'
import { BindingStore } from './services/binding-store.mjs'
import { OpenAICompatibleAgent } from './llm/openai-compatible-agent.mjs'
import { AgentsSdkAgent } from './llm/agents-sdk-agent.mjs'
import { SessionStore } from './services/session-store.mjs'

const provider = new ILinkProvider()
const store = new BindingStore({ file: process.env.BINDINGS_FILE || 'data/bindings.json' })
const verifier = process.env.WECHAT_SYNC_ACCESS_KEY ? new (await import('./services/remote-wechat-verifier.mjs')).RemoteWechatVerifier({ baseUrl: process.env.WECHAT_SYNC_BASE_URL || 'https://datadefender.cn', accessKey: process.env.WECHAT_SYNC_ACCESS_KEY }) : null
const profileStore = new (await import('./services/profile-store.mjs')).ProfileStore({ file: process.env.PROFILES_FILE || 'data/profiles.json' })
const sessionStore = new SessionStore({ file: process.env.SESSIONS_FILE || 'data/sessions.db' })
const historyProvider = process.env.WECHAT_SYNC_ACCESS_KEY ? async (userId, profile) => verifier?.recentForProfile(profile) : null
const sessionOpts = { historyProvider, sessionStore, tokenBudget: Number(process.env.SESSION_TOKEN_BUDGET || 128_000), threshold: Number(process.env.SESSION_FOLD_THRESHOLD || 0.8), keepTurns: Number(process.env.SESSION_KEEP_TURNS || 30) }
const agent = process.env.OPENAI_API_KEY ? (process.env.AGENT_SDK === 'openai' ? new AgentsSdkAgent({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY, ...sessionOpts }) : new OpenAICompatibleAgent({ baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || 'gpt-4o-mini', contextProvider: async (userId) => profileStore.get(userId), ...sessionOpts })) : undefined
process.env.PUBLIC_BASE_PATH ||= '/wechat-agent/'
const app = createApp({ provider, store, verifier, profileStore, agent })
const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || '127.0.0.1'
await listen(app, { port, host })
console.log(`wechat-agent listening on http://${host}:${port}`)
