import { createHash, createHmac, randomBytes } from 'node:crypto'
import { types } from 'node:util'
import { configuredModelsEndpoint } from './generic-adapter.js'
import { isValidModelId, isValidUtcTimestamp } from './metadata-source.js'
import { openRouterCatalogMatchesTarget } from './openrouter-metadata.js'
import { createRawContextCommit } from './raw-context-commit.js'

const ENDPOINT = 'https://openrouter.ai/api/v1/models'
const PROTOCOL = 'openai-completions'
const TTL = 300000
const MAX_PENDING = 512
const DEADLINE_MS = 15000
const MAX_INFLIGHT = 32, MAX_OWNER_INFLIGHT = 4
// Shared across all instances, including unloaded ones. A caller's deadline
// never releases a permit while the underlying Host operation is still running.
const inflight = { source: new Set(), editor: new Set() }
const byOwner = { source: new Map(), editor: new Map() }
class CapacityError extends Error {}
function limited(kind, owner, call) {
  const slots = inflight[kind], counts = byOwner[kind], count = counts.get(owner) ?? 0
  if (slots.size >= MAX_INFLIGHT || count >= MAX_OWNER_INFLIGHT) throw new CapacityError()
  const slot = {}
  slots.add(slot); counts.set(owner, count + 1)
  let released = false
  function release() {
    if (released) return
    released = true; slots.delete(slot)
    const remaining = counts.get(owner) - 1
    if (remaining) counts.set(owner, remaining); else counts.delete(owner)
  }
  try { return Promise.resolve(call()).then(value => { release(); return value }, error => { release(); throw error }) }
  catch (error) { release(); throw error }
}
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const positive = n => Number.isSafeInteger(n) && n > 0
const fail = code => ({ error: { code } })

// Copy only bounded JSON data; do not execute getters, proxies, toJSON or iterators.
// The private snapshot may include secrets; it is never returned, only HMACed.
function data(root) {
  let nodes = 0, bytes = 0
  const seen = new WeakSet()
  function copy(value, depth) {
    if (++nodes > 100000 || depth > 64) throw Error('invalid data')
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'string') { if ((bytes += value.length) > 4194304) throw Error('oversize'); return value }
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (!value || typeof value !== 'object' || types.isProxy(value) || seen.has(value)) throw Error('invalid data')
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value)
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw Error('invalid data')
    const length = array ? Object.getOwnPropertyDescriptor(value, 'length')?.value : 0
    const keys = Reflect.ownKeys(value)
    if (keys.length > 100000 || array && (!Number.isSafeInteger(length) || length > 100000 || keys.length !== length + 1)) throw Error('invalid data')
    seen.add(value)
    const out = array ? [] : Object.create(null)
    for (const key of keys) {
      if (array && key === 'length') continue
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key) ||
          array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) throw Error('invalid key')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !has(descriptor, 'value') || !descriptor.enumerable) throw Error('invalid property')
      Object.defineProperty(out, key, { value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true })
    }
    seen.delete(value)
    return out
  }
  const result = copy(root, 0)
  // Also refuse disguised native instances with hidden slots where clone detects them.
  if (root && typeof root === 'object') structuredClone(root)
  return result
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  return JSON.stringify(value)
}
function frozen(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value) }
  return value
}
function exact(input, names) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || types.isProxy(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return false
  const keys = Reflect.ownKeys(input)
  return keys.length === names.length && names.every(key => {
    const d = Object.getOwnPropertyDescriptor(input, key)
    return d && has(d, 'value') && d.enumerable
  })
}
function syncCall(fn, ...args) {
  const result = fn(...args)
  if (types.isPromise(result)) { Promise.prototype.then.call(result, () => {}, () => {}); throw Error('async dependency') }
  return result
}
function noExpression(value) {
  if (!value || typeof value !== 'object' || has(value, '__jsExpr')) throw Error('unknown raw expression')
}

