import { createApp, listen } from './app.mjs'
import { WeixinWebProvider } from './providers/weixin-web-provider.mjs'

const provider = new WeixinWebProvider()
const app = createApp({ provider })
const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || '127.0.0.1'
await listen(app, { port, host })
console.log(`wechat-agent listening on http://${host}:${port}`)
