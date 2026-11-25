import { types as utilTypes } from 'node:util'
import { boundedFetch } from './safe-fetch.js'
import { isSafeMetadataText, isValidModelId, normalizeUpstreamCatalog } from './metadata-source.js'

export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

// Canonical endpoint identity shared by the Host's same-revision target check.
// Never derive an origin from redirects, a response, or an HTTP request body.
export function configuredModelsEndpoint(profile) {
  if (typeof profile?.baseURL !== 'string' || !profile.baseURL || profile.baseURL.trim() !== profile.baseURL) return null
  try {
    const url = new URL(profile.baseURL)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
    const pathname = url.pathname.replace(/\/+$/, '')
    url.pathname = pathname.endsWith('/models') ? pathname : `${pathname}/models`
    return url.href
  } catch { return null }
}

export async function readBoundedText(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers?.get?.('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('model catalog response is too large')
  }

  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    const chunks = []
    let totalBytes = 0
    for await (const chunk of response.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += buf.byteLength
      if (totalBytes > maxBytes) {
        if (typeof response.body.cancel === 'function') {
          try { await response.body.cancel('response too large') } catch (_err) { /* best-effort */ }
        } else if (typeof response.body.destroy === 'function') {
          try { response.body.destroy() } catch (_err) { /* best-effort */ }
        }
        throw new Error('model catalog response is too large')
      }
      chunks.push(buf)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const chunks = []
    let totalBytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          const buf = Buffer.isBuffer(value) ? value : Buffer.from(value)
          totalBytes += buf.byteLength
          if (totalBytes > maxBytes) {
            try { await reader.cancel('response too large') } catch (_err) { /* best-effort */ }
            throw new Error('model catalog response is too large')
          }
          chunks.push(buf)
        }
      }
    } finally {
      try { reader.releaseLock?.() } catch (_err) { /* best-effort */ }
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  if (typeof response.text === 'function') {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error('model catalog response is too large')
    }
    return text
  }

  return ''
}

export function canUseGenericAdapter(profile) {
  return Boolean(configuredModelsEndpoint(profile)) && profile?.api === 'openai-completions'
}

function failed(code) {
  return { status: 'failed', applicable: false, models: [], error: { code, message: 'Model catalog discovery failed.' } }
}

function cancelBody(body) {
  try { Promise.resolve(body?.cancel()).catch(() => {}) } catch { /* best-effort cleanup */ }
}

// These native brand checks still recognize built-ins after their prototypes
// are changed. Browser-platform URL objects need separate intrinsic getters.
const headerObjectBrands = Object.entries(utilTypes)
  .filter(([name]) => /^is/.test(name) && name !== 'isProxy')
  .map(([, check]) => check)
const urlHref = Object.getOwnPropertyDescriptor(URL.prototype, 'href').get
const searchParamsSize = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, 'size')?.get
function hasUrlBrand(value) {
  for (const getter of [urlHref, searchParamsSize].filter(Boolean)) {
    try { getter.call(value); return true } catch { /* not this built-in */ }
  }
  return false
}

// Custom headers have no defined semantics and may carry independent secrets.
// Only null/undefined or demonstrably empty, plain objects are safe to ignore.
// Host must supply a fresh authoritative JSON-derived profile, never an arbitrary
// JavaScript object supplied by a client or third party. An exotic object can
// hide internal header slots even when prototype and own-key checks look plain.
function hasUnsupportedHeaders(headers) {
  if (headers === null || headers === undefined) return false
  // A Proxy can lie about its prototype and hide configurable own keys, so it
  // cannot establish that its underlying container is empty.
  if (typeof headers !== 'object' || utilTypes.isProxy(headers) || Array.isArray(headers) ||
      headerObjectBrands.some(check => check(headers)) || hasUrlBrand(headers)) return true
  const proto = Object.getPrototypeOf(headers)
  if ((proto !== Object.prototype && proto !== null) || Reflect.ownKeys(headers).length !== 0) return true
  // Additional defense for built-ins whose prototype was reset: Node's native
  // structured clone rejects hidden Headers slots in supported runtimes. This
  // is not a substitute for authoritative JSON provenance at the Host boundary.
  try { structuredClone(headers) } catch { return true }
  return false
}

