import { tool } from '@openai/agents'
import { expiryClock } from '../llm/model-routing-agent.mjs'

/** 专家模式工具（ADR-0033 的**兜底**路径）。
 *
 * 主路径是 `ModelRoutingAgent` 里的快捷命令精确匹配（"切换到专家模式"等），它在
 * 任何 LLM 调用之前就把请求截住，零 token、零延迟、结果确定。这个工具存在只为
 * 接住那些不长成命令的说法——"开个专家模式吧""换个更聪明的模型试试"。
 *
 * **它有一个无法回避的局限，必须如实告诉用户**：本轮对话已经由**默认模型**接手
 * 了（工具是在这轮 run 里被调用的，模型在调用工具那一刻就已经定了），所以切换
 * 只能从**下一条消息**开始生效。工具的返回文本因此明确要求模型这么转述——诚实
 * 地说"下一条开始"比让用户以为这条回复已经是专家模型写的要好。
 *
 * 两条路径写的是**同一个** `ExpertModeStore`：谁是"这个用户当前在不在专家模式"
 * 这件事的 owner，只有它一个。 */
export function expertModeTools({ store, ttlMs = 60 * 60_000, expertModel = '' } = {}) {
  const minutes = Math.max(1, Math.round(Number(ttlMs) / 60_000))

  const setExpertMode = tool({
    name: 'set_expert_mode',
    description:
      `为当前用户开启或关闭「专家模式」（开启后改用更强的模型${expertModel ? `（${expertModel}）` : ''}回答，${minutes} 分钟后自动恢复默认模型）。` +
      '用户用自然语言表达"开个专家模式吧""换个更强/更聪明的模型""这个问题难，用好点的模型""不用专家模式了"时调用。' +
      '⚠️ 用户如果原样说出"切换到专家模式""退出专家模式"这类固定说法，系统会在更前面就直接处理掉，根本轮不到这个工具——' +
      '所以你会看到它，说明用户用的是自由说法。' +
      '⚠️ 重要限制：本轮回复仍由当前模型生成，切换从用户的**下一条消息**才开始生效；' +
      '把结果转述给用户时必须说清楚这一点，不要声称这条回复已经是新模型写的。',
    parameters: {
      type: 'object',
      properties: {
        enable: { type: 'boolean', description: 'true = 开启专家模式；false = 关闭、恢复默认模型' },
      },
      required: ['enable'],
    },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      if (!store) return '专家模式未启用（服务端未配置专家模型），无法切换。请如实告诉用户这个功能当前不可用。'
      if (!userId) return '拿不到当前用户身份，无法切换专家模式。'
      if (input.enable) {
        const wasActive = store.isActive(userId)
        const expiresAt = store.enable(userId, ttlMs)
        return (wasActive
          ? `用户本来就在专家模式，已重新计时 ${minutes} 分钟，到期时间刷新为 ${expiryClock(expiresAt)}（北京时间）。`
          : `已为该用户开启专家模式，${minutes} 分钟后（${expiryClock(expiresAt)}，北京时间）自动恢复默认模型。`) +
          '\n⚠️ 本轮回复仍由当前模型生成，更强的模型从用户的下一条消息开始生效——请如实这样告诉用户。'
      }
      const was = store.disable(userId)
      return was
        ? '已关闭该用户的专家模式，从下一条消息起恢复默认模型。请如实告诉用户"下一条开始恢复"。'
        : '该用户当前就在默认模式，无需关闭。请如实告诉用户他本来就没在专家模式。'
    },
  })

  return { setExpertMode }
}
