/**
 * HTTP route mounter for the independent metadata synchronization fork.
 *
 * Provides status, reference settings and explicit legacy-route refusals.
 * The production entry delegates preview, confirmation and cancellation to a
 * separate authority; direct calls without that authority remain read-only.
 */
import { assertAuthorizedRequest } from './access.js'
import { sendError, sendJson, sendMethodNotAllowed } from './routes/envelope.js'
import { createHostRuntime } from './host-runtime.js'
import { createDiagnosticsRoutes } from './routes/diagnostics.js'
import { createMetadataPreview } from './routes/metadata-preview.js'

export * from './access.js'
export * from './http-normalizers.js'
export * from './routes/envelope.js'

const BASE = '/dsh-model-metadata-sync'
const MAX_REFERENCE_BODY_BYTES = 1024
const MAX_REFERENCE_BODY_CHUNKS = 128
const REFERENCE_REQUEST_DEADLINE_MS = 15000
const MAX_REFERENCE_WRITES_GLOBAL = 32
const MAX_REFERENCE_WRITES_OWNER = 4

// DSH exposes only an owner kind, not a stable per-user principal. As in the
// production entry, all admitted owners belong to one authorization domain;
// transport peers and plugin instances are not identities. Symbol.for and the
// current realm's globalThis share counters across independently loaded copies
// in that realm, including a plugin unload/reload while an old edit is pending.
// They do not provide cross-realm, cross-process, or hostile-code isolation.
const REFERENCE_WRITE_BUDGET = Symbol.for('dsh-model-metadata-sync.reference-writes.v1')
const referenceWriteBudget = globalThis[REFERENCE_WRITE_BUDGET] ??= { global: 0, owner: 0 }

function acquireReferenceWrite() {
  if (referenceWriteBudget.global >= MAX_REFERENCE_WRITES_GLOBAL || referenceWriteBudget.owner >= MAX_REFERENCE_WRITES_OWNER) return null
  referenceWriteBudget.global++
  referenceWriteBudget.owner++
  let released = false
  return () => {
    if (released) return
    released = true
    referenceWriteBudget.global--
    referenceWriteBudget.owner--
  }
}

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

// A peer's lifetime may exceed an individual HTTP request. In particular the
// normal request 'close' after a complete body is not a disconnect; only the
// unfinished response closing revokes a queued write.
function referenceRequestLifetime(req, res, peerSignal, unloadSignal) {
  const controller = new AbortController()
  let responseClosed = Boolean(res.destroyed && !res.writableFinished)
  const abort = () => controller.abort()
  const timer = setTimeout(abort, REFERENCE_REQUEST_DEADLINE_MS)
  const onResponseClose = () => {
    if (!res.writableFinished) { responseClosed = true; abort() }
  }
  req.on?.('aborted', abort)
  req.on?.('error', abort)
  res.on?.('close', onResponseClose)
  peerSignal.addEventListener('abort', abort, { once: true })
  unloadSignal.addEventListener('abort', abort, { once: true })
  if (peerSignal.aborted !== false || unloadSignal.aborted || req.aborted || (res.destroyed && !res.writableFinished)) abort()
  return {
    signal: controller.signal,
    responseClosed: () => responseClosed || Boolean(res.destroyed && !res.writableFinished),
    dispose() {
      clearTimeout(timer)
      req.removeListener?.('aborted', abort)
      req.removeListener?.('error', abort)
      res.removeListener?.('close', onResponseClose)
      peerSignal.removeEventListener('abort', abort)
      unloadSignal.removeEventListener('abort', abort)
    },
  }
}

