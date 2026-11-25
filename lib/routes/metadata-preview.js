import { createHash, randomBytes } from 'node:crypto'
import { isValidModelId } from '../metadata-source.js'

const MAX_BYTES = 256 * 1024
const MAX_CHUNKS = 2048
const BODY_DEADLINE = 5000
const PREVIEW_TTL = 5 * 60 * 1000
const messages = Object.freeze({
  UNKNOWN_SOURCE: [404, 'Configured upstream source is unavailable.'],
  UNSUPPORTED_PROTOCOL: [422, 'Provider protocol is unsupported.'],
  INVALID_RESPONSE: [422, 'Model catalog or preview request is invalid.'],
  INCOMPLETE_RESPONSE: [502, 'Model catalog discovery did not complete.'],
  ORIGIN_REFUSED: [403, 'Network target refused.'],
  SETTINGS_UNAVAILABLE: [503, 'Verified provider settings are unavailable.'],
  AMBIGUOUS_IDENTITY: [409, 'Provider identity is ambiguous.'],
  REVISION_CONFLICT: [409, 'Settings changed; request a new preview.'],
})
const problem = code => ({ status: messages[code]?.[0] ?? 503,
  body: { ok: false, error: { code: messages[code] ? code : 'SETTINGS_UNAVAILABLE',
    message: messages[code]?.[1] ?? messages.SETTINGS_UNAVAILABLE[1] } } })

function stopBody(req) {
  req.pause?.()
  if (req.closed && (!req.destroyed || req._readableState?.closeEmitted !== false)) return
  const ignore = () => {}
  const cleanup = () => { req.removeListener('error', ignore); req.removeListener('close', cleanup) }
  req.on('error', ignore)
  req.once('close', cleanup)
}

// Only two object keys, with a scalar and a scalar-string array, are supported.
// Parsing the two key literals before constructing the object also rejects
// duplicate and escaped-equivalent keys which JSON.parse would otherwise erase.
function parseBody(text) {
  let index = 0
  const white = () => { while (/[\x20\t\r\n]/.test(text[index] ?? '\0')) index++ }
  const literal = () => {
    if (text[index] !== '"') throw Error('invalid')
    const start = index++
    while (index < text.length) {
      const c = text[index++]
      if (c === '"') return JSON.parse(text.slice(start, index))
      if (c === '\\') index++
    }
    throw Error('invalid')
  }
  const char = expected => { white(); if (text[index++] !== expected) throw Error('invalid'); white() }
  const data = Object.create(null)
  char('{')
  for (let i = 0; i < 2; i++) {
    const key = literal()
    if (!['provider', 'selectedNewIds'].includes(key) || Object.hasOwn(data, key)) throw Error('invalid')
    char(':')
    if (key === 'provider') data.provider = literal()
    else {
      char('[')
      const values = []
      if (text[index] !== ']') for (;;) {
        if (values.length >= 20000) throw Error('invalid')
        values.push(literal())
        white()
        if (text[index] !== ',') break
        char(',')
      }
      char(']')
      data.selectedNewIds = values
    }
    white()
    if (i === 0) char(',')
  }
  char('}')
  if (index !== text.length || !isValidModelId(data.provider) || !Array.isArray(data.selectedNewIds) ||
      data.selectedNewIds.some(id => !isValidModelId(id)) || new Set(data.selectedNewIds).size !== data.selectedNewIds.length) throw Error('invalid')
  return data
}

async function readBody(req, signal) {
  const headers = req?.headers ?? {}
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
    const timer = setTimeout(() => done(true), BODY_DEADLINE)
    const done = bad => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const [event, handler] of [['data', onData], ['end', onEnd], ['error', onError], ['aborted', onError], ['close', onError]]) req.removeListener(event, handler)
      signal?.removeEventListener('abort', onError)
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
    for (const [event, handler] of [['data', onData], ['end', onEnd], ['error', onError], ['aborted', onError], ['close', onError]]) req.on(event, handler)
    signal?.addEventListener('abort', onError, { once: true })
    if (signal?.aborted !== false || req.aborted || req.destroyed) done(true)
  })
  return parseBody(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)))
}

