import OpenAI from 'openai'
import { Agent, OpenAIChatCompletionsModel, run } from '@openai/agents'
import { SessionStore } from '../services/session-store.mjs'
import { MemoryStore } from '../services/memory-store.mjs'
import { SessionCompactor, buildSummarizePrompt } from './session-compactor.mjs'
import { MemoryExtractor } from './memory-extractor.mjs'
import { MemoryManager } from './memory-manager.mjs'
import { buildBaseInstructions, buildDynamicSystem } from './system-prompt.mjs'
import { buildUseSkillTool } from '../tools/misc-tools.mjs'
import { wrapClientForDeepSeek } from './deepseek-thinking-client.mjs'

export class AgentsSdkAgent {
  #sessions
  #compactor
  #llm
  #memory
  #skillRegistry
  #staticTools
  #makeAgent
  #resetThinking

  constructor({ model, baseUrl = 'https://api.openai.com/v1', apiKey = process.env.OPENAI_API_KEY, sessionStore = null, memoryStore = null, tokenBudget = 128_000, threshold = 0.8, keepTurns = 30, tools = [], skillRegistry = null }) {
    // DeepSeek thinking-mode compat: the model runs on a wrapped client that
    // round-trips `reasoning_content` through multi-turn tool calls (see
    // deepseek-thinking-client.mjs); memory/summarize calls keep the raw
    // client so they never inherit the agent loop's reasoning cache.
    const rawClient = new OpenAI({ apiKey, baseURL: baseUrl })
    const { client: modelClient, reset: resetThinking } = wrapClientForDeepSeek(rawClient)
    this.#resetThinking = resetThinking
    this.#llm = rawClient
    const sdkModel = new OpenAIChatCompletionsModel(modelClient, model)
    this.#skillRegistry = skillRegistry
    // Agent is a stateless definition; build one per call so tools can carry
    // per-user sandboxing through run context (ctx.context.userId), and so the
    // use_skill catalog in its tool description can vary per user (ADR-0013:
    // per-user skill isolation + progressive loading). Safety rules + role
    // behavior are fixed; the skill catalog is computed per-turn in respond().
    this.#staticTools = tools
    this.#makeAgent = (instructions, tools) => new Agent({ name: '微信个人助手', model: sdkModel, instructions, tools })
    this.#sessions = sessionStore || new SessionStore({ file: process.env.SESSIONS_FILE || 'data/sessions.db' })
    this.#compactor = new SessionCompactor({ summarize: async (turns) => this.#summarize(turns), tokenBudget, threshold, keepTurns })
    this.#memory = new MemoryManager({ store: memoryStore || new MemoryStore({ file: process.env.MEMORIES_FILE || 'data/memories.db' }), extractor: new MemoryExtractor({ complete: (messages, opts) => this.#complete(messages, opts) }) })
  }

  async #summarize(turns) {
    try {
      const resp = await this.#llm.chat.completions.create({ model: process.env.OPENAI_MODEL || 'deepseek-flash', messages: [{ role: 'user', content: buildSummarizePrompt(turns) }], temperature: 0, max_tokens: 800 })
      return (resp.choices?.[0]?.message?.content || '').trim()
    } catch (e) { return '' }
  }

  async #complete(messages, { temperature = 0, maxTokens = 600 } = {}) {
    const resp = await this.#llm.chat.completions.create({ model: process.env.OPENAI_MODEL || 'deepseek-flash', messages, temperature, max_tokens: maxTokens })
    return (resp.choices?.[0]?.message?.content || '').trim()
  }

  async respond({ userId, text, profile, channel = null, attachments = [] }) {
    if (!profile?.nickname && !profile?.wxid) return { text: '请先完成身份验证。请在网页中添加微信“助手”，并向助手发送页面显示的验证码。验证通过后，我才能为你提供服务。' }
    const session = this.#sessions.get(userId)
    const memories = this.#memory.recall(userId)
    const attachmentText = attachments.length
      ? `\n\n本轮已收到附件：\n${attachments.map((a) => `- ${a.name || '未命名'}（路径：${a.path || '不可用'}，大小：${a.size || '未知'}字节）`).join('\n')}\n附件未被实际工具读取前，不要声称已经看过内容。`
      : ''
    const context = buildDynamicSystem({
      nickname: profile?.nickname || '',
      assistantName: this.#memory.assistantName(userId),
      memories,
      summary: session.summary || '',
      nowMs: Date.now(),
    })
    const enabledGlobal = this.#skillRegistry?.resolveEnabled(profile?.enabledSkills)
    // Fresh reasoning cache per run: multi-turn tool calls inside this run
    // round-trip reasoning_content; nothing leaks into the next run.
    this.#resetThinking?.()
    // Progressive skill loading (ADR-0013): the system prompt only points at
    // use_skill; the tool description carries this user's catalog (name +
    // one-liner), and full instructions are loaded on demand. Rebuilt per
    // turn so the catalog reflects current skills and this user's enablement.
    const useSkillTool = this.#skillRegistry
      ? buildUseSkillTool({ skillRegistry: this.#skillRegistry, catalog: this.#skillRegistry.catalogForTool(userId, enabledGlobal) })
      : null
    const tools = useSkillTool ? [...this.#staticTools, useSkillTool] : this.#staticTools
    const instructions = buildBaseInstructions()
    // loadedSkills is a fresh Set per turn: use_skill uses it to avoid
    // re-returning the same skill's full instructions if the model calls it
    // more than once while working through one user message.
    const result = await run(this.#makeAgent(instructions, tools), [{ role: 'system', content: context + attachmentText }, ...session.transcript, { role: 'user', content: text }], { context: { userId, profile, loadedSkills: new Set(), channel, attachments } })
    const answer = typeof result.finalOutput === 'string' ? result.finalOutput : String(result.finalOutput || '')

    let { transcript } = this.#sessions.append(userId, text, answer, attachments)
    if (this.#compactor.needsFold(transcript)) {
      const folded = await this.#compactor.fold(transcript, session.summary)
      this.#sessions.fold(userId, folded.summary, folded.keptTranscript)
    }
    this.#memory.absorb(userId, text, answer).catch(() => {})
    return { text: answer }
  }
}
