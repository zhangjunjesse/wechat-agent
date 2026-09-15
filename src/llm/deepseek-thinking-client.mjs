/** DeepSeek thinking-mode 兼容层（chat completions 方向）。
 *
 * 问题：deepseek-flash / deepseek-v4-pro 默认开启思考模式，响应会带
 * `message.reasoning_content`（思维链）。DeepSeek 要求**带 tools 的请求必须把
 * 之前所有轮次的 `reasoning_content` 原样回传**，否则 400：
 *   "The reasoning_content in the thinking mode must be passed back to the API."
 * OpenAI Agents SDK 在工具调用轮次会把该字段丢掉（assistant 消息只输出
 * function_call items），导致 agent 多轮工具调用必然 400。
 *
 * 方案（不改 node_modules）：包装 OpenAI client 的 chat.completions.create——
 * 响应时把 `reasoning_content` 按 assistant 消息出现顺序缓存；请求时按同一顺序
 * 回填到对应 assistant 消息（消息列表是追加式的，顺序匹配稳定）。缓存生命周期
 * 由调用方控制：一次 agent run 开头 reset()，run 内多轮工具调用正确回传，不
 * 污染 run 之外的内存抽取/摘要等独立调用（那些用原始 client）。
 *
 * 仅处理非流式（Agents SDK 默认 getResponse 非流式；本仓库未开 stream）。 */
export function wrapClientForDeepSeek(client) {
  const rc = [] // reasoning_content cache, ordered by assistant-message occurrence
  const completions = client.chat.completions
  const originalCreate = completions.create.bind(completions)

  completions.create = (body, options) => {
    let injected = body
    if (body && Array.isArray(body.messages) && rc.length > 0) {
      // 注入必须**从尾部对齐**：rc 缓存的是"本次 run 内"产生的 reasoning，而本次 run
      // 产生的 assistant 消息总在请求的尾部（历史消息在其前面）。早期版本从第 1 条
      // assistant 开始填，会把本轮 reasoning 错填到最早的历史消息上，导致本轮
      // tool_calls 消息缺 reasoning_content → DeepSeek 400（生产实测：232 条消息里
      // 113 条历史 + 1 条本轮工具调用，注入打在了"今天是星期四。"上）。
      const assistantIdx = []
      for (let i = 0; i < body.messages.length; i++) {
        if (body.messages[i]?.role === 'assistant') assistantIdx.push(i)
      }
      const offset = assistantIdx.length - rc.length
      const messages = [...body.messages]
      for (let j = 0; j < rc.length; j++) {
        const at = offset + j
        if (at < 0) continue // 历史比缓存还少（异常），跳过
        const i = assistantIdx[at]
        const m = messages[i]
        // Only inject when the message doesn't already carry it (the SDK's
        // content branch already round-trips it via providerData).
        if (m && !('reasoning_content' in m)) messages[i] = { ...m, reasoning_content: rc[j] }
      }
      injected = { ...body, messages }
    }
    const promise = originalCreate(injected, options)
    // Capture reasoning_content from the (non-streamed) response. JSON.parse
    // keeps unknown fields, so message.reasoning_content survives here.
    return promise.then((res) => {
      const msg = res?.choices?.[0]?.message
      if (msg && typeof msg.reasoning_content === 'string' && msg.reasoning_content) {
        rc.push(msg.reasoning_content)
      }
      return res
    }).catch((err) => {
      // 现场诊断（生产实测 400 reasoning_content，定位请求结构差异用）
      if (String(err?.message || '').includes('reasoning_content')) {
        const msgs = body?.messages || []
        const asIdx = msgs.map((m, i) => (m?.role === 'assistant' ? i : -1)).filter((i) => i >= 0)
        const show = (m) => JSON.stringify(m).slice(0, 400)
        console.error(`[thinking-400] rc_len=${rc.length} msg_count=${msgs.length} assistant_count=${asIdx.length}\n  first_as: ${show(msgs[asIdx[0]])}\n  last_as: ${show(msgs[asIdx[asIdx.length - 1]])}`)
      }
      throw err
    })
  }

  return { client, reset: () => { rc.length = 0 } }
}
