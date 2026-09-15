/** 长任务进度反馈器（体验层通用组件）。
 *
 * 问题：agent 处理多步任务（查记录/读文档/导出文件）常需几十秒到几分钟，
 * 期间若一声不响，用户不知道是在处理还是挂了，产生不安。
 *
 * 策略（三层，都不依赖模型配合）：
 *   1) 延迟 ack：任务 8 秒仍未完成才发「收到，正在处理」——短任务不打扰；
 *   2) 心跳：超过 intervalMs 后每隔 intervalMs 推一条进度（最多 maxHeartbeats 条）；
 *   3) stop() 时清理定时器；任务失败由调用方发错误提示。
 *
 * 用法：
 *   const p = createProgressNotifier({ provider, channel })
 *   p.start()
 *   try { const r = await work() ; p.stop(); send(r) } catch (e) { p.stop(); send(err) }
 */
export function createProgressNotifier({
  provider,
  channel,
  ackDelayMs = 8_000,
  intervalMs = 40_000,
  maxHeartbeats = 5,
  ackText = '✅ 收到，正在处理，请稍候…（任务内容较多时可能需要一两分钟）',
  heartbeatText = (n, minutes) => `⏳ 仍在处理中（已约 ${minutes} 分钟），请稍候…`,
}) {
  let ackTimer = null
  let heartbeatTimer = null
  let stopped = false
  let startedAt = Date.now()
  let beats = 0

  const send = async (text) => {
    try {
      await provider.sendText({
        providerBotId: channel.providerBotId,
        toProviderUserId: channel.toProviderUserId,
        contextToken: channel.contextToken,
        text,
      })
    } catch { /* 进度提示失败不影响主流程 */ }
  }

  const startHeartbeat = () => {
    if (heartbeatTimer || stopped) return
    heartbeatTimer = setInterval(() => {
      if (stopped || beats >= maxHeartbeats) return
      beats += 1
      const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000))
      void send(heartbeatText(beats, minutes))
    }, intervalMs)
    heartbeatTimer.unref?.()
  }

  return {
    /** 开始计时：ackDelayMs 内未 stop → 发 ack，进而进入心跳。 */
    start() {
      startedAt = Date.now()
      if (!channel?.contextToken || typeof provider?.sendText !== 'function') return
      ackTimer = setTimeout(() => {
        if (stopped) return
        void send(ackText)
        startHeartbeat()
      }, ackDelayMs)
      ackTimer.unref?.()
    },
    /** 任务结束（成功或失败）：停止一切定时提示。 */
    stop() {
      stopped = true
      if (ackTimer) { clearTimeout(ackTimer); ackTimer = null }
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
    },
    /** 是否已经给用户发过 ack（调用方决定是否再补发结果前说明）。 */
    get acked() { return beats > 0 || (ackTimer === null && stopped) },
  }
}
