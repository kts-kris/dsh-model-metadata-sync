/**
 * HTTP route mounter for the independent metadata synchronization fork.
 *
 * The contracted metadata authority is not wired yet. Reserve its exact
 * endpoints with explicit, effect-free 503 responses until T40 supplies it;
 * never fall back to the inherited runner or its lossy status projection.
 */
import { assertAuthorizedRequest } from './access.js'
import { sendError, sendJson, sendMethodNotAllowed } from './routes/envelope.js'
import { createHostRuntime } from './host-runtime.js'
import { createDiagnosticsRoutes } from './routes/diagnostics.js'

export * from './access.js'
export * from './http-normalizers.js'
export * from './routes/envelope.js'

const BASE = '/dsh-model-metadata-sync'
const MAX_REFERENCE_BODY_BYTES = 1024
const MAX_REFERENCE_BODY_CHUNKS = 128

// The only accepted input is one JSON property and a boolean. Check the byte
// limit before UTF-8 decoding; never echo parsing errors or input to the client.
function stopInvalidBody(req) {
  // Leave the unread body paused; tolerate late stream errors until close,
  // without retaining a listener after the stream has closed.
  req.pause?.()
  if (req.closed && (!req.destroyed || req._readableState?.closeEmitted !== false)) return
  const ignoreError = () => {}
  const cleanup = () => { req.removeListener('error', ignoreError); req.removeListener('close', cleanup) }
  req.on('error', ignoreError)
  req.once('close', cleanup)
}

async function readReferenceSetting(req, signal) {
  const contentType = req?.headers?.['content-type']
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType) ||
      (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) {
    stopInvalidBody(req)
    throw new Error('invalid request')
  }
  const chunks = []
  let size = 0
  let count = 0
  await new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => done(new Error('invalid request')), 5000)
    const done = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      req.removeListener('aborted', onAbort)
      req.removeListener('close', onClose)
      signal?.removeEventListener('abort', onAbort)
      if (error) { stopInvalidBody(req); reject(error) } else resolve()
    }
    const onData = chunk => {
      if (++count > MAX_REFERENCE_BODY_CHUNKS || (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array))) return done(new Error('invalid request'))
      size += chunk.byteLength
      if (size > MAX_REFERENCE_BODY_BYTES) return done(new Error('invalid request'))
      chunks.push(chunk)
    }
    const onEnd = () => done()
    const onError = () => done(new Error('invalid request'))
    const onAbort = () => done(new Error('invalid request'))
    const onClose = () => done(new Error('invalid request'))
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAbort)
    req.on('close', onClose)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted !== false || req.aborted || req.destroyed) done(new Error('invalid request'))
  })
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))
    // Accept exactly one key even when escaped (ordinary JSON.parse would silently
    // collapse duplicates), and only the JSON literals true and false.
    const match = /^[ \t\r\n]*\{[ \t\r\n]*("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")[ \t\r\n]*:[ \t\r\n]*(true|false)[ \t\r\n]*\}[ \t\r\n]*$/.exec(text)
    if (!match || JSON.parse(match[1]) !== 'enabled') throw new Error('invalid request')
    return match[2] === 'true'
  } catch (error) {
    stopInvalidBody(req)
    throw error
  }
}

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

export function registerHttpApi(ctx, synchronizer, options = {}) {
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
      if (route === '/status') {
        if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET')
        if (!options.referenceSettings) return sendError(res, 503, 'SETTINGS_UNAVAILABLE', 'Provider settings are unavailable.')
        const result = await createHostRuntime(ctx).status()
        if (result.status !== 'available') return sendError(res, 503, 'SETTINGS_UNAVAILABLE', 'Provider settings are unavailable.')
        return sendJson(res, 200, { providers: result.providers, referenceEnabled: options.referenceSettings.getReferenceEnabled() })
      }
      if (route === '/reference-settings') {
        if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST')
        if (!options.referenceSettings) return sendError(res, 503, 'CONFIG_UNAVAILABLE', 'Fork configuration cannot be saved.')
        let enabled
        try { enabled = await readReferenceSetting(req, peer.signal) }
        catch { return sendError(res, 400, 'INVALID_CONFIG', 'Reference setting must be a single JSON boolean.') }
        if (peer?.signal?.aborted !== false) return sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required.')
        try {
          await options.referenceSettings.setReferenceEnabled(enabled, peer.signal)
          if (options.referenceSettings.getReferenceEnabled() !== enabled) {
            return sendError(res, 409, 'WRITE_REJECTED', 'Fork configuration update was rejected.')
          }
          return sendJson(res, 200, { referenceEnabled: enabled })
        } catch (error) {
          if (error?.code === 'WRITE_REJECTED') return sendError(res, 409, 'WRITE_REJECTED', 'Fork configuration update was rejected.')
          return sendError(res, 503, 'CONFIG_UNAVAILABLE', 'Fork configuration cannot be saved.')
        }
      }
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