/**
 * Experimental, UNMOUNTED Host-only integration seam; NOT production wiring.
 * The factory dependencies must be installed by the same trusted Host, never
 * request JSON: runtime is that Host's createHostRuntime instance; loadSource
 * returns only its ORIGINAL completed discover(provider) result; currentSource
 * synchronously returns the current original result for this Host and provider.
 * The Host must authenticate those facts itself: OpenRouter's exported normalizer
 * produces a forgeable read-only brand, and neither it nor a boolean is proof of
 * a real network response. runtime.project is defense-in-depth, not a public
 * documented exact-target authentication API. `readLocal` must synchronously
 * provide the authoritative complete raw/current and inherited snapshots, exact
 * namespace/path/revision, with the editor lock actually covering its read when
 * called by verify. ownerIdentity must derive an authenticated Host identity,
 * not accept an identity asserted by a request. `loadSource` must freshly discover
 * on each call and `currentSource` must invalidate changed source state.
 *
 * No production adapter can currently establish all these contracts. In
 * particular, caller must independently establish the original-writer/credential
 * exclusion, complete inherited/effective absence, secret-safe preview output,
 * and cross-writer/source consistency. The editor lock is not a cross-process
 * lock. Do not mount this seam or transmit callbacks, opaque capabilities or
 * proofs over HTTP. A confirmed invocation is single-use even on unknown outcome.
 */
