#!/usr/bin/env node
/** 专家模式模型的一次性真实探针（ADR-0033 的验收证据来源）。
 *
 * 要回答的三个问题，全部只能靠真实调用回答，不能靠读代码推断：
 *   (a) `EXPERT_MODEL`（默认 gpt-5.6-sol）在生产网关上真的存在且可用？
 *   (b) **带工具调用**的多轮 agent run 在这套 Agents SDK 栈上真的能跑通？
 *       —— 这是最关键的一条：本仓库历史上三次生产 400 全部出在
 *       `assistant(tool_calls) → tool → assistant` 这条路径上。
 *   (c) 去掉 DeepSeek 包装（ADR-0033 的按模型名 gate）之后不报 400？
 *
 * 做法：用与生产完全同一条链路（`AgentsSdkAgent` → `@openai/agents` 的 `run()`
 * → `OpenAIChatCompletionsModel`）跑一轮，工具集只放**一个**确定性工具
 * `probe_lookup`——它返回一个固定的暗号字符串。模型只有真的调用了工具、真的把
 * 工具结果带进第二轮，最终回答里才可能出现那个暗号。所以"最终回答里有暗号"
 * 就是"工具调用链路走通了"的硬证据，而不是"HTTP 200 所以大概没问题"。
 *
 * 用法（key 绝不进仓库，只从环境变量传）：
 *   OPENAI_API_KEY=... \
 *   OPENAI_BASE_URL=http://120.78.77.32:4000/v1 \
 *   EXPERT_MODEL=gpt-5.6-sol \
 *   node scripts/probe-expert-model.mjs
 *
 * 在生产机上取 key 的方式（不要把值粘到任何文件里）：
 *   export $(grep -E '^OPENAI_(API_KEY|BASE_URL)=' /opt/wechat-agent/server.env | xargs)
 *
 * 副作用：无。session/memory 都指向临时文件，且整轮 run 走 `ephemeral: true`
 * （不落 session、不折叠、不吸收记忆）。退出码 0 = 三个问题都通过。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tool } from '@openai/agents'
import { AgentsSdkAgent } from '../src/llm/agents-sdk-agent.mjs'
import { SessionStore } from '../src/services/session-store.mjs'
import { MemoryStore } from '../src/services/memory-store.mjs'
import { isDeepSeekModel } from '../src/llm/deepseek-thinking-client.mjs'

const apiKey = process.env.OPENAI_API_KEY || ''
const baseUrl = process.env.OPENAI_BASE_URL || 'http://120.78.77.32:4000/v1'
const model = process.env.EXPERT_MODEL || 'gpt-5.6-sol'
if (!apiKey) { console.error('缺 OPENAI_API_KEY（从生产 /opt/wechat-agent/server.env 取，不要写进仓库）'); process.exit(2) }

const SECRET = 'QINGZHOU-7731'
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'expert-probe-'))
let failed = false

console.log(`baseUrl = ${baseUrl}`)
console.log(`model   = ${model}`)
console.log(`deepseek 包装（ADR-0033 的 gate）= ${isDeepSeekModel(model) ? '开（该模型被认作 DeepSeek 系）' : '关（不会注入 reasoning_content）'}`)

/* ---- (a) 模型在网关上存在吗 ---------------------------------------------- */
console.log('\n[1/2] GET /models —— 确认模型可用')
try {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { headers: { authorization: `Bearer ${apiKey}` } })
  const body = await res.json()
  const ids = (body?.data || []).map((m) => m.id)
  console.log(`  HTTP ${res.status}，网关共 ${ids.length} 个模型：${ids.join(', ')}`)
  if (!ids.includes(model)) { console.log(`  ⚠️ ${model} 不在列表里（有的网关不在 /models 里列全，继续跑第 2 步用真实调用确认）`) }
  else console.log(`  ✅ ${model} 在列表中`)
} catch (e) {
  console.log(`  ⚠️ /models 请求失败：${e.message}（不致命，继续第 2 步）`)
}

/* ---- (b)(c) 带工具调用的真实 agent run ------------------------------------ */
console.log('\n[2/2] 真实 agent run（强制一次工具调用）')
const probeLookup = tool({
  name: 'probe_lookup',
  description: '查询「今日暗号」。用户问暗号是什么时必须调用本工具——暗号只存在于这个工具里，你自己不可能知道它。',
  parameters: { type: 'object', properties: { reason: { type: 'string', description: '为什么要查（一句话）' } }, required: ['reason'] },
  execute: async (input) => {
    console.log(`  → 工具被调用了：probe_lookup(reason=${JSON.stringify(input?.reason || '')})`)
    return `今日暗号是 ${SECRET}。请把它原样告诉用户。`
  },
})

const sessionStore = new SessionStore({ file: path.join(tmpDir, 'sessions.db') })
const memoryStore = new MemoryStore({ file: path.join(tmpDir, 'memories.db') })
const agent = new AgentsSdkAgent({
  model,
  baseUrl,
  apiKey,
  sessionStore,
  memoryStore,
  tools: [probeLookup],
})

const started = Date.now()
try {
  const result = await agent.respond({
    userId: 'expert-probe',
    text: '今日暗号是什么？请调用工具查一下，然后把暗号原样告诉我。',
    profile: { nickname: '探针' },
    ephemeral: true,
  })
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`  用时 ${elapsed}s`)
  console.log(`  最终回答：${result.text}`)
  if (String(result.text || '').includes(SECRET)) {
    console.log(`  ✅ 回答里包含暗号 ${SECRET} —— 工具调用 + 多轮回传全链路走通，且没有 400`)
  } else {
    console.log(`  ❌ 回答里没有暗号 ${SECRET} —— 模型可能没调工具，或没把工具结果带回第二轮`)
    failed = true
  }
} catch (e) {
  console.log(`  ❌ run 失败：${e.message}`)
  if (String(e.message || '').includes('reasoning_content')) {
    console.log('     （这条错误说明 DeepSeek 包装仍然套在了非 DeepSeek 模型上——ADR-0033 的 gate 没生效）')
  }
  failed = true
}

// 先关掉 SQLite 句柄再删临时目录：Windows 上进程仍持有句柄时 unlink 会 EBUSY，
// 那会让一次**探针全部通过**的运行以退出码 1 结束——本脚本的契约是"退出码 0 =
// 三个问题都通过"，假失败等于毁掉这个契约，所以这里必须真的关闭，而不是把
// rmSync 包进 try 里吞掉异常。
sessionStore.close()
memoryStore.close()
fs.rmSync(tmpDir, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
