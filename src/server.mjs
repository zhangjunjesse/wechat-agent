import { createApp, listen } from './app.mjs'
import { ILinkProvider } from './providers/ilink-provider.mjs'

// iLink is a Bot binding protocol. Do not use the legacy Web WeChat provider
// here: that provider intentionally opens the "网页版微信登录" flow.
const provider = new ILinkProvider()
const app = createApp({ provider })
const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || '127.0.0.1'
await listen(app, { port, host })
console.log(`wechat-agent listening on http://${host}:${port}`)
