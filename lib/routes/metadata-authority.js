import { AsyncLocalStorage } from 'node:async_hooks'
import { assertAuthorizedRequest, writeJson } from '../access.js'
import { createMetadataService } from '../metadata-service.js'
import { isValidModelId } from '../metadata-source.js'

// This module is a Host-only integration seam, not mounted by the plugin. The
// caller must supply a stable, trusted Peer -> owner binding. In particular,
// neither an HTTP header nor Peer.id is a proven cross-request owner identity.
// Synthetic tests can supply a second owner; a deployment that deliberately
// treats all authenticated owner Principals as one authority domain may map
// them to one frozen Host-owned singleton only after reviewing that assumption.
const BASE = '/dsh-model-metadata-sync'
const MAX_BYTES = 256 * 1024
const MAX_CHUNKS = 2048
const BODY_MS = 5000
const OPERATION_MS = 15000
const MAX_POLICY_INFLIGHT = 32
const MAX_OWNER_POLICY_INFLIGHT = 4
// Safety callbacks are Host work, not service calls. A timed-out callback keeps
// its permit until it really settles, even across route unload/re-registration.
const policyInflight = new Set(), ownerPolicyInflight = new Map()
const ABORTED = Symbol('aborted')
async function waitFor(work, signal) {
  let onAbort
  const cancelled = new Promise(resolve => {
    onAbort = () => resolve(ABORTED)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try { return await Promise.race([work, cancelled]) }
  finally { signal.removeEventListener('abort', onAbort) }
}
const errors = Object.freeze({
  AUTH_REQUIRED: [401, 'Authentication required.'],
  ORIGIN_REFUSED: [403, 'Request origin could not be verified.'],
  UNKNOWN_SOURCE: [404, 'Configured upstream source is unavailable.'],
  UNSUPPORTED_PROTOCOL: [422, 'Provider protocol is unsupported.'],
  INVALID_RESPONSE: [422, 'The request or model catalog is invalid.'],
  INCOMPLETE_RESPONSE: [502, 'Model catalog discovery did not complete.'],
  AMBIGUOUS_IDENTITY: [409, 'Provider identity is ambiguous.'],
  REVISION_CONFLICT: [409, 'Settings changed; request a new preview.'],
  REPREVIEW_REQUIRED: [409, 'A fresh preview is required.'],
  ORIGINAL_WRITER_ACTIVE: [409, 'The original plugin may be active; pause it before applying.'],
  WRITE_REJECTED: [409, 'The change was refused.'],
  OUTCOME_UNKNOWN: [409, 'The write outcome is unknown; inspect settings before retrying.'],
  SETTINGS_UNAVAILABLE: [503, 'Verified provider settings are unavailable.'],
})
function problem(res, code) {
  if (!Object.hasOwn(errors, code)) code = 'SETTINGS_UNAVAILABLE'
  const [status, message] = errors[code]
  return writeJson(res, status, { ok: false, error: { code, message } })
}
function stopBody(req) {
  req.pause?.()
  if (req.closed && (!req.destroyed || req._readableState?.closeEmitted !== false)) return
  const ignore = () => {}
  const cleanup = () => { req.removeListener('error', ignore); req.removeListener('close', cleanup) }
  req.on('error', ignore)
  req.once('close', cleanup)
}

// Parse a deliberately tiny JSON grammar instead of JSON.parse(object), so
// duplicate (including escaped-equivalent) keys cannot silently overwrite.
function parseBody(text, fields) {
  let index = 0
  const white = () => { while (/[\x20\t\r\n]/.test(text[index] ?? '\0')) index++ }
  const char = expected => { white(); if (text[index++] !== expected) throw Error('invalid'); white() }
  const string = () => {
    if (text[index] !== '"') throw Error('invalid')
    const start = index++
    while (index < text.length) {
      const c = text[index++]
      if (c === '"') return JSON.parse(text.slice(start, index))
      if (c === '\\') index++
    }
    throw Error('invalid')
  }
  const result = Object.create(null)
  char('{')
  for (let i = 0; i < fields.length; i++) {
    const key = string()
    if (!fields.includes(key) || Object.hasOwn(result, key)) throw Error('invalid')
    char(':')
    if (key === 'selectedNewIds') {
      const values = []
      char('[')
      if (text[index] !== ']') for (;;) {
        if (values.length >= 20000) throw Error('invalid')
        values.push(string()); white()
        if (text[index] !== ',') break
        char(',')
      }
      char(']')
      result[key] = values
    } else result[key] = string()
    white()
    if (i < fields.length - 1) char(',')
  }
  char('}')
  if (index !== text.length) throw Error('invalid')
  if (fields.includes('provider') && (!isValidModelId(result.provider) ||
      result.selectedNewIds.some(id => !isValidModelId(id)) || new Set(result.selectedNewIds).size !== result.selectedNewIds.length)) throw Error('invalid')
  if (fields.includes('previewId') && !/^[A-Za-z0-9_-]{43}$/.test(result.previewId)) throw Error('invalid')
  if (fields.includes('digest') && !/^[a-f0-9]{64}$/.test(result.digest)) throw Error('invalid')
  return result
}
async function readBody(req, signal, fields) {
  const headers = req.headers ?? {}
  if (typeof headers['content-type'] !== 'string' ||
      !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(headers['content-type']) ||
      (headers['content-encoding'] !== undefined && headers['content-encoding'] !== 'identity') ||
      (headers['content-length'] !== undefined && (typeof headers['content-length'] !== 'string' ||
        !/^\d+$/.test(headers['content-length']) || Number(headers['content-length']) > MAX_BYTES))) {
    stopBody(req); throw Error('invalid')
  }
  const chunks = []
  let size = 0
  await new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => done(true), BODY_MS)
    const done = bad => {
      if (settled) return
      settled = true; clearTimeout(timer)
      for (const [event, fn] of listeners) req.removeListener(event, fn)
      signal.removeEventListener('abort', onError)
      if (bad) { stopBody(req); reject(Error('invalid')) } else resolve()
    }
    const onData = chunk => {
      if ((!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) || chunks.length >= MAX_CHUNKS) return done(true)
      size += chunk.byteLength
      if (size > MAX_BYTES) return done(true)
      chunks.push(chunk)
    }
    const onEnd = () => done(headers['content-length'] !== undefined && Number(headers['content-length']) !== size)
    const onError = () => done(true)
    const listeners = [['data', onData], ['end', onEnd], ['error', onError], ['aborted', onError], ['close', onError]]
    for (const [event, fn] of listeners) req.on(event, fn)
    signal.addEventListener('abort', onError, { once: true })
    if (signal.aborted || req.aborted || req.destroyed) done(true)
  })
  return parseBody(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)), fields)
}

