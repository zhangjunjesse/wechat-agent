import test from 'node:test'
import assert from 'node:assert/strict'
import { codeTools } from '../src/tools/code-tools.mjs'

function call(toolFn, input, ctx = { context: {} }) {
  return toolFn.invoke(ctx, JSON.stringify(input))
}

test('run_code filters/dedupes structured data precisely (the failure mode this tool fixes)', async () => {
  const { runCode } = codeTools()
  const input = JSON.stringify([
    { phone: '111', gender: '男', sig: '' },
    { phone: '222', gender: '女', sig: '在' },
    { phone: '333', gender: '男', sig: '无' },
    { phone: '111', gender: '男', sig: '' }, // duplicate of first
  ])
  const code = `
    const rows = JSON.parse(input)
    const seen = new Set()
    const kept = rows.filter(r => r.gender === '男' && (r.sig === '' || r.sig === '无'))
      .filter(r => (seen.has(r.phone) ? false : (seen.add(r.phone), true)))
      .map(r => r.phone)
    kept
  `
  const out = await call(runCode, { code, input })
  assert.deepEqual(JSON.parse(out), ['111', '333'])
})

test('run_code sandbox has no process/require/fetch/Buffer/global — only plain JS builtins', async () => {
  // Node's vm module auto-injects console into every context (not something
  // we add) — verified present here, and separately verified in the next
  // test that it cannot be used to escape the sandbox.
  const { runCode } = codeTools()
  const code = `
    ({
      hasProcess: typeof process !== 'undefined',
      hasRequire: typeof require !== 'undefined',
      hasFetch: typeof fetch !== 'undefined',
      hasBuffer: typeof Buffer !== 'undefined',
      hasGlobal: typeof global !== 'undefined',
      hasConsole: typeof console !== 'undefined',
      hasArray: typeof Array !== 'undefined',
      hasJSON: typeof JSON !== 'undefined',
    })
  `
  const out = await call(runCode, { code })
  assert.deepEqual(JSON.parse(out), {
    hasProcess: false, hasRequire: false, hasFetch: false, hasBuffer: false,
    hasGlobal: false, hasConsole: true, hasArray: true, hasJSON: true,
  })
})

test('run_code blocks the classic vm-escape technique (console.log.constructor.constructor)', async () => {
  // Node auto-injects `console` into every vm context (see test above). If
  // that were a naive host-realm object, `console.log.constructor.constructor`
  // would reach the outer Function constructor and let sandboxed code run
  // with the worker's own capabilities (fs/net) — the textbook `vm` escape.
  // This is a REGRESSION TEST: it plants a marker that only the true outer
  // scope could see, then attempts the escape from inside the sandbox. If a
  // future Node version ever changes this behavior, this test catches it
  // instead of us finding out in production.
  const { runCode } = codeTools()
  const code = `
    (function () {
      try {
        const Fn = console.log.constructor.constructor
        return Fn('return (typeof globalThis !== "undefined" && globalThis.__code_worker_realm_marker__) || "NOT_ESCAPED"')()
      } catch (e) {
        return 'BLOCKED: ' + e.message
      }
    })()
  `
  const out = await call(runCode, { code })
  assert.notEqual(out, 'REAL_WORKER_SCOPE_NOT_THE_SANDBOX')
  assert.ok(out === 'NOT_ESCAPED' || out.startsWith('BLOCKED:'), `expected containment, got: ${out}`)
})

test('run_code times out an infinite loop instead of hanging the tool call', async () => {
  const { runCode } = codeTools({ timeoutMs: 200, killGraceMs: 100 })
  const started = Date.now()
  const out = await call(runCode, { code: 'while (true) {}' })
  assert.match(out, /代码执行出错|超时/)
  assert.ok(Date.now() - started < 3000, 'should not hang anywhere close to the default test timeout')
})

test('run_code contains a memory-bomb script to its own worker instead of the process', async () => {
  // resourceLimits.maxOldGenerationSizeMb bounds the worker's heap. A script
  // that just keeps allocating should get that worker killed (surfaced as an
  // error result) well before it could threaten the shared server process —
  // this is the concrete reason run_code spawns a worker_thread per call
  // instead of running vm directly on the main thread.
  const { runCode } = codeTools({ timeoutMs: 4000, killGraceMs: 500, maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 8 })
  const started = Date.now()
  const out = await call(runCode, { code: "let a = []; while (true) { a.push('x'.repeat(1e6)) }" })
  assert.match(out, /代码执行出错|超时|退出码/)
  assert.ok(Date.now() - started < 6000, 'a memory bomb must not hang the tool call')
})

test('run_code reports a friendly message when the script has no completion value', async () => {
  const { runCode } = codeTools()
  const out = await call(runCode, { code: 'const x = 1 + 1' })
  assert.match(out, /没有返回值/)
})

test('run_code surfaces thrown errors as a message, and stays usable for the next call', async () => {
  const { runCode } = codeTools()
  const bad = await call(runCode, { code: 'throw new Error("boom")' })
  assert.match(bad, /代码执行出错.*boom/)
  const good = await call(runCode, { code: '1 + 1' })
  assert.equal(good, '2')
})

test('run_code truncates oversized output', async () => {
  const { runCode } = codeTools()
  const out = await call(runCode, { code: `'x'.repeat(20000)` })
  assert.ok(out.length < 20000)
  assert.match(out, /截断/)
})
