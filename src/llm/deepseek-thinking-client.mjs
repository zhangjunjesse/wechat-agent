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
      let k = 0
      const messages = body.messages.map((m) => {
        if (m && m.role === 'assistant') {
          const idx = k++
          // Only inject when the message doesn't already carry it (the SDK's
          // content branch already round-trips it via providerData).
          if (!('reasoning_content' in m) && idx < rc.length) {
            return { ...m, reasoning_content: rc[idx] }
          }
        }
        return m
      })
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
    })
  }

  return { client, reset: () => { rc.length = 0 } }
}