/**
 * Register isolated exact routes. Dependencies (including fetch and conflict
 * proof) are Host-owned; HTTP input cannot supply them. No secret inventory or
 * cross-writer exclusion is manufactured. `previewSafety`, if supplied, is an
 * additional Host policy, not a guarantee of complete secret discovery.
 */
export function registerMetadataAuthority(ctx, { ownerFromPeer, previewSafety, fetchImpl, SettingsConflictError, proveNoWriteConflict } = {}) {
  if (typeof ctx?.webServer?.register !== 'function' || typeof ctx?.get !== 'function' ||
      typeof ownerFromPeer !== 'function' || (previewSafety !== undefined && typeof previewSafety !== 'function')) {
    throw new TypeError('Trusted Host route dependencies required.')
  }
  const activity = new AsyncLocalStorage()
  const shutdown = new AbortController()
  let active = true
  const guardedContext = { get(name) {
    const original = ctx.get(name)
    if (name === 'settings' && original) return {
      ...(typeof original.describe === 'function' ? { describe: (...args) => original.describe(...args) } : {}),
      ...(typeof original.mutate === 'function' ? { mutate: (...args) => {
        const op = activity.getStore()
        if (!active || !op || op.signal.aborted) throw Error('request ended')
        op.dispatched = true
        return original.mutate(...args)
      } } : {}),
    }
    if (name === 'credentials' && typeof original?.resolve === 'function') return {
      async resolve(...args) {
        const op = activity.getStore()
        if (!active || !op || op.signal.aborted) throw Error('request ended')
        const result = await original.resolve(...args)
        if (!active || op.signal.aborted) throw Error('request ended')
        return result
      },
    }
    return original
  } }
  // Explicit undefined arguments use the service's safe defaults; retries are
  // disabled unless Host supplies a real no-write proof.
  const transport = fetchImpl ?? globalThis.fetch
  const guardedFetch = (url, options = {}) => {
    const op = activity.getStore()
    if (!active || !op || op.signal.aborted || typeof transport !== 'function') throw Error('request ended')
    const signal = options.signal ? AbortSignal.any([options.signal, op.signal]) : op.signal
    return transport(url, { ...options, signal })
  }
  const service = createMetadataService({ ctx: guardedContext, ownerIdentity: owner => owner,
    fetchImpl: guardedFetch,
    ...(SettingsConflictError === undefined ? {} : { SettingsConflictError }),
    ...(proveNoWriteConflict === undefined ? {} : { proveNoWriteConflict }),
  })
  function runPolicy(owner, result, signal) {
    const count = ownerPolicyInflight.get(owner) ?? 0
    if (policyInflight.size >= MAX_POLICY_INFLIGHT || count >= MAX_OWNER_POLICY_INFLIGHT) return Promise.resolve(false)
    const permit = {}
    policyInflight.add(permit)
    ownerPolicyInflight.set(owner, count + 1)
    const release = () => {
      policyInflight.delete(permit)
      const remaining = ownerPolicyInflight.get(owner) - 1
      if (remaining) ownerPolicyInflight.set(owner, remaining)
      else ownerPolicyInflight.delete(owner)
    }
    return Promise.resolve().then(() => !signal.aborted && active ? previewSafety(result) : false).then(
      allowed => { release(); return allowed === true },
      () => { release(); return false },
    )
  }
  const registrations = []
  const definitions = [
    ['/preview', ['provider', 'selectedNewIds'], 'preview'],
    ['/apply', ['previewId', 'digest'], 'apply'],
    ['/preview/cancel', ['previewId'], 'cancel'],
  ]
  function handler(fields, action) {
    return async (req, res, peer) => {
      let owner, input, operation, timer
      try {
        if (!assertAuthorizedRequest(req, res, ctx, peer)) return
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: { code: 'method', message: 'POST only' } })
        if (!active) return problem(res, 'SETTINGS_UNAVAILABLE')
        owner = ownerFromPeer(peer)
        if (!(typeof owner === 'string' && owner.length > 0) && !(owner && typeof owner === 'object' && Object.isFrozen(owner))) return problem(res, 'AUTH_REQUIRED')
        const deadline = new AbortController()
        timer = setTimeout(() => deadline.abort(), OPERATION_MS)
        const signal = AbortSignal.any([peer.signal, shutdown.signal, deadline.signal])
        const interrupted = () => problem(res, operation.dispatched ? 'OUTCOME_UNKNOWN' :
          peer.signal.aborted || shutdown.signal.aborted ? 'AUTH_REQUIRED' : 'SETTINGS_UNAVAILABLE')
        operation = { signal, dispatched: false }
        try { input = await readBody(req, signal, fields) }
        catch { return signal.aborted ? interrupted() : problem(res, 'INVALID_RESPONSE') }
        if (signal.aborted || !active) return interrupted()
        const work = Promise.resolve(activity.run(operation, () => service[action](owner, input)))
        const result = await waitFor(work, signal)
        if (result === ABORTED || signal.aborted || !active) {
          if (action === 'preview') {
            if (result !== ABORTED && result?.previewId) service.cancel(owner, { previewId: result.previewId })
            else void work.then(late => { if (late?.previewId) service.cancel(owner, { previewId: late.previewId }) }, () => {})
          } else if (action === 'apply' && !operation.dispatched) {
            service.cancel(owner, { previewId: input.previewId })
          }
          return interrupted()
        }
        if (result?.error) return problem(res, result.error.code)
        if (action === 'preview' && previewSafety !== undefined) {
          const allowed = await waitFor(runPolicy(owner, result, signal), signal)
          if (allowed !== true || signal.aborted || !active) {
            service.cancel(owner, { previewId: result.previewId })
            return signal.aborted || !active ? interrupted() : problem(res, 'SETTINGS_UNAVAILABLE')
          }
        }
        return writeJson(res, 200, result)
      } catch { return problem(res, operation?.dispatched ? 'OUTCOME_UNKNOWN' : 'SETTINGS_UNAVAILABLE') }
      finally { clearTimeout(timer) }
    }
  }
  try {
    for (const [suffix, fields, action] of definitions) registrations.push(ctx.webServer.register({
      kind: 'exact', path: `${BASE}${suffix}`, auth: 'required', handler: handler(fields, action),
    }))
  } catch (error) {
    active = false; shutdown.abort(); service.unload()
    let failed = false
    for (const dispose of registrations.reverse()) try { if (typeof dispose === 'function') dispose() } catch { failed = true }
    if (failed) throw Object.assign(new Error('Route cleanup could not be confirmed.'), { code: 'ROUTE_CLEANUP_UNCONFIRMED' })
    throw error
  }
  return () => {
    if (!active) return
    active = false; shutdown.abort(); service.unload()
    let failed = false
    for (const dispose of registrations.reverse()) try { if (typeof dispose === 'function') dispose() } catch { failed = true }
    if (failed) throw Object.assign(new Error('Route cleanup could not be confirmed.'), { code: 'ROUTE_CLEANUP_UNCONFIRMED' })
  }
}
