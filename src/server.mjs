import { createApp, listen } from './app.mjs'
import { ILinkProvider } from './providers/ilink-provider.mjs'
import { BindingStore } from './services/binding-store.mjs'
import { OpenAICompatibleAgent } from './llm/openai-compatible-agent.mjs'
import { AgentsSdkAgent } from './llm/agents-sdk-agent.mjs'

const provider = new ILinkProvider()
const store = new BindingStore({ file: process.env.BINDINGS_FILE || 'data/bindings.json' })
const verifier = process.env.WECHAT_SYNC_ACCESS_KEY ? new (await import('./services/remote-wechat-verifier.mjs')).RemoteWechatVerifier({ baseUrl: process.env.WECHAT_SYNC_BASE_URL || 'https://datadefender.cn', accessKey: process.env.WECHAT_SYNC_ACCESS_KEY }) : null
const profileStore = new (await import('./services/profile-store.mjs')).ProfileStore({ file: process.env.PROFILES_FILE || 'data/profiles.json' })
const historyProvider = process.env.WECHAT_SYNC_ACCESS_KEY ? async (userId, profile) => verifier?.recentForProfile(profile) : null
const agent = process.env.OPENAI_API_KEY ? (process.env.AGENT_SDK === 'openai' ? new AgentsSdkAgent({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY, historyProvider }) : new OpenAICompatibleAgent({ baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || 'gpt-4o-mini', contextProvider: async (userId) => profileStore.get(userId), historyProvider })) : undefined
const app = createApp({ provider, store, verifier, profileStore, agent })
const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || '127.0.0.1'
await listen(app, { port, host })
console.log(`wechat-agent listening on http://${host}:${port}`)
