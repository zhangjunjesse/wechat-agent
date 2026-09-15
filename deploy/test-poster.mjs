import { renderPoster } from '/app/src/services/poster-render.mjs'
const html = '<!doctype html><html><head><meta charset="utf-8"><style>body{width:750px;background:#0d1020;color:#fff;font-family:"PingFang SC","Microsoft YaHei",sans-serif;padding:40px}h1{font-size:52px;margin-bottom:16px}.c{background:rgba(255,255,255,.06);border-radius:16px;padding:20px;margin-bottom:12px;font-size:22px}</style></head><body><h1>中文测试海报</h1><div class="c">台积电加速布局CPO，光互连有望复刻"摩尔定律"</div><div class="c">智谱完成约50亿美元股债融资，加码下一代GLM</div></body></html>'
try {
  const out = await renderPoster(html, { width: 750, outPath: '/tmp/container-poster-test.png' })
  const { statSync } = await import('node:fs')
  const st = statSync(out)
  console.log('RENDER_OK', out, st.size, 'bytes')
} catch (e) {
  console.error('RENDER_FAIL', e.message)
  process.exit(1)
}
