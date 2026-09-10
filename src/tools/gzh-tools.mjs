import { tool } from '@openai/agents'
import { getGzhApiKey, gzhSearch as apiSearch, gzhContent as apiContent } from '../services/gzh-api.mjs'

/** 微信公众号搜索 / 正文抓取工具（ADR-0013，路线 A——Node 直连 RedFoxHub API，
 * 无 Python 依赖）。由 wechat-gzh-research 技能（SKILL.md 编排）或模型直接使用。
 *
 * `search`/`content` 可注入（测试用 mock）；默认走 gzh-api.mjs 的真实实现。 */
export function gzhTools({ search = apiSearch, content = apiContent, getKey = getGzhApiKey } = {}) {
  const gzhSearch = tool({
    name: 'gzh_search',
    description:
      '搜索微信公众号文章列表（关键词 ≤ 10 个字符）。返回标题/公众号/摘要/阅读/点赞/发布时间/链接/workUuid（不含正文）。' +
      '同一个话题建议换多个说法分别搜索再合并评估；评估结果后只对精选的文章用 gzh_content 抓正文。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词，不超过 10 个字符（长话题拆成短词）' },
        count: { type: 'number', description: '返回条数，默认 15，最多 50' },
      },
      required: ['keyword'],
    },
    execute: async (input) => {
      const key = getKey()
      if (!key) return '未配置 RedFoxHub API Key：请设置环境变量 REDFOX_API_KEY，或在 ~/.qoder/apis/redfox.json 写入 {"api_key": "ak_xxx"}（https://redfox.hk/settings/api-keys 获取）。'
      try {
        const count = Math.min(Math.max(Number(input.count) || 15, 1), 50)
        const articles = await search({ keyword: input.keyword, count, apiKey: key })
        if (!articles.length) return `关键词「${input.keyword}」没有搜到结果，可以换个说法重试。`
        const lines = articles.map((a, i) => `${i + 1}. ${a.title}\n   公众号：${a.author || '未知'}｜阅读：${a.readCount ?? '-'}｜赞：${a.likeCount ?? '-'}｜时间：${a.publishTime || '-'}\n   workUuid: ${a.workUuid}\n   ${a.summary || ''}`)
        return `关键词「${input.keyword}」搜到 ${articles.length} 条：\n${lines.join('\n')}`
      } catch (e) {
        return `搜索失败：${e.message}`
      }
    },
  })

  const gzhContent = tool({
    name: 'gzh_content',
    description:
      '按 workUuid（来自 gzh_search 结果）抓取一篇公众号文章的完整正文，用于核实内容是否真的相关、提炼要点。' +
      '每抓一篇消耗一次额外 API 额度，只对精选的少量文章调用。',
    parameters: {
      type: 'object',
      properties: { workUuid: { type: 'string', description: 'gzh_search 返回的 workUuid' } },
      required: ['workUuid'],
    },
    execute: async (input) => {
      const key = getKey()
      if (!key) return '未配置 RedFoxHub API Key：请设置环境变量 REDFOX_API_KEY，或在 ~/.qoder/apis/redfox.json 写入 {"api_key": "ak_xxx"}。'
      try {
        const doc = await content({ workUuid: input.workUuid, apiKey: key })
        const head = `标题：${doc.title}\n公众号：${doc.author}｜时间：${doc.publishTime || '-'}\n链接：${doc.url || '-'}\n正文长度：${doc.contentLength} 字符\n`
        const body = doc.content || '(无正文)'
        return `${head}\n--- 正文 ---\n${body}`
      } catch (e) {
        return `抓取失败：${e.message}`
      }
    },
  })

  return { gzhSearch, gzhContent }
}
