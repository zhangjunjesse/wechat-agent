import { beijingParts } from '../services/time.mjs'

/** 专家模式的快捷命令短语表（ADR-0033）。
 *
 * 精确匹配 `text.trim()`，不做模糊/包含匹配——"帮我查一下专家模式是什么意思"
 * 不应该把人切走。想让自然语言也能触发，走的是 `set_expert_mode` 工具那条路
 * （`src/tools/expert-mode-tools.mjs`），不是把这张表放宽。 */
export const EXPERT_ON_PHRASES = ['切换到专家模式', '专家模式', '开启专家模式', '打开专家模式', '进入专家模式']
export const EXPERT_OFF_PHRASES = ['退出专家模式', '关闭专家模式', '恢复默认模式', '普通模式', '默认模式']

/** 按用户的专家模式状态把 `respond()` 路由到不同模型的包装 agent（ADR-0033）。
 *
 * 它自己**不是** agent：没有模型、没有工具、不碰 session/记忆，只做两件事——
 *   ① 在把请求交给任何 LLM **之前**拦下快捷命令（零 token、零延迟、结果确定）；
 *   ② 按 `ExpertModeStore` 的状态决定这一轮交给 `defaultAgent` 还是 `expertAgent`。
 * 其余参数（userId/text/profile/channel/attachments/ephemeral…）原样透传，返回值
 * 原样透回，所以 `MessageRouter` / `/api/chat` / `GroupCommandWatcher` 三个调用
 * 方一行都不用改——它们看到的仍然只是"一个有 respond() 的东西"。
 *
 * 两个内层 agent 必须共用同一份 `sessionStore`/`memoryStore`（见 server.mjs 的
 * `sessionOpts`）：模型换了，对话历史和长期记忆不能跟着换，否则用户切一次模式
 * 就像换了一个助手。
 *
 * 未配置专家模型（`expertAgent` 为空）时**纯透传**：连快捷命令都不拦——不能出现
 * "系统说已切换、实际什么都没变"的假承诺，也不能让一个没配置的可选特性影响
 * 服务启动（同 lark/vision 的条件启用模式）。 */
export class ModelRoutingAgent {
  #defaultAgent
  #expertAgent
  #store
  #ttlMs

  constructor({ defaultAgent, expertAgent = null, store = null, ttlMs = 60 * 60_000 }) {
    if (!defaultAgent) throw new Error('ModelRoutingAgent requires defaultAgent')
    this.#defaultAgent = defaultAgent
    this.#expertAgent = expertAgent
    this.#store = store
    this.#ttlMs = Number(ttlMs) || 60 * 60_000
  }

  /** 这个包装是否真的在起作用（未配置专家模型时为 false = 纯透传）。 */
  get enabled() {
    return Boolean(this.#expertAgent && this.#store)
  }

  async respond(args) {
    if (!this.enabled) return this.#defaultAgent.respond(args)
    const userId = args?.userId
    // ephemeral = 定时任务/子 agent 的系统侧单轮执行（合成用户），那里没有"用户
    // 打字"这回事，快捷命令不应该在那条路上被匹配到。
    if (userId && !args?.ephemeral) {
      const shortcut = this.#handleShortcut(userId, args?.text)
      if (shortcut) return shortcut
    }
    const agent = userId && this.#store.isActive(userId) ? this.#expertAgent : this.#defaultAgent
    return agent.respond(args)
  }

  /** 命中开关短语则直接改状态并返回确认文本（不调用任何 LLM）；否则返回 null。 */
  #handleShortcut(userId, text) {
    const phrase = String(text ?? '').trim()
    if (!phrase) return null
    if (EXPERT_ON_PHRASES.includes(phrase)) {
      const wasActive = this.#store.isActive(userId)
      const expiresAt = this.#store.enable(userId, this.#ttlMs)
      return { text: wasActive ? refreshedText(expiresAt, this.#ttlMs) : enabledText(expiresAt, this.#ttlMs) }
    }
    if (EXPERT_OFF_PHRASES.includes(phrase)) {
      const was = this.#store.disable(userId)
      return { text: was ? '已退出专家模式，之后的对话恢复默认模型。' : '你现在就在默认模式，不用退出。想用更强的模型，回我「切换到专家模式」。' }
    }
    return null
  }
}

/** 到期时刻的北京时间 `HH:MM`（与仓库其余面向用户的时间文案同一时区口径，
 * 见 services/time.mjs：容器是 UTC，时区固定在代码里而不是容器 TZ 里）。 */
export function expiryClock(expiresAt) {
  const p = beijingParts(expiresAt)
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}

function minutesOf(ttlMs) {
  return Math.max(1, Math.round(Number(ttlMs) / 60_000))
}

function enabledText(expiresAt, ttlMs) {
  return `已切换到专家模式，接下来 ${minutesOf(ttlMs)} 分钟我会用更强的模型回答你。\n将在 ${expiryClock(expiresAt)} 自动恢复默认模型；想提前恢复，回我「退出专家模式」。`
}

function refreshedText(expiresAt, ttlMs) {
  return `你已经在专家模式里了，已重新计时 ${minutesOf(ttlMs)} 分钟。\n将在 ${expiryClock(expiresAt)} 自动恢复默认模型；想提前恢复，回我「退出专家模式」。`
}
