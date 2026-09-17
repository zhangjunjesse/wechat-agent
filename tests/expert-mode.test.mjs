import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { ExpertModeStore } from '../src/services/expert-mode-store.mjs'
import { ModelRoutingAgent, EXPERT_ON_PHRASES, EXPERT_OFF_PHRASES } from '../src/llm/model-routing-agent.mjs'
import { expertModeTools } from '../src/tools/expert-mode-tools.mjs'

/** 专家模式（ADR-0033）：快捷命令 / 惰性过期 / 路由 / per-user 隔离 / 纯透传。 */

const TTL = 60 * 60_000 // 60 分钟，与生产默认一致

function tmpFile() {
  return path.join(os.tmpdir(), `expert-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

/** 可控时钟：测试全程不依赖真实时间。 */
function fakeClock(start = 1_700_000_000_000) {
  let now = start
  return { now: () => now, advance: (ms) => { now += ms } }
}

/** 假 agent：记录每次 respond 的入参，返回可区分的结果。 */
function mockAgent(label) {
  const calls = []
  return {
    label,
    calls,
    async respond(args) { calls.push(args); return { text: `${label}:${args.text}`, from: label } },
  }
}

function setup({ withExpert = true, start } = {}) {
  const file = tmpFile()
  const clock = fakeClock(start)
  const store = new ExpertModeStore({ file, clock: clock.now })
  const def = mockAgent('default')
  const exp = mockAgent('expert')
  const routing = new ModelRoutingAgent({ defaultAgent: def, expertAgent: withExpert ? exp : null, store, ttlMs: TTL })
  return { file, clock, store, def, exp, routing, cleanup: () => fs.rmSync(file, { force: true }) }
}

function callTool(toolFn, input, userId) {
  return toolFn.invoke({ context: { userId } }, JSON.stringify(input))
}

test('快捷命令开启/关闭专家模式，且完全不触发 LLM', async () => {
  const { store, def, exp, routing, cleanup } = setup()
  try {
    for (const phrase of EXPERT_ON_PHRASES) {
      store.disable('u1')
      const r = await routing.respond({ userId: 'u1', text: phrase, profile: { nickname: 'Z' } })
      assert.match(r.text, /专家模式/, `「${phrase}」应被识别为开启命令`)
      assert.equal(store.isActive('u1'), true)
    }
    for (const phrase of EXPERT_OFF_PHRASES) {
      store.enable('u1', TTL)
      const r = await routing.respond({ userId: 'u1', text: phrase, profile: {} })
      assert.match(r.text, /默认模型|默认模式/, `「${phrase}」应被识别为关闭命令`)
      assert.equal(store.isActive('u1'), false)
    }
    // 关键断言：两个 agent 一次都没被调用过——零 token、零延迟
    assert.equal(def.calls.length, 0, '快捷命令不得调用默认模型')
    assert.equal(exp.calls.length, 0, '快捷命令不得调用专家模型')
  } finally { cleanup() }
})

test('开启回复里带具体的恢复时刻（北京时间 HH:MM）', async () => {
  // 2026-09-17 10:00:00 UTC = 北京时间 18:00 → +60min = 19:00
  const start = Date.UTC(2026, 8, 17, 10, 0, 0)
  const { routing, cleanup } = setup({ start })
  try {
    const r = await routing.respond({ userId: 'u1', text: '切换到专家模式' })
    assert.match(r.text, /19:00/, `回复应包含恢复时刻 19:00，实际：${r.text}`)
    assert.match(r.text, /60 分钟/)
  } finally { cleanup() }
})

test('惰性过期：59 分钟仍走专家 agent，60 分钟自动回到默认 agent（无任何定时器）', async () => {
  const { clock, def, exp, routing, cleanup } = setup()
  try {
    await routing.respond({ userId: 'u1', text: '切换到专家模式' })

    clock.advance(59 * 60_000)
    const at59 = await routing.respond({ userId: 'u1', text: '问题A' })
    assert.equal(at59.from, 'expert')
    assert.equal(exp.calls.length, 1)
    assert.equal(def.calls.length, 0)

    clock.advance(60_000) // 正好 60 分钟
    const at60 = await routing.respond({ userId: 'u1', text: '问题B' })
    assert.equal(at60.from, 'default', '到期即恢复默认模型')
    assert.equal(def.calls.length, 1)
    assert.equal(exp.calls.length, 1, '过期后不得再打专家模型')
  } finally { cleanup() }
})

test('过期是静默的：不会主动给用户推任何消息，只是下一轮换回默认模型', async () => {
  const { clock, routing, cleanup } = setup()
  try {
    await routing.respond({ userId: 'u1', text: '切换到专家模式' })
    clock.advance(TTL + 1)
    const r = await routing.respond({ userId: 'u1', text: '普通问题' })
    assert.equal(r.text, 'default:普通问题', '过期后返回的就是默认模型的原始回答，不带任何"已恢复"提示')
  } finally { cleanup() }
})

test('重复开启是刷新而不是叠加', async () => {
  const { clock, store, routing, cleanup } = setup()
  try {
    await routing.respond({ userId: 'u1', text: '切换到专家模式' })
    const first = store.expiresAt('u1')

    clock.advance(30 * 60_000)
    const again = await routing.respond({ userId: 'u1', text: '专家模式' })
    assert.match(again.text, /重新计时/, '已在专家模式时再开启，措辞应是"刷新"')
    const second = store.expiresAt('u1')
    assert.equal(second - first, 30 * 60_000, '新的到期时刻 = 当前时刻 + 60 分钟（不是 first + 60 分钟）')
    assert.equal(second, clock.now() + TTL)

    // 叠加的话这里会是 120 分钟；刷新的话 60 分钟后就到期
    clock.advance(TTL)
    assert.equal(store.isActive('u1'), false, '刷新语义：从最后一次开启起算 60 分钟')
  } finally { cleanup() }
})

test('路由把请求原样转给选中的 agent，参数与返回值都不被改写', async () => {
  const { def, exp, routing, cleanup } = setup()
  try {
    const profile = { nickname: 'Z.俊', wxid: 'zj' }
    const channel = { providerBotId: 'bot-1', contextToken: 'tok' }
    const attachments = [{ name: 'a.pdf', path: '/tmp/a.pdf', size: 3 }]

    const r1 = await routing.respond({ userId: 'u1', text: '你好', profile, channel, attachments })
    assert.deepEqual(r1, { text: 'default:你好', from: 'default' }, '返回值原样透回')
    assert.equal(def.calls[0].userId, 'u1')
    assert.equal(def.calls[0].text, '你好')
    assert.equal(def.calls[0].profile, profile, 'profile 必须是同一个对象引用')
    assert.equal(def.calls[0].channel, channel)
    assert.equal(def.calls[0].attachments, attachments)

    await routing.respond({ userId: 'u1', text: '切换到专家模式' })
    const r2 = await routing.respond({ userId: 'u1', text: '难题', profile, channel, attachments })
    assert.deepEqual(r2, { text: 'expert:难题', from: 'expert' }, '切换后由另一个 agent 实例应答')
    assert.equal(exp.calls[0].profile, profile)
    assert.equal(exp.calls[0].channel, channel)
    assert.equal(exp.calls[0].attachments, attachments)
    assert.equal(def.calls.length, 1, '切换后默认 agent 不再被调用')
  } finally { cleanup() }
})

test('per-user 隔离：A 开了专家模式不影响 B', async () => {
  const { def, exp, routing, cleanup } = setup()
  try {
    await routing.respond({ userId: 'A', text: '切换到专家模式' })
    const a = await routing.respond({ userId: 'A', text: 'qa' })
    const b = await routing.respond({ userId: 'B', text: 'qb' })
    assert.equal(a.from, 'expert')
    assert.equal(b.from, 'default')
    assert.equal(exp.calls.length, 1)
    assert.deepEqual(def.calls.map((c) => c.userId), ['B'])
  } finally { cleanup() }
})

test('未配置专家模型时纯透传：连快捷命令都原样交给默认 agent（不给假承诺）', async () => {
  const { def, routing, store, cleanup } = setup({ withExpert: false })
  try {
    assert.equal(routing.enabled, false)
    const r = await routing.respond({ userId: 'u1', text: '切换到专家模式' })
    assert.equal(r.text, 'default:切换到专家模式', '未配置时不得返回"已切换"这种假确认')
    assert.equal(def.calls.length, 1)
    assert.equal(store.isActive('u1'), false, '未配置时状态存储不应被写')
  } finally { cleanup() }
})

test('ephemeral（定时任务/子 agent 的系统侧执行）不匹配快捷命令', async () => {
  const { def, store, routing, cleanup } = setup()
  try {
    const r = await routing.respond({ userId: 'task-1', text: '专家模式', ephemeral: true })
    assert.equal(r.text, 'default:专家模式')
    assert.equal(store.isActive('task-1'), false)
    assert.equal(def.calls.length, 1)
  } finally { cleanup() }
})

test('非命令文本不会被模糊匹配走', async () => {
  const { def, store, routing, cleanup } = setup()
  try {
    await routing.respond({ userId: 'u1', text: '专家模式是什么意思？' })
    await routing.respond({ userId: 'u1', text: '帮我开启专家模式吧' })
    assert.equal(store.isActive('u1'), false, '只精确匹配 trim 后的整句')
    assert.equal(def.calls.length, 2)
  } finally { cleanup() }
})

test('前后空白被 trim 后仍然命中命令', async () => {
  const { def, store, routing, cleanup } = setup()
  try {
    await routing.respond({ userId: 'u1', text: '  切换到专家模式  ' })
    assert.equal(store.isActive('u1'), true)
    assert.equal(def.calls.length, 0)
  } finally { cleanup() }
})

test('ExpertModeStore 落盘后重启仍然有效，且过期判定跨重启正确', async () => {
  const file = tmpFile()
  try {
    const clock = fakeClock()
    const s1 = new ExpertModeStore({ file, clock: clock.now })
    s1.enable('u1', TTL)
    assert.equal(s1.isActive('u1'), true)

    // 进程重启（新实例读同一个文件），时间只走了 10 分钟
    clock.advance(10 * 60_000)
    const s2 = new ExpertModeStore({ file, clock: clock.now })
    assert.equal(s2.isActive('u1'), true, '重启不应丢掉专家模式状态')

    // 再走 50 分钟 → 到期。惰性判定天然跨重启正确（定时器做不到这一点）
    clock.advance(50 * 60_000)
    const s3 = new ExpertModeStore({ file, clock: clock.now })
    assert.equal(s3.isActive('u1'), false)
    assert.equal(s3.expiresAt('u1'), 0)
  } finally { fs.rmSync(file, { force: true }) }
})

test('ExpertModeStore.disable 返回它本来是否开启；过期条目不会永久留在文件里', async () => {
  const file = tmpFile()
  try {
    const clock = fakeClock()
    const store = new ExpertModeStore({ file, clock: clock.now })
    assert.equal(store.disable('u1'), false, '本来就没开 → false')
    store.enable('u1', TTL)
    assert.equal(store.disable('u1'), true)

    store.enable('gone', TTL)
    clock.advance(TTL + 1)
    store.enable('fresh', TTL) // 任何一次写入都会顺手清掉已过期条目
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(Object.keys(onDisk), ['fresh'])
  } finally { fs.rmSync(file, { force: true }) }
})

test('set_expert_mode 工具写的是同一个状态存储，并如实说明"下一条消息才生效"', async () => {
  const file = tmpFile()
  try {
    const clock = fakeClock()
    const store = new ExpertModeStore({ file, clock: clock.now })
    const def = mockAgent('default')
    const exp = mockAgent('expert')
    const routing = new ModelRoutingAgent({ defaultAgent: def, expertAgent: exp, store, ttlMs: TTL })
    const { setExpertMode } = expertModeTools({ store, ttlMs: TTL, expertModel: 'gpt-5.6-sol' })

    const on = await callTool(setExpertMode, { enable: true }, 'u1')
    assert.match(on, /下一条消息/, '工具返回文本必须让模型如实转述"下一条才生效"')
    assert.equal(store.isActive('u1'), true, '工具与快捷命令共用同一个状态存储')

    // 「下一条消息」确实走专家 agent
    const next = await routing.respond({ userId: 'u1', text: '难题' })
    assert.equal(next.from, 'expert')

    const again = await callTool(setExpertMode, { enable: true }, 'u1')
    assert.match(again, /重新计时/, '已开启时再调用 = 刷新')

    const off = await callTool(setExpertMode, { enable: false }, 'u1')
    assert.match(off, /恢复默认模型/)
    assert.equal(store.isActive('u1'), false)
    const offAgain = await callTool(setExpertMode, { enable: false }, 'u1')
    assert.match(offAgain, /无需关闭|本来就没/)
    assert.equal(exp.calls.length, 1)
  } finally { fs.rmSync(file, { force: true }) }
})

test('set_expert_mode 在未配置专家模型（store 为空）时诚实报告不可用', async () => {
  const { setExpertMode } = expertModeTools({ store: null, ttlMs: TTL })
  const out = await callTool(setExpertMode, { enable: true }, 'u1')
  assert.match(out, /未启用/)
})
