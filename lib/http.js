/**
 * HTTP route mounter for the independent metadata synchronization fork.
 *
 * The contracted metadata authority is not wired yet. Reserve its exact
 * endpoints with explicit, effect-free 503 responses until T40 supplies it;
 * never fall back to the inherited runner or its lossy status projection.
 */
import { assertAuthorizedRequest } from './access.js'
import { sendError } from './routes/envelope.js'
import { createDiagnosticsRoutes } from './routes/diagnostics.js'

export * from './access.js'
export * from './http-normalizers.js'
export * from './routes/envelope.js'

const BASE = '/dsh-model-metadata-sync'

// These are reservations, not an implementation of preview or apply. They
// must only be replaced by the authenticated preview/confirmation authority.
const AUTHORITY_ROUTES = [
  '/preview', '/apply', '/preview/cancel', '/status', '/reference-settings',
]

// Keep explicit refusals for known inherited paths so callers do not mistake a
// retired action for an empty success or trigger an old side-effectful handler.
const RETIRED_ROUTES = [
  '/run', '/try', '/batch-try', '/export', '/import', '/aliases', '/aliases/resolve',
  '/health', '/selection', '/policy', '/history', '/history/rollback', '/credentials',
  '/credentials/check', '/report', '/notifications', '/notifications/read',
  '/notifications/acknowledge', '/webhook/test', '/health/latency', '/pricing',
  '/probe/provider', '/probe/all', '/probe/status', '/probe/verified', '/ollama/ps',
  '/ollama/tags', '/ollama/info', '/ollama/pull', '/ollama/pull/status',
  '/ollama/unload', '/ollama/delete',
]

export function registerHttpApi(ctx, synchronizer, _options = {}) {
  if (typeof ctx?.webServer?.register !== 'function') {
    if (typeof ctx?.logger?.warn === 'function') {
      ctx.logger.warn('[dsh-model-metadata-sync] webServer service unavailable, HTTP API skipped')
    }
    return []
  }

  const rollback = createDiagnosticsRoutes(synchronizer).rollback
  const makeHandler = (route, retired) => async (req, res, peer) => {
    try {
      // The Host dispatches only after required-auth admission; the peer and
      // CSRF checks here are additional defenses, not an authentication provider.
      if (!assertAuthorizedRequest(req, res, ctx, peer)) return
      if (!retired) {
        return sendError(res, 503, 'AUTHORITY_UNAVAILABLE',
          'Metadata preview and confirmation authority is not yet available.')
      }
      if (route === '/history/rollback') return rollback(req, res)
      return sendError(res, 410, 'UNSUPPORTED_OPERATION',
        'This legacy operation is retired and unsupported by the metadata sync fork.')
    } catch {
      // Never expose raw exceptions, request details, credentials or headers.
      if (typeof ctx?.logger?.error === 'function') {
        ctx.logger.error('[dsh-model-metadata-sync] HTTP request failed')
      }
      return sendError(res, 500, 'internal_error', 'The HTTP request failed.')
    }
  }

  const registrations = []
  try {
    for (const [suffix, retired] of [
      ...AUTHORITY_ROUTES.map(route => [route, false]),
      ...RETIRED_ROUTES.map(route => [route, true]),
    ]) {
      registrations.push(ctx.webServer.register({
        kind: 'exact',
        path: `${BASE}${suffix}`,
        auth: 'required',
        handler: makeHandler(suffix, retired),
      }))
    }
    return registrations
  } catch (error) {
    // A later duplicate must not leave earlier fork routes mounted when the
    // Cordis effect fails before it can return its normal disposer.
    let rollbackFailed = false
    for (const dispose of registrations.reverse()) {
      try { if (typeof dispose === 'function') dispose() } catch { rollbackFailed = true }
    }
    if (rollbackFailed) {
      // Do not echo untrusted registration/disposer exceptions, but do not
      // pretend rollback was complete when a resource could remain mounted.
      throw Object.assign(new Error('Route registration failed and cleanup could not be confirmed.'), {
        code: 'ROUTE_CLEANUP_UNCONFIRMED',
      })
    }
    throw error
  }
}
