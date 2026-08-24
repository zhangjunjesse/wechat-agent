/**
 * Provider-neutral contract for a WeChat Bot integration.
 * A real adapter must implement these methods without leaking provider
 * identifiers into the tenant/application layer.
 */

export const BindingStatus = Object.freeze({
  PENDING: 'pending',
  SCANNED: 'scanned',
  BOUND: 'bound',
  EXPIRED: 'expired',
  FAILED: 'failed',
})

export function assertBotProfile(profile) {
  if (!profile || typeof profile !== 'object') throw new TypeError('profile is required')
  for (const key of ['providerUserId', 'nickname']) {
    if (typeof profile[key] !== 'string' || !profile[key].trim()) {
      throw new TypeError(`profile.${key} is required`)
    }
  }
  return {
    providerUserId: profile.providerUserId,
    username: typeof profile.username === 'string' ? profile.username : '',
    nickname: profile.nickname,
    avatarUrl: typeof profile.avatarUrl === 'string' ? profile.avatarUrl : '',
  }
}

export function assertInboundEvent(event) {
  if (!event || typeof event !== 'object') throw new TypeError('event is required')
  for (const key of ['providerBotId', 'providerMessageId', 'providerUserId', 'text']) {
    if (typeof event[key] !== 'string' || !event[key].trim()) {
      throw new TypeError(`event.${key} is required`)
    }
  }
  return {
    providerBotId: event.providerBotId,
    providerMessageId: event.providerMessageId,
    providerUserId: event.providerUserId,
    text: event.text,
    occurredAt: Number.isFinite(event.occurredAt) ? event.occurredAt : Date.now(),
  }
}

/** @typedef {{createBindingQr(input): Promise<{bindingRef:string, qrPayload:string, expiresAt:number}>, getBindingStatus(input): Promise<{status:string, providerBotId?:string, profile?:object}>, sendText(input): Promise<{providerMessageId:string}>}} BotProvider */
