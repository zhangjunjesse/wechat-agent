/** 记忆侧统一 LLM 调用入口（提取 / 聚类 / 泛化 / 档案 / 摘要共用）。
 *
 * 三条实测结论（2026-09-15，deepseek-flash @ 线上网关）：
 *   1. 该模型**默认思考模式**，且思考 token 计入 `max_tokens`。真实长 prompt（19 条记忆）
 *      一次思考要 1600-1800 tokens —— `max_tokens=1600` 时思考吃光配额，返回
 *      `finish_reason=length` 且 **content 为空**。表面症状是"档案 unparsable"、
 *      "提取什么都没提出来"，根因却是配额被思考占用。
 *   2. 顶层参数 `reasoning_effort: 'none'` **确实关闭思考**：同一任务 reasoning_tokens
 *      261 → 0、completion 24 tokens（约省 10 倍），输出质量不变。
 *      （`extra_body` 里的 chat_template_kwargs / thinking / reasoning_effort 均无效。）
 *   3. 记忆侧任务（结构化提取、合并、泛化、写档案、写摘要）都是确定性转换，不需要思考，
 *      因此**统一关闭**；主对话（agents SDK 的 run）不受影响，仍保留思考能力。
 *
 * 兼容性：网关若不认 `reasoning_effort`，自动去掉该参数重试一次（换模型/换网关不炸）。 */

export function createMemoryComplete(llm, { model, reasoningEffort = 'none' } = {}) {
  if (!llm?.chat?.completions?.create) throw new TypeError('llm client is required')
  return async function memoryComplete(messages, opts = {}) {
    const payload = {
      model,
      messages,
      temperature: opts.temperature ?? 0,
      max_tokens: opts.maxTokens ?? 600,
    }
    try {
      const first = await llm.chat.completions.create({ ...payload, reasoning_effort: opts.reasoningEffort ?? reasoningEffort })
      return (first.choices?.[0]?.message?.content || '').trim()
    } catch (error) {
      if (!isUnsupportedParam(error)) throw error
      const retry = await llm.chat.completions.create(payload)
      return (retry.choices?.[0]?.message?.content || '').trim()
    }
  }
}

function isUnsupportedParam(error) {
  const message = String(error?.message || error)
  return /reasoning_effort|unknown (parameter|argument)|unsupported|unrecognized|invalid_request/i.test(message)
}
