/** 串行执行队列（ADR：deepseek thinking 缓存并发保护）。
 *
 * AgentsSdkAgent 的 respond 用它把每次 agent run 串行化：wrapClientForDeepSeek
 * 的 reasoning_content 缓存假设"同一时刻只有一个 run 在使用该 client"
 * （run 开头 reset + 按消息顺序回填）——并发 run 会互相清缓存导致
 * DeepSeek 400（reasoning_content must be passed back）。串行化后前提成立。
 *
 * 副作用：长 run（如日报生成 1-3 分钟）期间后续 respond 排队等待。
 * 用户量小（个人助手）可接受；正确性优先于吞吐。
 */
export function createSerialQueue() {
  let chain = Promise.resolve()
  return (fn) => {
    const run = chain.then(fn)
    // 失败不阻断后续（错误由调用方各自处理）
    chain = run.then(() => undefined, () => undefined)
    return run
  }
}
