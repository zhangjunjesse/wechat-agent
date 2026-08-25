/** Stable tenant identity helpers. Browser/session ids are transport handles;
 * the verified iLink user id is the durable user key for memory and sessions. */
export function stableUserId({ verifiedProfile, fallback }) {
  return String(verifiedProfile?.ilinkUserId || verifiedProfile?.providerUserId || fallback || '')
}
