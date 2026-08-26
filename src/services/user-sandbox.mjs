import path from 'node:path'

/** Shared per-user path sandboxing, used by every tool that touches the
 * filesystem (file-tools, code-tools). One resolver = one boundary check, so
 * the "no escaping your own directory" guarantee can't drift out of sync
 * between call sites.
 *
 * Resolves `relPath` against `<root>/<userId>/` and throws if the resolved
 * path would land outside that directory (traversal via `../`, absolute
 * paths, symlinked-looking tricks handled the same way path.resolve does). */
export function resolveUserPath(root, userId, relPath) {
  const base = path.resolve(root)
  const userRoot = path.join(base, String(userId))
  const full = path.resolve(userRoot, String(relPath || ''))
  if (!full.startsWith(userRoot + path.sep) && full !== userRoot) {
    throw new Error('路径越界：只能访问你自己的文件目录')
  }
  return full
}

export function userRootDir(root, userId) {
  return path.join(path.resolve(root), String(userId))
}
