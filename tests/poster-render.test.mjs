import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderPoster, detectBrowser } from '../src/services/poster-render.mjs'

/** 真实渲染集成测试：用本机无头浏览器（Chrome/Edge/chromium）把 HTML 渲染成 PNG。
 * 没有浏览器（如 CI 最小环境）时跳过——渲染服务本身已在生产实测。 */
test('renderPoster renders an HTML poster into a PNG long-image', { skip: !detectBrowser() ? 'no headless browser available' : false }, async () => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;box-sizing:border-box}
body{width:750px;font-family:sans-serif;background:#0d1020;color:#fff}
.wrap{padding:30px}
h1{font-size:40px;margin-bottom:20px}
.item{display:flex;gap:16px;background:rgba(255,255,255,.06);border-radius:16px;padding:20px;margin-bottom:14px}
.item .no{flex:none;width:44px;height:44px;border-radius:12px;background:#4a67e8;display:flex;align-items:center;justify-content:center;font-weight:800}
</style></head><body><div class="wrap">
<h1>测试海报 · 中文渲染</h1>
<div class="item"><div class="no">01</div><div><b>台积电加速布局CPO</b><br>光互连有望复刻“摩尔定律”</div></div>
<div class="item"><div class="no">02</div><div><b>智谱完成约50亿美元融资</b><br>加码下一代GLM</div></div>
</div></body></html>`
  const out = path.join(os.tmpdir(), `poster-it-${Date.now()}.png`)
  try {
    const png = await renderPoster(html, { width: 750, outPath: out })
    assert.equal(png, out)
    const buf = fs.readFileSync(out)
    // PNG magic + 尺寸
    assert.equal(buf[0], 0x89)
    assert.equal(buf[1], 0x50)
    assert.equal(buf[2], 0x4e)
    assert.equal(buf[3], 0x47)
    // 宽度 750（IHDR 宽字段，大端 uint32，偏移 16）
    assert.equal(buf.readUInt32BE(16), 750)
    const height = buf.readUInt32BE(20)
    assert.ok(height > 200 && height < 2000, `height=${height}`)
  } finally {
    fs.rmSync(out, { force: true })
  }
})
