import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 源码不得含字面 NUL 字节。
 *
 * 为什么需要这条测试：`scripts/backfill-default-subscriptions.mjs` 曾把账本键的
 * NUL 分隔符写成**字面 0x00 字节**而不是 `\u0000` 转义。JS 运行时对此毫无意见，
 * 测试也照跑——但整个文件因此被所有按"有没有 NUL"判定文本/二进制的工具认定为
 * 二进制：`git diff` 只说 "Binary files differ"、代码审查看不到改动、多数编辑器
 * 和文件读取工具直接拒绝打开。一个语义完全正确的改动会因此变成不可审查的黑盒。
 *
 * 这类错误没有任何正常途径能被发现（不报错、不失败、肉眼不可见），且一旦混进去
 * 就会被后续编辑不断复制扩散，正适合用一条机械检查钉死。
 *
 * 需要 NUL 作分隔符是完全合理的（wxid、任务名都不可能含它，比空格更安全）——
 * 本测试要求的只是**写成 `\u0000` 转义**，运行时行为完全一致。 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const SCAN_DIRS = ['src', 'scripts', 'tests', 'deploy', 'skills']
const TEXT_EXT = new Set(['.mjs', '.js', '.json', '.md', '.yml', '.yaml', '.txt', '.html', '.css'])

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (TEXT_EXT.has(path.extname(entry.name))) yield full
  }
}

test('no source file contains a literal NUL byte (write \\u0000 as an escape instead)', () => {
  const offenders = []
  for (const dir of SCAN_DIRS) {
    const full = path.join(repoRoot, dir)
    if (!fs.existsSync(full)) continue
    for (const file of walk(full)) {
      const buf = fs.readFileSync(file)
      const at = buf.indexOf(0)
      if (at !== -1) offenders.push(`${path.relative(repoRoot, file)} (第一个 NUL 在字节偏移 ${at})`)
    }
  }
  assert.deepEqual(offenders, [], `这些文件含字面 NUL 字节，会被当成二进制文件（git diff / 代码审查 / 编辑器全部失效）。把它写成 \\u0000 转义，运行时行为不变：\n  ${offenders.join('\n  ')}`)
})