// The lower network boundary enforces origin safety, but flattens page URLs.
// Exact endpoint proof does not authorize redirects or unproven pagination:
// even same-path query parameters may alter provider/routing semantics.
// Sticky refusal prevents boundedFetch's retry loop from sending a second request.
function scopedCatalogTransport(fetchImpl, endpoint, signal) {
  const configured = new URL(endpoint)
  const activeRequests = new Set()
  let refused = false
  let aborted = Boolean(signal?.aborted)
  const stop = () => {
    aborted = true
    for (const controller of activeRequests) controller.abort()
  }
  return {
    get refused() { return refused },
    stop,
    dispose() {
      for (const controller of activeRequests) controller.abort()
      activeRequests.clear()
    },
    async fetch(url, options) {
      let target
      try { target = new URL(url) } catch { refused = true }
      if (aborted || options?.signal?.aborted) throw new Error('Discovery cancelled.')
      if (refused || target.href !== configured.href) {
        refused = true
        throw new Error('Network target refused.')
      }
      // Both the per-request deadline and outer cancellation reach the actual
      // transport, even while its response body is being read.
      const linked = new AbortController()
      const onDeadline = () => linked.abort()
      options?.signal?.addEventListener('abort', onDeadline, { once: true })
      activeRequests.add(linked)
      if (aborted || signal?.aborted || options?.signal?.aborted) linked.abort()
      try {
        if (linked.signal.aborted) throw new Error('Discovery cancelled.')
        const request = Promise.resolve(fetchImpl(url, { ...options, signal: linked.signal, redirect: 'manual' }))
        // Abort must also settle boundedFetch when an injected transport ignores
        // its signal. Cancel any response which appears after that settlement.
        request.then(response => {
          if (linked.signal.aborted || aborted) cancelBody(response?.body)
        }, () => {})
        let onAbort
        const cancellation = new Promise((_, reject) => {
          onAbort = () => reject(new Error('Discovery cancelled.'))
          linked.signal.addEventListener('abort', onAbort, { once: true })
          if (linked.signal.aborted) onAbort()
        })
        let response
        try { response = await Promise.race([request, cancellation]) }
        finally { linked.signal.removeEventListener('abort', onAbort) }
        if (linked.signal.aborted || aborted) {
          cancelBody(response?.body)
          throw new Error('Discovery cancelled.')
        }
        if (response?.redirected || (response?.url && response.url !== target.href) ||
            [301, 302, 303, 307, 308].includes(response?.status)) {
          refused = true
          cancelBody(response?.body)
          throw new Error('Network target refused.')
        }
        const body = response?.body
        if (body && typeof body.getReader === 'function') {
          // Track the reader itself: a locked stream cannot be cancelled via
          // body.cancel(). Preserve every other original Response property.
          return new Proxy(response, {
            get(original, key) {
              if (key !== 'body') return Reflect.get(original, key, original)
              return new Proxy(body, {
                get(stream, property) {
                  if (property !== 'getReader') return Reflect.get(stream, property, stream)
                  return (...args) => {
                    const reader = stream.getReader(...args)
                    const cancel = () => cancelBody(reader)
                    linked.signal.addEventListener('abort', cancel, { once: true })
                    if (linked.signal.aborted) cancel()
                    return reader
                  }
                },
              })
            },
          })
        }
        return response
      } catch (error) {
        options?.signal?.removeEventListener('abort', onDeadline)
        activeRequests.delete(linked)
        throw error
      }
    },
  }
}

// Copy only independently Host-supplied proof. The caller owns verifying the
// registry against documentation; a profile, response or discover options can
// never replace or mutate this factory snapshot after construction.
function snapshotRegistry(registry) {
  try {
    if (!Array.isArray(registry)) return []
    return registry.map(record => ({
      provider: record?.provider,
      endpoint: record?.endpoint,
      protocol: record?.protocol,
      documentationUrl: record?.documentationUrl,
      fields: Object.fromEntries(['contextWindow', 'maxTokens', 'reasoningEfforts'].map(name => [name, {
        name: record?.fields?.[name]?.name,
        meaning: record?.fields?.[name]?.meaning,
      }])),
    }))
  } catch { return [] }
}

