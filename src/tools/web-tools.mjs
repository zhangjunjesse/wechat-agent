import { tool } from '@openai/agents'
import dns from 'node:dns/promises'
import net from 'node:net'

/** Web tools with SSRF protection: resolve the host and reject private/loopback
 * addresses before fetching, so a user message can't make the server probe
 * internal services. get_weather uses Open-Meteo (no key required). */
export function webTools({ fetchImpl = globalThis.fetch } = {}) {
  const safeHost = async (url) => {
    const u = new URL(url)
    const host = u.hostname
    const addrs = await dns.lookup(host, { all: true }).catch(() => [])
    for (const a of addrs) {
      const ip = a.address
      if (isPrivateIp(ip)) throw new Error('目标地址不允许访问（内网/保留地址）')
    }
    return host
  }

  const getWeather = tool({
    name: 'get_weather',
    description: '查询指定城市的当前天气（温度、天气状况）。城市用中文名。',
    parameters: { type: 'object', properties: { city: { type: 'string', description: '城市名，如 北京' } }, required: ['city'] },
    execute: async (input) => {
      const city = encodeURIComponent(input.city)
      // geocode
      const geo = await fetchImpl(`https://geocoding-api.open-meteo.com/v1/search?name=${city}&count=1&language=zh&format=json`)
      const geoJson = await geo.json()
      const loc = geoJson?.results?.[0]
      if (!loc) return `未找到城市「${input.city}」`
      const { latitude, longitude, name } = loc
      const w = await fetchImpl(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`)
      const wj = await w.json()
      const cur = wj?.current
      if (!cur) return '天气查询失败'
      return `${name}：${cur.temperature_2m}°C，${weatherDesc(cur.weather_code)}，风速 ${cur.wind_speed_10m} km/h`
    },
  })

  const webFetch = tool({
    name: 'web_fetch',
    description: '抓取一个公开网页的文本内容（用于查资料）。拒绝内网地址。',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    execute: async (input) => {
      await safeHost(input.url)
      const r = await fetchImpl(input.url)
      const text = await r.text()
      const stripped = text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
      return stripped.slice(0, 6000)
    },
  })

  return { getWeather, webFetch }
}

function isPrivateIp(ip) {
  const parts = ip.split('.').map(Number)
  if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0') return true
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('169.254.')) return true
  if (ip.startsWith('172.') && parts[1] >= 16 && parts[1] <= 31) return true
  if (ip.startsWith('100.')) return true
  if (ip.includes(':')) return true // block all IPv6 (safe default)
  return false
}

function weatherDesc(code) {
  const map = { 0: '晴', 1: '大部晴朗', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇', 51: '毛毛雨', 53: '小雨', 55: '中雨', 61: '小雨', 63: '中雨', 65: '大雨', 71: '小雪', 73: '中雪', 75: '大雪', 80: '阵雨', 81: '阵雨', 82: '强阵雨', 95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹' }
  return map[code] || '未知'
}
