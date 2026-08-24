import { createApp, listen } from './app.mjs'
import { ILinkProvider } from './providers/ilink-provider.mjs'
import { BindingStore } from './services/binding-store.mjs'

const provider = new ILinkProvider()
const store = new BindingStore({ file: process.env.BINDINGS_FILE || 'data/bindings.json' })
const app = createApp({ provider, store })
const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || '127.0.0.1'
await listen(app, { port, host })
console.log(`wechat-agent listening on http://${host}:${port}`)
