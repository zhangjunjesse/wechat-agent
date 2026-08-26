import { parentPort, workerData } from 'node:worker_threads'
import vm from 'node:vm'

/** Runs inside an isolated worker_thread spawned by code-tools.mjs — see the
 * security-model comment there for why: this file's ONLY job is to run one
 * script in a fresh vm context and post back a structured-clone-safe result.
 * It never touches user data on disk (no readFile/writeFile are injected),
 * so a crash or resource-limit kill of this worker can't corrupt anything —
 * worst case it just returns an error to the tool call. */

const { code, input, timeoutMs } = workerData

// Security self-check hook, not application logic: a value ONLY the real
// worker-thread global scope holds. If a future Node version's vm
// implementation ever lets sandboxed code escape into this worker's own
// top-level scope (the classic `injectedHostFn.constructor.constructor`
// technique — see tests/code-tools.test.mjs, verified BLOCKED on the Node
// version this was written against), the escaped code would be able to read
// this and prove it. Costs nothing in normal operation.
globalThis.__code_worker_realm_marker__ = 'REAL_WORKER_SCOPE_NOT_THE_SANDBOX'

try {
  const context = vm.createContext(Object.create(null))
  context.input = input
  const result = vm.runInContext(String(code), context, { timeout: timeoutMs, displayErrors: true })
  parentPort.postMessage({ ok: true, result: normalize(result) })
} catch (error) {
  parentPort.postMessage({ ok: false, error: error?.message || String(error) })
}

/** Reduce to something postMessage's structured-clone can actually carry.
 * Functions/symbols never clone; anything else that fails to clone (e.g. a
 * value holding a foreign-realm exotic object) degrades to its string form
 * instead of silently vanishing or crashing the postMessage call. */
function normalize(value) {
  if (value === undefined) return undefined
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)
  try {
    structuredClone(value)
    return value
  } catch {
    try { return JSON.stringify(value) } catch { return String(value) }
  }
}