export function createRawContextProof({ ctx, runtime, ownerIdentity, loadSource, currentSource, readLocal, clock = Date.now } = {}) {
  if (typeof ctx?.get !== 'function' || typeof runtime?.project !== 'function' ||
      ![ownerIdentity, loadSource, currentSource, readLocal, clock].every(fn => typeof fn === 'function')) {
    throw new TypeError('Trusted Host dependencies required.')
  }
  const key = randomBytes(32), pending = new Map(), capabilities = new WeakMap()
  let active = true, lastTime = 0
  const operations = new Set()
  function operation(signal) {
    if (!active || signal?.aborted) throw Error('cancelled')
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(abort, DEADLINE_MS)
    operations.add(controller)
    return { signal: controller.signal, close() {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); operations.delete(controller)
    } }
  }
  function waitFor(work, signal) {
    if (signal.aborted) throw Error('cancelled')
    let abort
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(Error('cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    return Promise.race([work, cancelled]).finally(() => signal.removeEventListener('abort', abort))
  }
  function now() {
    const n = syncCall(clock)
    if (!Number.isSafeInteger(n) || n < lastTime || n < 0 || n > 253402300799999 - TTL) throw Error('invalid clock')
    lastTime = n
    return n
  }
  function identity(owner) {
    const id = syncCall(ownerIdentity, owner)
    if (!id || typeof id !== 'object' || types.isProxy(id) || !Object.isFrozen(id)) throw Error('untrusted owner')
    return id
  }
  function mac(value) { return createHmac('sha256', key).update(canonical(value)).digest('hex') }
  function local(provider, modelId) {
    const value = data(syncCall(readLocal, provider))
    if (!value || !isValidModelId(value.namespace) || value.provider !== provider ||
        !Array.isArray(value.providerPath) || value.providerPath.length !== 2 ||
        value.providerPath[0] !== 'providers' || value.providerPath[1] !== provider ||
        !Number.isSafeInteger(value.revision) || value.revision < 0) throw Error('invalid local binding')
    const { current, inherited } = value
    noExpression(current); noExpression(current.providers)
    const route = current.providers[provider]
    noExpression(route)
    if (route.api !== PROTOCOL || configuredModelsEndpoint(route) !== ENDPOINT ||
        has(route, 'modelOverrides') || has(route, 'defaultContextWindow')) throw Error('protected route')
    noExpression(inherited)
    if (has(inherited, 'providers')) {
      noExpression(inherited.providers)
      if (has(inherited.providers, provider)) throw Error('unknown inherited route')
    }
    if (!Array.isArray(route.models) || !route.models.length || route.models.length > 20000) throw Error('unknown inventory')
    const ids = route.models.map(model => {
      noExpression(model)
      if (Array.isArray(model) || !isValidModelId(model.id)) throw Error('unknown model')
      return model.id
    })
    if (new Set(ids).size !== ids.length) throw Error('duplicate model')
    const index = ids.indexOf(modelId), model = route.models[index]
    if (index < 0 || has(model, 'contextWindow') || !positive(model.maxTokens)) throw Error('protected model')
    return { value, ids, index, maxTokens: model.maxTokens, binding: mac(value) }
  }
  function source(provider, modelId, result, currentTime) {
    if (syncCall(currentSource, provider) !== result || !Object.isFrozen(result) || result.status !== 'complete' ||
        result.inventory !== 'explicit' || !Object.isFrozen(result.catalog) ||
        !openRouterCatalogMatchesTarget(result.catalog, { provider, endpoint: ENDPOINT, protocol: PROTOCOL })) throw Error('untrusted discovery')
    // The runtime owns the WeakMap relation from ORIGINAL result to target and
    // rejects clones and changed local snapshots. It does not by itself prove
    // this injected runtime is the real production Host; that is the Host contract.
    const projected = syncCall(runtime.project, result, provider, [])
    if (projected?.status !== 'complete' || projected.provider !== provider || projected.revision !== result.revision ||
        !/^[a-f0-9]{64}$/.test(projected.fingerprint)) throw Error('changed discovery')
    const catalog = data(result.catalog)
    if (catalog.status !== 'complete' || catalog.applicable !== false || !Array.isArray(catalog.models) || !catalog.models.length) throw Error('incomplete source')
    const models = catalog.models.filter(model => model.id === modelId)
    if (models.length !== 1 || models[0].existing !== true || modelId.endsWith('~latest')) throw Error('unknown model')
    const field = models[0].contextWindow, provenance = field?.source
    if (field?.state !== 'known' || !positive(field.value) || provenance?.kind !== 'upstream' ||
        provenance.origin !== 'https://openrouter.ai' || provenance.url !== ENDPOINT || provenance.provider !== provider ||
        !isValidUtcTimestamp(provenance.fetchedAt)) throw Error('unknown field')
    const fetched = Date.parse(provenance.fetchedAt)
    if (fetched > currentTime || currentTime - fetched >= TTL) throw Error('stale source')
    // A fresh request naturally has a new fetch timestamp. All the other allowed
    // normalized facts remain bound, including unrelated models and fields.
    function withoutFetchTime(item) {
      if (Array.isArray(item)) return item.map(withoutFetchTime)
      if (!item || typeof item !== 'object') return item
      const out = Object.create(null)
      for (const [k, v] of Object.entries(item)) if (k !== 'fetchedAt') out[k] = withoutFetchTime(v)
      return out
    }
    return { value: field.value, fetchedAt: provenance.fetchedAt, binding: mac(withoutFetchTime(catalog)),
      revision: result.revision, fingerprint: projected.fingerprint }
  }
  // Bind the exact raw arguments handed to the edit callback, not merely a
  // second read which may describe a different generation. The trusted Host must
  // ensure this callback is inside the actual lock and provide the complete
  // matching snapshot; this wrapper does not manufacture cross-writer exclusion.
  let lockedState = null
  const wrappedContext = { get(name) {
    const service = ctx.get(name)
    if (name !== 'configEditor' || typeof service?.edit !== 'function') return service
    return { configuration: (...args) => service.configuration(...args),
      edit(entry, change) { return service.edit(entry, (current, inherited) => {
        const previous = lockedState
        try { lockedState = mac(data({ current, inherited })); return change(current, inherited) }
        finally { lockedState = previous }
      }) } }
  } }
  const commit = createRawContextCommit(wrappedContext, { verify(evidence) {
    try {
      const entry = capabilities.get(evidence.proof)
      if (!active || !entry || entry.signal?.aborted || entry.state !== 'reserved' || entry.consumed || evidence.authority !== entry.authority ||
          evidence.owner !== entry.owner || evidence.plan !== entry.plan || now() >= entry.expires) return false
      const before = local(entry.provider, entry.modelId)
      const fresh = source(entry.provider, entry.modelId, entry.latest, now())
      if (before.binding !== entry.localBinding || lockedState !== mac({ current: before.value.current, inherited: before.value.inherited }) ||
          fresh.binding !== entry.sourceBinding ||
          fresh.value !== entry.value || fresh.revision !== entry.plan.revision || fresh.fingerprint !== entry.plan.target.endpointFingerprint ||
          evidence.endpoint !== ENDPOINT || evidence.protocol !== PROTOCOL || evidence.revision !== entry.plan.revision ||
          evidence.provider !== entry.provider || evidence.modelId !== entry.modelId || evidence.contextWindow !== entry.value ||
          evidence.maxTokens !== before.maxTokens || before.maxTokens > entry.value ||
          before.index !== entry.plan.changes[0].index) return false
      // Synchronous verify and reserve happen in the sink's editor callback.
      entry.consumed = true
      return true
    } catch { return false }
  } })
  async function preview(owner, request, signal) {
    let op
    try {
      if (!active || !exact(request, ['provider', 'modelId']) || !isValidModelId(request.provider) || !isValidModelId(request.modelId)) return fail('REPREVIEW_REQUIRED')
      const who = identity(owner), provider = request.provider, modelId = request.modelId
      op = operation(signal)
      const before = local(provider, modelId)
      const found = await waitFor(limited('source', who, () => loadSource(provider, { signal: op.signal })), op.signal)
      if (!active || op.signal.aborted) return fail('REPREVIEW_REQUIRED')
      const time = now(), from = source(provider, modelId, found, time), after = local(provider, modelId)
      if (before.binding !== after.binding || from.revision !== before.value.revision || from.value < before.maxTokens) return fail('REPREVIEW_REQUIRED')
      for (const [id, item] of pending) if (time >= item.expires) pending.delete(id)
      if (pending.size >= MAX_PENDING) return fail('SETTINGS_UNAVAILABLE')
      const previewId = randomBytes(32).toString('base64url')
      if (pending.has(previewId)) return fail('SETTINGS_UNAVAILABLE')
      const changes = [{ type: 'set-field', scope: 'models', modelId, index: before.index, field: 'contextWindow', value: from.value }]
      const plan = frozen({ revision: before.value.revision, target: { namespace: before.value.namespace, provider,
        providerPath: [...before.value.providerPath], protocol: PROTOCOL, endpointFingerprint: from.fingerprint },
      modelIds: [...before.ids], selectedNewIds: [], changes })
      const digest = createHash('sha256').update(canonical({ previewId, revision: plan.revision, target: plan.target,
        changes, sourceBinding: from.binding, localBinding: before.binding })).digest('hex')
      const entry = { owner: who, provider, modelId, plan, value: from.value, localBinding: before.binding,
        sourceBinding: from.binding, expires: time + TTL, digest, state: 'pending', consumed: false,
        authority: Object.freeze(Object.create(null)), proof: Object.freeze(Object.create(null)) }
      capabilities.set(entry.proof, entry)
      pending.set(previewId, entry)
      return { previewId, digest, expiresAt: new Date(entry.expires).toISOString(), revision: plan.revision,
        provider, source: { kind: 'upstream', origin: 'https://openrouter.ai', fetchedAt: from.fetchedAt },
        changes: structuredClone(changes) }
    } catch (error) { return fail(error instanceof CapacityError ? 'SETTINGS_UNAVAILABLE' : 'REPREVIEW_REQUIRED') }
    finally { op?.close() }
  }
  async function apply(owner, request, signal) {
    let entry, id, op, reserved = false, dispatched = false
    try {
      if (!active || !exact(request, ['previewId', 'digest']) || typeof request.previewId !== 'string' || typeof request.digest !== 'string') return fail('REPREVIEW_REQUIRED')
      const who = identity(owner)
      id = request.previewId; entry = pending.get(id)
      if (!entry || entry.owner !== who || entry.state !== 'pending' || entry.digest !== request.digest || now() >= entry.expires) return fail('REPREVIEW_REQUIRED')
      op = operation(signal)
      entry.state = 'reserved' // one winner before the first await, even on failures
      reserved = true
      entry.signal = op.signal
      const latest = await waitFor(limited('source', who, () => loadSource(entry.provider, { signal: op.signal })), op.signal)
      if (!active || op.signal.aborted || pending.get(id) !== entry || now() >= entry.expires) return fail('REPREVIEW_REQUIRED')
      const fresh = source(entry.provider, entry.modelId, latest, now())
      const before = local(entry.provider, entry.modelId)
      if (fresh.binding !== entry.sourceBinding || fresh.value !== entry.value || fresh.revision !== entry.plan.revision ||
          fresh.fingerprint !== entry.plan.target.endpointFingerprint || before.binding !== entry.localBinding || before.maxTokens > fresh.value) return fail('REPREVIEW_REQUIRED')
      entry.latest = latest
      const work = limited('editor', who, () => {
        dispatched = true
        return commit({ owner: entry.owner, authority: entry.authority, proof: entry.proof, plan: entry.plan })
      })
      return await waitFor(work, op.signal)
    } catch (error) {
      // Once handed to the sink, neither abort nor unload proves no write.
      if (dispatched) return fail('OUTCOME_UNKNOWN')
      return fail(error instanceof CapacityError ? 'SETTINGS_UNAVAILABLE' : 'REPREVIEW_REQUIRED')
    } finally {
      op?.close()
      if (reserved) { if (pending.get(id) === entry) pending.delete(id); capabilities.delete(entry.proof) }
    }
  }
  function unload() {
    active = false
    for (const controller of operations) controller.abort()
    for (const entry of pending.values()) capabilities.delete(entry.proof)
    pending.clear()
  }
  return Object.freeze({ preview, apply, unload })
}
