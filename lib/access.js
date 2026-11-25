/** Post-admission defenses for routes registered with DSH's required auth. */

export function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * The public origin comes only from the WebApp service, whose implementation
 * returns its configured publicUrl or WebServer's listener origin. Neither
 * client Host nor Forwarded headers can establish the browser-facing scheme.
 * An absent/unavailable service or an invalid advertised URL fails closed.
 */
function advertisedOrigin(ctx) {
  try {
    const value = ctx?.webApp?.getAdvertisedUrl?.()
    if (typeof value !== 'string') return undefined
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined
    return url.origin
  } catch {
    return undefined
  }
}

/** An Origin header is one serialized HTTP(S) origin, not a general URL. */
function browserOrigin(value) {
  if (typeof value !== 'string' || !/^https?:\/\/[^\s/?#@\\]+$/i.test(value)) return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
    return url.origin
  } catch {
    return undefined
  }
}

/**
 * Required auth is enforced by the WebServer before dispatch. `peer` is the
 * Host-provided admission result; headers, loopback and cookie names do not
 * authenticate anyone. Unsafe methods also require browser-origin evidence.
 */
export function assertAuthorizedRequest(req, res, ctx, peer) {
  if (!peer || peer.signal?.aborted !== false) {
    writeJson(res, 401, { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Authentication required.' } })
    return false
  }
  if (peer.principal?.kind !== 'owner') {
    writeJson(res, 403, { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Owner authentication required.' } })
    return false
  }
  const safeMethod = req?.method === 'GET' || req?.method === 'HEAD'
  const origin = req?.headers?.origin
  const site = req?.headers?.['sec-fetch-site']
  // The runtime's advertised URL does not reveal whether it is an explicitly
  // configured publicUrl or merely the listener fallback. Until a trusted proxy
  // mode proves that distinction, forwarding metadata is not sufficient to
  // authorize mutations and must not influence the expected origin.
  const forwarded = Object.keys(req?.headers ?? {}).some(key =>
    key.toLowerCase() === 'forwarded' || key.toLowerCase().startsWith('x-forwarded-'))
  if (!safeMethod && forwarded) {
    writeJson(res, 403, { ok: false, error: { code: 'ORIGIN_REFUSED', message: 'Request origin could not be verified.' } })
    return false
  }
  // Reads need no Origin, but when present it must also be trusted. Explicit
  // cross-site requests are refused for every method, including reads.
  const expected = !safeMethod || origin !== undefined ? advertisedOrigin(ctx) : undefined
  if (site === 'cross-site' || ((!safeMethod || origin !== undefined) && (
    !expected || browserOrigin(origin) !== expected || (!safeMethod && site !== 'same-origin')
  ))) {
    writeJson(res, 403, { ok: false, error: { code: 'ORIGIN_REFUSED', message: 'Request origin could not be verified.' } })
    return false
  }
  return true
}