// Once the editor is called we cannot know whether its callback has already
// dispatched a write. Stop waiting on disconnect, but observe the eventual
// settlement and never retry it or assert that no write occurred.
async function waitForReferenceWrite(write, signal) {
  let onAbort
  const aborted = new Promise(resolve => {
    onAbort = () => resolve({ status: 'unknown' })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    return await Promise.race([
      Promise.resolve(write).then(() => ({ status: 'complete' }), error => ({ status: 'error', error })),
      aborted,
    ])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

// Direct registrations reserve preview/apply/cancel for compatibility; the
// production entry can delegate them to its authenticated authority instead.
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

  const unload = new AbortController()
  const rollback = createDiagnosticsRoutes(synchronizer).rollback
  const runtime = createHostRuntime(ctx, options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
  const preview = createMetadataPreview({ runtime, referenceSettings: options.referenceSettings })
  const makeHandler = (route, retired) => async (req, res, peer) => {
    try {
      // The Host dispatches only after required-auth admission; the peer and
      // CSRF checks here are additional defenses, not an authentication provider.
      if (!assertAuthorizedRequest(req, res, ctx, peer)) return
      if (route === '/status') {
        if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET')
        if (!options.referenceSettings) return sendError(res, 503, 'SETTINGS_UNAVAILABLE', 'Provider settings are unavailable.')
        const result = await runtime.status()
        if (result.status !== 'available') return sendError(res, 503, 'SETTINGS_UNAVAILABLE', 'Provider settings are unavailable.')
        return sendJson(res, 200, { providers: result.providers, referenceEnabled: options.referenceSettings.getReferenceEnabled() })
      }
      if (route === '/preview') {
        if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST')
        if (!options.referenceSettings) return sendError(res, 503, 'SETTINGS_UNAVAILABLE', 'Provider settings are unavailable.')
        const result = await preview(req, peer.signal)
        if (peer.signal.aborted !== false) return sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required.')
        return sendJson(res, result.status, result.body)
      }
      if (route === '/reference-settings') {
        if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST')
        if (!options.referenceSettings) return sendError(res, 503, 'CONFIG_UNAVAILABLE', 'Fork configuration cannot be saved.')
        if (unload.signal.aborted) return sendError(res, 503, 'CONFIG_UNAVAILABLE', 'Fork configuration cannot be saved.')
        const lifetime = referenceRequestLifetime(req, res, peer.signal, unload.signal)
        const responseClosed = lifetime.responseClosed
        try {
          let enabled
          try { enabled = await readReferenceSetting(req, lifetime.signal) }
          catch {
            if (responseClosed()) return
            return sendError(res, 400, 'INVALID_CONFIG', 'Reference setting must be a single JSON boolean.')
          }
          if (lifetime.signal.aborted) {
            if (responseClosed()) return
            return sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required.')
          }
          const release = acquireReferenceWrite()
          if (!release) return sendError(res, 503, 'CONFIG_BUSY', 'Fork configuration write capacity is unavailable.')
          try {
            let write
            try {
              // Release only when the real operation settles, not when the HTTP
              // observer times out, disconnects, or the plugin unloads.
              write = Promise.resolve(options.referenceSettings.setReferenceEnabled(enabled, lifetime.signal))
              write.then(release, release)
            } catch (error) {
              release()
              throw error
            }
            const result = await waitForReferenceWrite(write, lifetime.signal)
            if (responseClosed()) return
            if (result.status === 'unknown' || lifetime.signal.aborted) {
              return sendError(res, 503, 'OUTCOME_UNKNOWN', 'Fork configuration update outcome is unknown; check status before another request.')
            }
            if (result.status === 'error') throw result.error
            if (options.referenceSettings.getReferenceEnabled() !== enabled) {
              return sendError(res, 409, 'WRITE_REJECTED', 'Fork configuration update was rejected.')
            }
            return sendJson(res, 200, { referenceEnabled: enabled })
          } catch (error) {
            if (responseClosed()) return
            if (error?.code === 'WRITE_REJECTED') return sendError(res, 409, 'WRITE_REJECTED', 'Fork configuration update was rejected.')
            return sendError(res, 503, 'CONFIG_UNAVAILABLE', 'Fork configuration cannot be saved.')
          }
        } finally { lifetime.dispose() }
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
      ...AUTHORITY_ROUTES.filter(route => !options.externalAuthority || !['/preview', '/apply', '/preview/cancel'].includes(route))
        .map(route => [route, false]),
      ...RETIRED_ROUTES.map(route => [route, true]),
    ]) {
      registrations.push(ctx.webServer.register({
        kind: 'exact',
        path: `${BASE}${suffix}`,
        auth: 'required',
        handler: makeHandler(suffix, retired),
      }))
    }
    const disposeFirst = registrations[0]
    registrations[0] = () => { unload.abort(); preview.dispose(); return disposeFirst?.() }
    return registrations
  } catch (error) {
    unload.abort()
    preview.dispose()
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
