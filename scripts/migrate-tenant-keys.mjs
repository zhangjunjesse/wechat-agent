import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { estimateMessagesTokens } from '../src/services/tokenizer.mjs'

/** Build a browserId -> providerUserId mapping from bindings + profiles. */
export function buildTenantMap(bindings = [], profiles = []) {
  const map = new Map()
  for (const b of bindings) {
    const pid = b?.profile?.providerUserId || b?.providerSession?.profile?.providerUserId
    if (pid && b.userId && String(b.userId) !== String(pid)) map.set(String(b.userId), String(pid))
  }
  for (const p of profiles) {
    if (p?.ilinkUserId && p.userId && String(p.userId) !== String(p.ilinkUserId)) map.set(String(p.userId), String(p.ilinkUserId))
  }
  return map
}

/** Fold memories/sessions keyed by legacy browser userId into the stable
 * providerUserId. Idempotent — rerunning is a no-op. */
export function migrateTenantKeys({ map, memoriesFile, sessionsFile }) {
  let memMoved = 0, memDedup = 0, sesMoved = 0, sesMerged = 0

  const mdb = new DatabaseSync(memoriesFile)
  for (const r of mdb.prepare('SELECT * FROM memories').all()) {
    const target = map.get(String(r.user_id))
    if (!target || target === String(r.user_id)) continue
    const dup = mdb.prepare('SELECT id FROM memories WHERE user_id=? AND type=? AND category=? AND subject=? AND relation=? AND content=?')
      .get(target, r.type, r.category, r.subject, r.relation, r.content)
    if (dup) { mdb.prepare('DELETE FROM memories WHERE id=?').run(r.id); memDedup++ }
    else { mdb.prepare('UPDATE memories SET user_id=? WHERE id=?').run(target, r.id); memMoved++ }
  }

  const sdb = new DatabaseSync(sessionsFile)
  for (const r of sdb.prepare('SELECT * FROM sessions').all()) {
    const target = map.get(String(r.user_id))
    if (!target || target === String(r.user_id)) continue
    const existing = sdb.prepare('SELECT * FROM sessions WHERE user_id=?').get(target)
    if (!existing) {
      sdb.prepare('UPDATE sessions SET user_id=? WHERE user_id=?').run(target, r.user_id)
      sesMoved++
    } else {
      const src = JSON.parse(r.transcript || '[]')
      const dst = JSON.parse(existing.transcript || '[]')
      const merged = [...src, ...dst]
      const summary = [r.summary, existing.summary].filter(Boolean).join('\n')
      sdb.prepare('UPDATE sessions SET transcript=?, summary=?, token_estimate=?, updated_at=? WHERE user_id=?')
        .run(JSON.stringify(merged), summary, estimateMessagesTokens(merged), Date.now(), target)
      sdb.prepare('DELETE FROM sessions WHERE user_id=?').run(r.user_id)
      sesMerged++
    }
  }

  return { memMoved, memDedup, sesMoved, sesMerged }
}

// CLI: node scripts/migrate-tenant-keys.mjs
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = (k, d) => process.env[k] || d
  const readJson = (f) => { try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(v) ? v : [] } catch { return [] } }
  const map = buildTenantMap(readJson(env('BINDINGS_FILE', 'data/bindings.json')), readJson(env('PROFILES_FILE', 'data/profiles.json')))
  console.log('mapping:', JSON.stringify([...map.entries()], null, 2))
  const result = migrateTenantKeys({ map, memoriesFile: env('MEMORIES_FILE', 'data/memories.db'), sessionsFile: env('SESSIONS_FILE', 'data/sessions.db') })
  console.log(JSON.stringify(result))
}