// This response is strictly a display snapshot. No token is stored, accepted by
// apply, or capable of authorizing a settings transaction. Its ID/digest and
// five-minute expiry identify only the exact displayed plan and target binding.
export function createMetadataPreview({ runtime, referenceSettings } = {}) {
  let active = true
  const inFlight = new Set()
  async function preview(req, peerSignal) {
    const controller = new AbortController()
    const signal = controller.signal
    const onPeerAbort = () => controller.abort()
    if (typeof peerSignal?.addEventListener !== 'function' || typeof peerSignal?.removeEventListener !== 'function') {
      return problem('INCOMPLETE_RESPONSE')
    }
    inFlight.add(controller)
    try {
      peerSignal.addEventListener('abort', onPeerAbort, { once: true })
      if (!active || peerSignal?.aborted !== false) controller.abort()
      return await runPreview(req, signal)
    } finally {
      peerSignal?.removeEventListener('abort', onPeerAbort)
      inFlight.delete(controller)
    }
  }
  async function runPreview(req, signal) {
    let input
    try { input = await readBody(req, signal) } catch { return problem('INVALID_RESPONSE') }
    if (!active || signal?.aborted !== false) return problem('INCOMPLETE_RESPONSE')
    let referenceEnabled
    try { referenceEnabled = referenceSettings?.getReferenceEnabled() } catch { return problem('SETTINGS_UNAVAILABLE') }
    if (typeof referenceEnabled !== 'boolean') return problem('SETTINGS_UNAVAILABLE')
    const started = new Date().toISOString()
    let discovered
    try { discovered = await runtime.discover(input.provider, { signal }) } catch { return problem('INCOMPLETE_RESPONSE') }
    if (discovered.status !== 'complete') return problem(discovered.error?.code)
    if (!active || signal?.aborted !== false) return problem('INCOMPLETE_RESPONSE')
    // The approved fixed worker currently has no per-request cancellation API.
    // Until it is integrated with lifecycle cancellation, do not start network
    // work that could continue after this request's owner or plugin is gone.
    const referenceStatus = referenceEnabled ? 'unknown' : 'disabled'
    if (!active || signal?.aborted !== false) return problem('INCOMPLETE_RESPONSE')
    try {
      if (referenceSettings.getReferenceEnabled() !== referenceEnabled) return problem('REVISION_CONFLICT')
      const projected = runtime.project(discovered, input.provider, input.selectedNewIds)
      if (projected.status !== 'complete') return problem(projected.error?.code)
      const { fingerprint, status, ...plan } = projected
      const sources = {
        upstream: { kind: 'upstream', status: 'success', lastAttemptAt: started },
        reference: referenceEnabled
          ? { kind: 'reference', status: referenceStatus, reason: 'temporarily-unavailable', lookupIdentifiers: ['provider', 'modelId', 'protocol'] }
          : { kind: 'reference', status: referenceStatus, lookupIdentifiers: ['provider', 'modelId', 'protocol'] },
      }
      const warnings = ['Read-only preview; applying changes is unavailable.']
      const digest = createHash('sha256').update(JSON.stringify({ ...plan, fingerprint, sources, warnings })).digest('hex')
      return { status: 200, body: { previewId: randomBytes(32).toString('base64url'), digest,
        expiresAt: new Date(Date.now() + PREVIEW_TTL).toISOString(), ...plan, sources, warnings,
        authority: 'unavailable', writeEnabled: false } }
    } catch { return problem('SETTINGS_UNAVAILABLE') }
  }
  preview.dispose = () => {
    active = false
    for (const controller of inFlight) controller.abort()
  }
  return preview
}
