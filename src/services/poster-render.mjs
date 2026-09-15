import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

/** 海报渲染服务（HTML → PNG 长图，skills/poster-render 的底层通道）。
 *
 * 用无头浏览器截图把 HTML 渲染成 PNG：现代 CSS（flex/渐变/mask）与中文排版
 * 都能正确渲染，这是"文字在图片上"且不乱码的唯一可靠路径（AI 生图做不到）。
 *
 * 实现：CDP（Chrome DevTools Protocol）——spawn 无头浏览器（--remote-debugging-port=0，
 * 从 stderr 读 ws 地址）→ WebSocket 连接 → Emulation 设宽度 → Runtime.evaluate
 * 量内容高度 → Page.captureScreenshot(captureBeyondViewport=true) 全页截图。
 * 不依赖 --dump-dom/--screenshot 命令行开关（headless shell 上不可靠）。
 *
 * 依赖：系统 chromium/chrome/edge（Windows 开发机）或 @sparticuz/chromium
 * （Linux 容器兜底，serverless 无头 chromium，自带运行库，容器需 apt 装其系统库）。
 * 每次调用起一次性进程，用完即退，不常驻、空闲零占用。 */

const CANDIDATES = [
  () => process.env.CHROME_PATH,
  () => { try { return requirePath('chromium') } catch { return null } },
  () => { try { return requirePath('chromium-browser') } catch { return null } },
  () => { try { return requirePath('google-chrome') } catch { return null } },
  () => { try { return requirePath('google-chrome-stable') } catch { return null } },
  // Windows 本地开发：Edge/Chrome 常见安装路径
  () => 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  () => 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  () => 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  () => 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

function requirePath(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf8' })
  return r.status === 0 ? String(r.stdout || '').trim() : null
}

/** 探测可用的无头浏览器可执行文件；找不到返回 null。 */
export function detectBrowser() {
  for (const c of CANDIDATES) {
    try {
      const p = c()
      if (p && fs.existsSync(p)) return p
    } catch { /* try next */ }
  }
  return null
}

/** 渲染 HTML 为 PNG 长图（CDP 全页截图，自动量高，无截断/空白）。
 * 浏览器探测：显式传入 > 系统 chromium/chrome/edge > @sparticuz/chromium（Linux 兜底）。
 * @param {string} html 海报 HTML（body 建议定宽，如 750px）
 * @param {object} opts { width=750, outPath, browser=detectBrowser() }
 * @returns 图片绝对路径；无浏览器/渲染失败时抛错（调用方决定降级策略）
 */
export async function renderPoster(html, { width = 750, outPath = null, browser = null } = {}) {
  let bin = browser || detectBrowser()
  if (!bin) {
    try {
      const chromium = (await import('@sparticuz/chromium')).default
      bin = await chromium.executablePath()
    } catch { /* 无任何可用浏览器 */ }
  }
  if (!bin) throw new Error('未找到无头浏览器（chromium/chrome/edge/@sparticuz/chromium），无法渲染海报')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poster-'))
  const htmlFile = path.join(dir, 'poster.html')
  // 截图路径必须绝对（无头浏览器对相对路径解析不可靠）
  const pngFile = path.resolve(outPath || path.join(dir, 'poster.png'))
  fs.mkdirSync(path.dirname(pngFile), { recursive: true })
  fs.writeFileSync(htmlFile, html, 'utf8')

  let browserProc = null
  try {
    browserProc = spawn(bin, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      '--remote-debugging-port=0', '--user-data-dir=' + path.join(dir, 'profile'),
      `file://${htmlFile}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })

    const wsUrl = await new Promise((resolve, reject) => {
      let buf = ''
      const timer = setTimeout(() => reject(new Error('浏览器启动超时')), 20_000)
      browserProc.stderr.on('data', (chunk) => {
        buf += String(chunk)
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf)
        if (m) { clearTimeout(timer); resolve(m[1]) }
      })
      browserProc.on('exit', () => { clearTimeout(timer); reject(new Error(`浏览器提前退出: ${buf.slice(0, 200)}`)) })
    })

    const png = await captureFullPage(wsUrl, htmlFile, { width, pngFile })
    return png
  } finally {
    try { browserProc?.kill() } catch { /* already dead */ }
    // profile 目录在进程退出瞬间可能被系统短暂锁定（Windows）——删除失败可忽略
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp leak acceptable */ }
  }
}

/** 通过 CDP 量高并全页截图（captureBeyondViewport）。
 * browser 级 ws + Target.attachToTarget(flatten) 拿 page session，命令带 sessionId。 */
async function captureFullPage(wsUrl, htmlFile, { width, pngFile }) {
  const cdp = await connect(wsUrl)
  try {
    const targets = await cdp.send('Target.getTargets')
    const page = (targets?.targetInfos || []).find((t) => t.type === 'page' && String(t.url || '').startsWith('file://'))
      || (targets?.targetInfos || []).find((t) => t.type === 'page')
    if (!page?.targetId) throw new Error('未找到 page target')
    const attached = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    const sessionId = attached?.sessionId
    if (!sessionId) throw new Error('Target.attachToTarget 未返回 sessionId')
    const send = (method, params = {}) => cdp.send(method, params, sessionId)

    await send('Page.enable')
    await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: `file://${htmlFile}` })
    await waitLoad(send)
    // 量内容实际高度
    const h = await send('Runtime.evaluate', { expression: 'document.body ? document.body.scrollHeight : 0', returnByValue: true })
    const height = Math.max(200, Math.min(30_000, Number(h?.result?.value) + 8))
    // 按实际高度覆盖视口 → 全页截图
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true })
    if (!shot?.data) throw new Error('截图未返回数据')
    fs.writeFileSync(pngFile, Buffer.from(shot.data, 'base64'))
    return pngFile
  } finally {
    cdp.close()
  }
}

/** 建一个 CDP 连接（id/result/error 配对）；send 支持可选 sessionId（flatten 模式）。 */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let seq = 0
  const pending = new Map()
  const send = (method, params = {}, sessionId = null) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    ws.send(JSON.stringify(payload))
  })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`))
      else resolve(msg.result)
    }
  }
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('CDP 连接失败'))
  })
  return { send, close: () => { try { ws.close() } catch { /* noop */ } } }
}

/** 等 document.readyState === 'complete'。 */
async function waitLoad(send) {
  for (let i = 0; i < 50; i++) {
    const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })
    if (r?.result?.value === 'complete') return
    await new Promise((res) => setTimeout(res, 100))
  }
}
