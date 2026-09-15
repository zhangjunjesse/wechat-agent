import fs from 'node:fs'

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
    if (body && Array.isArray(body.messages)) {
      // 注入规则（生产实测得出，见 docs/STATUS.md 与事故回归测试）：
      //   DeepSeek 只对**带 tool_calls 的 assistant 消息**要求 reasoning_content；
      //   而本轮 run 产生的 tool_calls 消息数量**可能多于**缓存的 reasoning 条数
      //   （某轮响应没有/为空 reasoning、或缓存被并发 reset），数量对齐会漏掉较早的那条
      //   → 400。因此分两步：
      //   ① 尾部对齐注入真实 reasoning（本轮产生的 assistant 总在请求末尾）；
      //   ② **兜底**：任何仍缺 reasoning_content 的 tool_calls 消息补占位值——
      //      实测 DeepSeek 不校验 reasoning_content 的具体文本，只要求字段存在。
      const assistantIdx = []
      for (let i = 0; i < body.messages.length; i++) {
        if (body.messages[i]?.role === 'assistant') assistantIdx.push(i)
      }
      const hasToolCallMsg = assistantIdx.some((i) => body.messages[i]?.tool_calls?.length)
      if (rc.length > 0 || hasToolCallMsg) {
        const messages = [...body.messages]
        // ① 尾部对齐注入真实 reasoning（注意：**空值也算缺失**——SDK 可能自带
        //    reasoning_content: null，用 `in` 判断会放过它 → DeepSeek 400）
        const offset = assistantIdx.length - rc.length
        for (let j = 0; j < rc.length; j++) {
          const at = offset + j
          if (at < 0) continue
          const i = assistantIdx[at]
          const m = messages[i]
          if (m && !m.reasoning_content) messages[i] = { ...m, reasoning_content: rc[j] }
        }
        // ② 兜底：tool_calls 消息一律不能缺/不能为空 reasoning_content（rc 为空时也补）
        const fallback = rc[rc.length - 1] || '（思考过程已省略）'
        for (const i of assistantIdx) {
          const m = messages[i]
          if (m?.tool_calls?.length && !m.reasoning_content) {
            messages[i] = { ...m, reasoning_content: fallback }
          }
        }
        injected = { ...body, messages }
      }
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
      // 现场诊断（生产实测 400 reasoning_content）：打印**注入后**的结构并落盘完整请求，
      // 避免再靠推断（此前只看得到注入前的 body，导致多轮误判）。
      if (String(err?.message || '').includes('reasoning_content')) {
        const msgs = injected?.messages || []
        const tcMsgs = msgs.filter((m) => m?.role === 'assistant' && m?.tool_calls?.length)
        console.error(`[thinking-400] rc_len=${rc.length} msgs=${msgs.length} toolcall_msgs=${tcMsgs.length}`)
        for (const [i, m] of tcMsgs.slice(-3).entries()) {
          console.error(`  tc#${i} reasoning=${JSON.stringify(m.reasoning_content ?? null).slice(0, 60)} keys=${Object.keys(m).join(',')}`)
        }
        try {
          const file = `/data/thinking-400-${Date.now()}.json`
          fs.writeFileSync(file, JSON.stringify({ rcLen: rc.length, msgs: msgs.length, toolcallMsgs: tcMsgs.length, messages: msgs }))
          console.error(`  [thinking-400] full request saved: ${file}`)
        } catch { /* 落盘失败不致命 */ }
      }
      throw err
    })
  }

  return { client, reset: () => { rc.length = 0 } }
}
