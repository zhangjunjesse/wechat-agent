import test from 'node:test'
import assert from 'node:assert/strict'
import { BindingService } from '../src/services/binding-service.mjs'
import { MessageRouter } from '../src/services/message-router.mjs'
import { MockBotProvider } from '../src/providers/mock-provider.mjs'

const profile = { providerUserId: 'wx-user-1', username: 'alice_wx', nickname: 'Alice', avatarUrl: '' }

test('binding status and profile are tenant-owned', async () => {
  const provider = new MockBotProvider()
  const service = new BindingService({ provider })
  const pending = await service.start('tenant-a')
  assert.equal(pending.status, 'pending')
  provider.bind(pending.providerRef, { botId: 'bot-a', profile })
  const bound = await service.refresh('tenant-a', pending.id)
  assert.equal(bound.status, 'bound')
  assert.equal(bound.profile.username, 'alice_wx')
  assert.throws(() => service.get('tenant-b', pending.id), /binding not found/)
})

test('router isolates bots and deduplicates provider event ids', async () => {
  const bindings = [{ userId: 'tenant-a', providerBotId: 'bot-a', profile }]
  const provider = new MockBotProvider()
  const calls = []
  const router = new MessageRouter({
    bindings, provider, requireVerified: false,
    agent: { async respond(input) { calls.push(input); return { text: `echo:${input.text}` } } },
  })
  const event = { providerBotId: 'bot-a', providerMessageId: 'm-1', providerUserId: profile.providerUserId, text: 'hello' }
  assert.deepEqual(await router.handleInbound(event), { accepted: true, duplicate: false, providerMessageId: 'out-1', text: 'echo:hello' })
  assert.deepEqual(await router.handleInbound(event), { accepted: true, duplicate: true })
  assert.deepEqual(await router.handleInbound({ ...event, providerBotId: 'other-bot' }), { accepted: false, reason: 'unknown_bot' })
  assert.equal(calls.length, 1)
})

test('router rejects an event from a different WeChat user', async () => {
  const provider = new MockBotProvider()
  const router = new MessageRouter({
    bindings: [{ userId: 'tenant-a', providerBotId: 'bot-a', profile }], provider,
    agent: { async respond() { return { text: 'should not run' } } },
  })
  const result = await router.handleInbound({ providerBotId: 'bot-a', providerMessageId: 'm-2', providerUserId: 'wx-other', text: 'x' })
  assert.deepEqual(result, { accepted: false, reason: 'user_mismatch' })
})
