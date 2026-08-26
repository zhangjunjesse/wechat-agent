import { tool } from '@openai/agents'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

const WORKER_PATH = fileURLToPath(new URL('./code-worker.mjs', import.meta.url))
const MAX_INPUT_CHARS = 200_000
const MAX_OUTPUT_CHARS = 8_000

/** `run_code`: sandboxed synchronous JavaScript for precise, deterministic
 * data processing (filter/dedupe/sort/count/reshape) — see ADR-0008.
 *
 * Why this exists: asked to filter ~80 pasted contact records by
 * gender+signature, the model manually enumerated them in prose and
 * miscounted mid-reasoning, then had to self-correct in the reply. LLMs are
 * unreliable at exact bulk bookkeeping; deterministic code isn't.
 *
 * Security model (be precise about what this is and isn't):
 *   - Runs in a dedicated `worker_thread`, not the main process — a crash,
 *     hang, or memory blow-up in the script can only take down that one
 *     worker (killed and reported as an error), never the shared server
 *     process other users' conversations depend on.
 *   - `resourceLimits` cap the worker's heap; exceeding it terminates the
 *     worker rather than growing unbounded.
 *   - Inside the worker, the script runs in a fresh `vm` context that
 *     receives ONLY a plain string (`input`) — no functions or objects are
 *     ever injected into it. This matters because the classic `vm` escape
 *     (grab an injected host callback's `.constructor.constructor` to reach
 *     the outer `Function` constructor) requires a host-realm object to be
 *     reachable from inside the sandbox in the first place; passing nothing
 *     but a primitive string closes that specific route. There is
 *     deliberately no `readFile`/`writeFile`/`console.log` injected — those
 *     would each reopen it.
 *   - A timeout bounds both the vm's own execution (V8's interrupt
 *     mechanism, which — unlike a JS timer — can abort a synchronous
 *     `while(true){}`) and, as a backstop, the worker itself is forcibly
 *     terminated shortly after if it hasn't responded.
 *   - Still: per Node's own docs, "the vm module is not a security
 *     mechanism." This is a best-effort sandbox sized for LLM-generated
 *     scripts from identity-verified WeChat users, not a hardened boundary
 *     against a deliberately adversarial script. If the threat model ever
 *     extends to untrusted/anonymous input, this needs OS/process-level
 *     isolation (e.g. gVisor/Firecracker/a locked-down container per run)
 *     instead of an in-process vm context.
 *
 * Output contract: no `console.log`, no `return` — the script's last
 * EXPRESSION's value (REPL/eval semantics) is the result. A bare
 * `const x = ...` declaration has no completion value, so a script that
 * wants to return `x` must end with a line that is just `x`. */
export function codeTools({ timeoutMs = 3000, killGraceMs = 500, maxOldGenerationSizeMb = 64, maxYoungGenerationSizeMb = 16 } = {}) {
  const runCode = tool({
    name: 'run_code',
    description:
      '在隔离的沙箱线程里执行一段同步 JavaScript，用于精确处理批量/结构化数据（过滤、去重、排序、统计、拼接成 CSV 等）。' +
      '涉及多条记录的筛选、去重、计数、排序时必须用这个工具跑代码算出结果，不要在回复里手动逐条核对——人工数数容易数错。' +
      '用法：input 参数放要处理的原始文本（比如用户贴的一大段数据），code 里直接用 input 变量（字符串，比如先 JSON.parse(input) 或用正则/split 解析）。' +
      '代码只能用标准 JS 内置对象（Object/Array/JSON/Math/String/RegExp/Date/Map/Set 等），不能访问网络、文件系统、其它用户数据，也没有 console.log——' +
      '最后一行必须是一个表达式（不能是 const/let 声明或函数调用语句），它的值就是返回结果。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '同步 JavaScript 代码，最后一行是一个表达式（不能是 const/let 声明）作为返回值。' },
        input: { type: 'string', description: '可选：注入到代码里的 input 字符串变量，用于传入要处理的原始数据。' },
      },
      required: ['code'],
    },
    execute: async (input) => {
      const rawInput = typeof input.input === 'string' ? input.input.slice(0, MAX_INPUT_CHARS) : ''
      const msg = await runInWorker(String(input.code || ''), rawInput, { timeoutMs, killGraceMs, maxOldGenerationSizeMb, maxYoungGenerationSizeMb })
      if (!msg.ok) return `代码执行出错：${msg.error}`
      if (msg.result === undefined) return '(没有返回值：请让代码最后一行是一个表达式，而不是 const/let 声明)'
      const out = stringify(msg.result)
      return out.length > MAX_OUTPUT_CHARS ? out.slice(0, MAX_OUTPUT_CHARS) + '\n...(截断)' : out
    },
  })
  return { runCode }
}

function runInWorker(code, input, { timeoutMs, killGraceMs, maxOldGenerationSizeMb, maxYoungGenerationSizeMb }) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(killTimer); worker.terminate().catch(() => {}); resolve(value) }
    const worker = new Worker(WORKER_PATH, {
      workerData: { code, input, timeoutMs },
      resourceLimits: { maxOldGenerationSizeMb, maxYoungGenerationSizeMb },
    })
    const killTimer = setTimeout(() => finish({ ok: false, error: `脚本运行超时（超过 ${timeoutMs}ms）` }), timeoutMs + killGraceMs)
    worker.once('message', finish)
    worker.once('error', (error) => finish({ ok: false, error: error?.message || String(error) }))
    worker.once('exit', (exitCode) => finish({ ok: false, error: exitCode === 0 ? '脚本没有产生结果' : `脚本进程异常退出（可能超出内存限制），退出码 ${exitCode}` }))
  })
}

function stringify(value) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}