// Host-only API: profile and proof must originate from the same authoritative
// settings revision. The returned catalog is the original WeakMap-bound object;
// never convert, serialize, cache via 304, or pass it through legacy normalizers.
export async function discoverOpenAIModels(profile, {
  resolveCredential,
  fetchImpl = globalThis.fetch,
  trustedRegistry = [],
  signal,
} = {}) {
  if (signal?.aborted) return failed('INCOMPLETE_RESPONSE')
  // Snapshot all identity, credential and inventory inputs before awaiting.
  let endpoint, provider, protocol, keyRef, existingModelIds, registry
  try {
    endpoint = configuredModelsEndpoint(profile)
    provider = profile?.provider
    protocol = profile?.api
    if (hasUnsupportedHeaders(profile?.headers)) return failed('UNKNOWN_SOURCE')
    const refs = [profile?.apiKeyEnv, profile?.credentialRef, profile?.apiKeyRef]
      .filter(ref => ref !== undefined && ref !== null && ref !== '')
    if (refs.some(ref => !isSafeMetadataText(ref)) || new Set(refs).size > 1) return failed('UNKNOWN_SOURCE')
    keyRef = refs[0]
    const models = profile?.models === undefined ? [] : profile.models
    if (!Array.isArray(models)) return failed('INVALID_RESPONSE')
    existingModelIds = Array.from(models, model => typeof model === 'string' ? model : model?.id)
    registry = snapshotRegistry(trustedRegistry)
  } catch { return failed('INVALID_RESPONSE') }
  if (protocol !== 'openai-completions') return failed('UNSUPPORTED_PROTOCOL')
  if (!endpoint || !isSafeMetadataText(provider)) return failed('UNKNOWN_SOURCE')
  if (existingModelIds.some(id => !isValidModelId(id)) || new Set(existingModelIds).size !== existingModelIds.length) return failed('INVALID_RESPONSE')

  // Race the entire operation, including a stalled credential resolver, against
  // cancellation. Late work is harmless: it checks cancellation before every
  // request and before minting a WeakMap-bound authoritative catalog.
  let transport
  let abortListener
  const cancelled = new Promise(resolve => {
    abortListener = () => {
      transport?.stop()
      resolve(failed('INCOMPLETE_RESPONSE'))
    }
    signal?.addEventListener('abort', abortListener, { once: true })
    if (signal?.aborted) abortListener()
  })
  const work = (async () => {
    let apiKey
    try { apiKey = keyRef ? await resolveCredential(keyRef) : '' } catch { return failed('INCOMPLETE_RESPONSE') }
    if (signal?.aborted) return failed('INCOMPLETE_RESPONSE')
    if (keyRef && (typeof apiKey !== 'string' || !/^[\x21-\x7e]+$/.test(apiKey))) return failed('INCOMPLETE_RESPONSE')
    const headers = { Accept: 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const origin = new URL(endpoint).origin
    transport = scopedCatalogTransport(fetchImpl, endpoint, signal)
    const result = await boundedFetch({ url: endpoint, origin, headers, source: 'upstream', mode: 'catalog', fetchImpl: transport.fetch })
    if (signal?.aborted) return failed('INCOMPLETE_RESPONSE')
    if (transport.refused) return failed('ORIGIN_REFUSED')
    if (!result.ok) return failed(result.error.code)
    return normalizeUpstreamCatalog({
      provider, protocol, endpoint, payload: result.value,
      source: { kind: 'upstream', origin, fetchedAt: new Date().toISOString() },
      responseComplete: true, existingModelIds,
    }, registry)
  })()
  try { return await Promise.race([work, cancelled]) }
  finally {
    signal?.removeEventListener('abort', abortListener)
    // On successful completion no active body remains; abort is a cleanup
    // guard for a timed-out, late-resolving or cancellation-ignoring transport.
    transport?.dispose()
  }
}

// Legacy health probing is not part of the approved core-only surface.
export async function probeOpenAIModels() {
  throw Object.assign(new Error('Health probing is disabled.'), { code: 'UNSUPPORTED_OPERATION' })
}

export function createGenericAdapter({ resolveCredential, fetchImpl = globalThis.fetch, trustedRegistry = [] } = {}) {
  const registry = snapshotRegistry(trustedRegistry)
  return Object.freeze({
    id: 'openai-compatible',
    canHandle: canUseGenericAdapter,
    // Options intentionally cannot override transport, credential or proof.
    discover(profile, { signal } = {}) {
      return discoverOpenAIModels(profile, { resolveCredential, fetchImpl, trustedRegistry: registry, signal })
    },
    health: probeOpenAIModels,
  })
}
