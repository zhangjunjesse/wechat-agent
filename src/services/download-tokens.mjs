import crypto from 'node:crypto'

/** Opaque, time-limited download tokens for files written into a user's
 * sandbox directory (see ADR-0008).
 *
 * Why tokens instead of the existing `x-user-id` header auth used by
 * `/api/*`: a link the user taps inside WeChat opens in their phone's
 * in-app browser as a plain GET request — there is no way to attach a
 * custom auth header to that request, and asking the user to log in just to
 * download one file is a UX non-starter for a chat bot. So the token itself
 * (unguessable, single-file-scoped, time-limited) is the capability — the
 * same trust model as any other "share link". A leaked token can only ever
 * reveal the one file it was issued for, not browse the user's directory,
 * and it stops working after `ttlMs`.
 *
 * Storage is in-memory by design: tokens are meant to be used shortly after
 * a tool call, not archived; losing them on a container restart is
 * acceptable (the model can just regenerate the file and a fresh link). */
export class DownloadTokenStore {
  #tokens = new Map() // token -> { userId, relPath, expiresAt }
  #now
  #ttlMs

  constructor({ now = () => Date.now(), ttlMs = 24 * 3600 * 1000 } = {}) {
    this.#now = now
    this.#ttlMs = ttlMs
  }

  /** Issue a token bound to one user's one file. Returns the raw token string. */
  issue(userId, relPath, ttlMs = this.#ttlMs) {
    const token = crypto.randomBytes(24).toString('base64url')
    this.#tokens.set(token, { userId: String(userId), relPath: String(relPath), expiresAt: this.#now() + ttlMs })
    return token
  }

  /** Resolve a token to its `{ userId, relPath }`, or null if unknown/expired.
   * Expired entries are pruned opportunistically on lookup. */
  resolve(token) {
    const entry = this.#tokens.get(String(token || ''))
    if (!entry) return null
    if (entry.expiresAt <= this.#now()) { this.#tokens.delete(token); return null }
    return { userId: entry.userId, relPath: entry.relPath }
  }
}
