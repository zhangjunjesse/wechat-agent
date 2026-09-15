import { renderReportPoster } from '../src/services/daily-report.mjs'
import { renderPoster } from '../src/services/poster-render.mjs'

// 用生产 2026-09-15 报告的真实数据，走正式代码链路渲染验收图
const report = {
  id: 'rp-0edff76a-20260915',
  name: '每日早报',
  runAt: 1789457269717,
  focus: '智谱敲定约50亿美元融资、国产大模型资本化提速，脑机接口"AI+医疗器械"标准落地，芯片侧CPO光互连与俄罗斯国产光刻机同步升温。',
  items: [
    { title: '智谱完成约50亿美元股债融资，加码下一代GLM', summary: '智谱AI宣布完成新一轮约50亿美元股债融资，资金将用于下一代GLM大模型的研发与商业化。', source: '首席商业评论', url: 'https://mp.weixin.qq.com/s?__biz=MjM5MjE5ODA4MA==' },
    { title: '全球首个"AI+脑机接口"标准发布：脑电数据集质量有据可依', summary: '首个"AI+脑机接口"行业标准正式发布，为脑电数据集质量评估提供统一依据，推动医疗器械合规落地。', source: '医药经济报', url: 'https://mp.weixin.qq.com/s?__biz=MjM5MTcyMjYxMw==' },
    { title: '台积电加速布局CPO，光互连有望复刻"摩尔定律"', summary: '台积电加快共封装光学（CPO）技术布局，业界认为光互连性能提升有望复刻摩尔定律曲线。', source: '半导体芯闻', url: 'https://mp.weixin.qq.com/s?__biz=MzkzMjQzNTQ1MA==' },
    { title: '俄罗斯首台国产350纳米光刻机进入量产', summary: '俄罗斯首台国产350纳米光刻机宣布进入量产阶段，标志其半导体设备自主化迈出关键一步。', source: '信创世界', url: 'https://mp.weixin.qq.com/s?__biz=MjM5OTk2MzU5Mw==' },
    { title: 'DeepSeek Harness桌面端现身官方仓库，仍为开发者预览', summary: 'DeepSeek Harness桌面端出现在官方仓库中，目前仍处于开发者预览阶段，功能与体验尚未完全开放。', source: '玩转 VS Code', url: 'https://mp.weixin.qq.com/s?__biz=MzU1NjgwNTExNQ==' },
    { title: 'Sam Altman连发声明：AI失控不可接受，前沿实验室须负责', summary: 'Sam Altman连续发声强调AI安全边界，呼吁前沿实验室对模型能力承担更高责任，防范失控风险。', source: '唐说', url: 'https://mp.weixin.qq.com/s?__biz=MzI5MDcxODQ1NA==' },
    { title: '书生-S2正式版开源：Intern-S2-397B上线Hugging Face', summary: '书生系列发布正式版书生-S2，397B参数模型Intern-S2-397B已上线Hugging Face开放下载。', source: '橘鸦 Juya', url: 'https://mp.weixin.qq.com/s?__biz=MzIyMDk0MDY1OA==' },
  ],
}

const html = renderReportPoster(report)
const out = await renderPoster(html, { width: 750, outPath: 'tmp-preview/formal-preview.png' })
console.log('POSTER_OK', out)
