import { createHash, createHmac, randomBytes } from 'node:crypto'
import { types } from 'node:util'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHostRuntime } from './host-runtime.js'
import { createSettingsCommit } from './settings-commit.js'
import { isValidModelId } from './metadata-source.js'
import { fetchReferenceSnapshotWithSignal } from './reference-worker-client.js'

const TTL = 5 * 60 * 1000
const MAX_PENDING = 512
const MAX_INFLIGHT = 32
const MAX_OWNER_INFLIGHT = 4
const DEADLINE_MS = 15000
// Shared by all Host service instances loaded from this module.
const globalInflight = new Set(), ownerInflight = new Map()
// Independent permits track the real Host operation, including after the
// caller's deadline/unload: an unresolved resolver must never free its permit.
const credentialInflight = new Set(), ownerCredentials = new Map()
// Plugin inventory calls have their own real-operation quota: an aborted
// wrapper must not free a permit while the Host promise is still pending.
const managerInflight = new Set(), ownerManagers = new Map()
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  !types.isProxy(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const failure = code => ({ error: { code } })
const messages = new Set(['UNKNOWN_SOURCE', 'UNSUPPORTED_PROTOCOL', 'INVALID_RESPONSE', 'INCOMPLETE_RESPONSE',
  'ORIGIN_REFUSED', 'SETTINGS_UNAVAILABLE', 'AMBIGUOUS_IDENTITY', 'REVISION_CONFLICT'])

function own(value, key) {
  if (!record(value) && !(Array.isArray(value) && !types.isProxy(value))) throw Error('invalid data')
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !has(descriptor, 'value')) throw Error('missing data')
  return descriptor.value
}
function array(value, max = 20000) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > max || Reflect.ownKeys(value).length !== value.length + 1) throw Error('invalid array')
  return Array.from({ length: value.length }, (_, index) => own(value, String(index)))
}
function request(value, keys) {
  if (!record(value) || Reflect.ownKeys(value).length !== keys.length ||
      !keys.every(key => has(value, key) && has(Object.getOwnPropertyDescriptor(value, key), 'value'))) return false
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key))
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function strictOwner(value) {
  return typeof value === 'string' && value.length > 0 ||
    value !== null && typeof value === 'object' && !types.isProxy(value) && Object.isFrozen(value)
}

// Only the DSH provider directory supplies the write address. This deliberately
// restricts the transaction to the path understood by the audited commit code.
function address(ctx, provider, expectedRevision) {
  const llm = ctx?.get?.('llm'), settings = ctx?.get?.('settings')
  if (typeof llm?.listConfigurableProviders !== 'function' || typeof settings?.describe !== 'function') throw Error('unavailable')
  const matches = array(llm.listConfigurableProviders(), 100000).filter(row => own(row, 'provider') === provider)
  if (matches.length !== 1) throw Error('ambiguous')
  const namespace = own(matches[0], 'settingsNs')
  const path = array(own(matches[0], 'settingsPath'), 32)
  if (!isValidModelId(namespace) || path.length !== 2 || path[0] !== 'providers' || path[1] !== provider) throw Error('unsupported target')
  const descriptors = array(settings.describe({ redactSecrets: true }), 100000).filter(row => own(row, 'ns') === namespace)
  if (descriptors.length !== 1 || own(descriptors[0], 'revision') !== expectedRevision ||
      own(descriptors[0], 'applies') !== 'live') throw Error('changed')
  return { namespace, providerPath: path }
}

// Private Host seam, NOT an HTTP authorization boundary. ownerIdentity must map
// a Host-authenticated caller to a stable identity; neither owner nor settings
// target is accepted from request JSON. ctx/fetch/clock/conflict proof are trusted
// wiring. This service sends only upstream credentials to the configured origin.
// Its runtime checks reflected configured endpoint and resolved bearer; it cannot
// inventory independently held secrets. No cross-secret or original-writer lock
// is claimed. The sole supported write is an append to a proven, nonempty user
// models list through createSettingsCommit; every metadata field remains unknown.
export function createMetadataService({ ctx, ownerIdentity, SettingsConflictError = class UnclassifiedConflict extends Error {},
  proveNoWriteConflict, fetchImpl = globalThis.fetch, clock = Date.now, referenceSettings } = {}) {
  if (typeof ctx?.get !== 'function' || typeof ownerIdentity !== 'function' || typeof SettingsConflictError !== 'function' ||
      (proveNoWriteConflict !== undefined && typeof proveNoWriteConflict !== 'function') || typeof clock !== 'function') {
    throw new TypeError('Trusted Host dependencies required.')
  }
  const pending = new Map(), inflight = new Set()
  const bindingKey = randomBytes(32)
  let active = true, lastTime = 0
  function now() {
    const value = clock()
    if (!Number.isSafeInteger(value) || value < lastTime || value < 0 || value > 253402300799999 - TTL) throw Error('invalid clock')
    lastTime = value
    return value
  }
  function identity(owner) {
    const value = ownerIdentity(owner)
    return strictOwner(value) ? value : null
  }
  // Admission happens synchronously, before credentials or transport. A slot is
  // owned by exactly one request; late completions cannot release another slot.
  function admit(who, signal) {
    const count = ownerInflight.get(who) ?? 0
    if (!active || signal?.aborted || globalInflight.size >= MAX_INFLIGHT || count >= MAX_OWNER_INFLIGHT) return null
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS)
    inflight.add(controller)
    globalInflight.add(controller)
    ownerInflight.set(who, count + 1)
    let released = false
    return { controller, release() {
      if (released) return
      released = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      inflight.delete(controller)
      globalInflight.delete(controller)
      const remaining = ownerInflight.get(who) - 1
      if (remaining) ownerInflight.set(who, remaining)
      else ownerInflight.delete(who)
    } }
  }
  // Runtime only needs ctx.get. Async-local Host context binds each actual
  // resolve to its owner without changing the runtime's per-service proof keys.
  const requestContext = new AsyncLocalStorage()
  const runtimeContext = { get(name) {
      const service = ctx.get(name)
      if (name !== 'credentials' || typeof service?.resolve !== 'function') return service
      return { resolve(ref) {
        const current = requestContext.getStore()
        if (!current || current.signal.aborted || !active) throw Error('cancelled')
        const { who } = current
        const count = ownerCredentials.get(who) ?? 0
        if (credentialInflight.size >= MAX_INFLIGHT || count >= MAX_OWNER_INFLIGHT) throw Error('credential capacity')
        const permit = {}
        credentialInflight.add(permit)
        ownerCredentials.set(who, count + 1)
        let released = false
        const release = () => {
          if (released) return
          released = true
          credentialInflight.delete(permit)
          const remaining = ownerCredentials.get(who) - 1
          if (remaining) ownerCredentials.set(who, remaining)
          else ownerCredentials.delete(who)
        }
        // Preserve receiver binding and acquire before invoking the real Host.
        // Promise assimilation covers synchronous returns, throws and rejections.
        try { return Promise.resolve(service.resolve(ref)).then(value => { release(); return value }, error => { release(); throw error }) }
        catch (error) { release(); throw error }
      } }
    } }
  const runtime = createHostRuntime(runtimeContext, { fetchImpl })
  // Host-only target proof. Read only redacted descriptor data at the validated
  // provider path, and retain only a keyed digest, never the credential ref or
  // any other route values. The revision gates the read but is deliberately not
  // included: a proven no-write conflict may advance unrelated settings. Bind
  // all three route layers so a changed source or preservation basis cannot be
  // disguised by an unchanged resolved endpoint/diff. Runtime separately checks
  // that its discovery remains at this revision and snapshot.
  // Copy the actual descriptor supplied to commit, not a later describe() call.
  // readState keeps routes across awaits, so it must receive our detached copy;
  // proving one mutable object and then returning the original is insufficient.
  function boundDescriptor(target, descriptor, revision) {
    if (own(descriptor, 'ns') !== target.namespace || own(descriptor, 'revision') !== revision ||
        !Number.isSafeInteger(revision) || revision < 0 || own(descriptor, 'applies') !== 'live') throw Error('changed')
    const layers = ['value', 'user', 'base'].map(name => {
      const missing = Symbol('missing')
      let route = own(descriptor, name)
      for (const key of target.providerPath) {
        if (!record(route)) throw Error('unknown target')
        const property = Object.getOwnPropertyDescriptor(route, key)
        if (!property) { route = missing; break }
        if (!has(property, 'value') || !property.enumerable) throw Error('unknown target')
        route = property.value
      }
      if (route === missing) return { absent: true }
      if (!record(route)) throw Error('unknown target')
      // Structured JSON validation is performed by runtime on the same Host
      // snapshot. Here copy without invoking getters, toJSON, or proxy traps.
      let nodes = 0, bytes = 0
      const visiting = new WeakSet()
      function data(value, depth = 0) {
        if (++nodes > 100000 || depth > 64) throw Error('invalid target')
        if (value === null || typeof value === 'boolean') return value
        if (typeof value === 'number' && Number.isFinite(value)) return value
        if (typeof value === 'string') {
          bytes += value.length
          if (bytes > 4 * 1024 * 1024) throw Error('invalid target')
          return value
        }
        if (!value || typeof value !== 'object' || types.isProxy(value) || visiting.has(value)) throw Error('invalid target')
        const isArray = Array.isArray(value)
        if (isArray ? Object.getPrototypeOf(value) !== Array.prototype : !record(value)) throw Error('invalid target')
        visiting.add(value)
        const keys = Reflect.ownKeys(value)
        if (keys.length > 100000) throw Error('invalid target')
        const out = isArray ? [] : Object.create(null)
        const length = isArray ? Object.getOwnPropertyDescriptor(value, 'length')?.value : 0
        if (isArray && (!Number.isSafeInteger(length) || length > 100000 || keys.length !== length + 1)) throw Error('invalid target')
        for (const key of keys) {
          if (isArray && key === 'length') continue
          if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key) ||
              isArray && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) throw Error('invalid target')
          const property = Object.getOwnPropertyDescriptor(value, key)
          if (!property || !has(property, 'value') || !property.enumerable) throw Error('invalid target')
          Object.defineProperty(out, key, { value: data(property.value, depth + 1), enumerable: true })
        }
        if (isArray && out.length !== length) throw Error('invalid target')
        visiting.delete(value)
        return out
      }
      return { present: data(route) }
    })
    const digest = createHmac('sha256', bindingKey).update(canonical({ target, layers })).digest('hex')
    const snapshot = { ns: target.namespace, revision, applies: 'live', secrets: [] }
    for (let i = 0; i < layers.length; i++) {
      let root = Object.create(null), node = root
      const path = target.providerPath
      for (const key of path.slice(0, -1)) node = node[key] = Object.create(null)
      if (has(layers[i], 'present')) node[path.at(-1)] = layers[i].present
      snapshot[['value', 'user', 'base'][i]] = root
    }
    // Never manufacture absence of a redacted path. Preserve an exact, detached
    // representation of every advertised secret path for commit's own checks.
    snapshot.secrets = array(own(descriptor, 'secrets'), 100000).map(secret => {
      const path = array(own(secret, 'path'), 64)
      const set = own(secret, 'set')
      if (path.some(key => typeof key !== 'string') || typeof set !== 'boolean') throw Error('invalid secrets')
      return { path, set }
    })
    return { digest, snapshot }
  }
  function binding(provider, revision) {
    const target = address(ctx, provider, revision)
    const descriptors = array(ctx.get('settings').describe({ redactSecrets: true }), 100000)
      .filter(row => own(row, 'ns') === target.namespace)
    if (descriptors.length !== 1) throw Error('changed')
    return boundDescriptor(target, descriptors[0], revision).digest
  }
  function collect(projected, attemptedAt, inventory, reference) {
    // Explicit projection and known endpoint/bearer checks are not a complete
    // Host secret inventory. No raw reference records or provider descriptor is
    // returned; source status is displayed, not accepted as field evidence.
    const items = projected.items.map(item => ({ ...item, applicable: item.reason === 'selected' }))
    return { provider: projected.provider, selectedNewIds: projected.selectedNewIds,
      items, changes: projected.changes,
      warnings: ['Only selected new IDs can be applied; metadata fields are not applied.',
        'Known endpoint and credential values are filtered; other Host secrets and concurrent writers cannot be fully enumerated.'],
      writeEnabled: inventory === 'explicit', sources: {
        upstream: { kind: 'upstream', status: 'success', lastAttemptAt: attemptedAt },
        reference,
      } }
  }
  function referenceEnabled() {
    // Direct service consumers predating Host mounting have no reference
    // preference and must never start the production worker implicitly.
    if (referenceSettings === undefined) return false
    const value = referenceSettings?.getReferenceEnabled?.()
    if (typeof value !== 'boolean') throw Error('preference unavailable')
    return value
  }
  async function discover(runtime, provider, selectedNewIds, signal, attemptedAt = new Date(now()).toISOString()) {
    const enabled = referenceEnabled()
    const result = await runtime.discover(provider, { signal })
    if (result?.status !== 'complete') return failure(messages.has(result?.error?.code) ? result.error.code : 'SETTINGS_UNAVAILABLE')
    // Host runtime owns the target-bound discovery and project brands. The
    // explicitly read-only catalog may be displayed, but never committed.
    const writableCatalog = result.catalog?.applicable === true
    if (!writableCatalog && result.catalog?.applicable !== false) return failure('SETTINGS_UNAVAILABLE')
    if (!Array.isArray(result.catalog.models) || !result.catalog.models.length) return failure('INVALID_RESPONSE')
    if (signal.aborted || !active || referenceEnabled() !== enabled) return failure('REVISION_CONFLICT')
    let reference = { kind: 'reference', status: 'disabled', lookupIdentifiers: ['provider', 'modelId', 'protocol'] }
    if (enabled) {
      let snapshot
      try { snapshot = await fetchReferenceSnapshotWithSignal(signal) } catch { /* unavailable */ }
      if (signal.aborted || !active || referenceEnabled() !== enabled) return failure('REVISION_CONFLICT')
      // No production reference identity/field semantics are proven. Preserve
      // whether the bounded anonymous worker succeeded, not its raw records.
      reference = { kind: 'reference', status: 'unknown', reason: 'unproven-reference',
        lookupStatus: snapshot?.status === 'complete' ? 'complete' : 'unknown', lookupIdentifiers: ['provider', 'modelId', 'protocol'] }
    }
    const projected = runtime.project(result, provider, selectedNewIds)
    if (projected?.status !== 'complete') return failure(messages.has(projected?.error?.code) ? projected.error.code : 'SETTINGS_UNAVAILABLE')
    // Enforce the supported surface independently of runtime projection. Future
    // source work may expose candidate fields but cannot add set-field writes.
    if (!Array.isArray(projected.changes) || projected.changes.some(change =>
      change?.type !== 'add-model' || typeof change.modelId !== 'string' ||
      Reflect.ownKeys(change).length !== 2)) return failure('SETTINGS_UNAVAILABLE')
    const target = address(ctx, provider, projected.revision)
    const sourceBinding = binding(provider, projected.revision)
    // Reject a changed snapshot after deriving the binding, before it can be
    // associated with this runtime-owned discovery.
    if (runtime.project(result, provider, selectedNewIds)?.status !== 'complete') return failure('REVISION_CONFLICT')
    const plan = freeze({ target: { ...target, provider, protocol: 'openai-completions', endpointFingerprint: projected.fingerprint },
      selectedNewIds: [...projected.selectedNewIds], changes: projected.changes.map(change => ({ ...change })) })
    if (referenceEnabled() !== enabled || signal.aborted || !active) return failure('REVISION_CONFLICT')
    const view = collect(projected, attemptedAt, result.inventory, reference)
    if (!writableCatalog) {
      view.writeEnabled = false
      for (const item of view.items) item.applicable = false
      view.authority = 'unavailable'
      view.warnings = ['This source is display-only; no displayed additions or fields can be applied.',
        'Known endpoint and credential values are filtered; other Host secrets and concurrent writers cannot be fully enumerated.']
    }
    return { result, projected, plan, sourceBinding, writableCatalog, referenceEnabled: enabled, view }
  }
  async function preview(owner, input, signal) {
    let slot
    try {
      const who = identity(owner)
      if (!active || !who || !request(input, ['provider', 'selectedNewIds'])) return failure('INVALID_RESPONSE')
      const provider = own(input, 'provider'), selected = array(own(input, 'selectedNewIds'))
      if (!isValidModelId(provider) || selected.some(id => !isValidModelId(id)) || new Set(selected).size !== selected.length) return failure('INVALID_RESPONSE')
      slot = admit(who, signal)
      if (!slot) return failure('SETTINGS_UNAVAILABLE')
      const { controller } = slot
      const found = await requestContext.run({ who, signal: controller.signal }, () => discover(runtime, provider, selected, controller.signal))
      if (!active || controller.signal.aborted) return failure('REPREVIEW_REQUIRED')
      if (found.error) return found
      const time = now()
      if (!found.writableCatalog) {
        // Display has no token, digest, or pending entry to confirm. A selected
        // hypothetical addition is visible but never granted authority.
        return { expiresAt: new Date(time + TTL).toISOString(), revision: found.projected.revision,
          ...structuredClone(found.view) }
      }
      for (const [key, entry] of pending) if (entry.expires <= time && entry.state === 'pending') pending.delete(key)
      if (pending.size >= MAX_PENDING) return failure('SETTINGS_UNAVAILABLE')
      const previewId = randomBytes(32).toString('base64url')
      if (pending.has(previewId)) return failure('SETTINGS_UNAVAILABLE')
      // Each random preview ID is server-side mapped to the authenticated owner;
      // binding it into the digest binds confirmation to that very owner/token.
      const digest = createHash('sha256').update(canonical({ ownerBoundPreview: previewId, revision: found.projected.revision,
        target: found.plan.target, sourceBinding: found.sourceBinding, view: found.view })).digest('hex')
      pending.set(previewId, { who, expires: time + TTL, digest, state: 'pending', revision: found.projected.revision,
        sourceBinding: found.sourceBinding, referenceEnabled: found.referenceEnabled, plan: found.plan, view: freeze(structuredClone(found.view)) })
      return { previewId, expiresAt: new Date(time + TTL).toISOString(), revision: found.projected.revision,
        digest, ...structuredClone(found.view) }
    } catch { return failure('SETTINGS_UNAVAILABLE') }
    finally { slot?.release() }
  }
  function cancel(owner, input) {
    try {
      const who = identity(owner)
      if (!active || !who || !request(input, ['previewId']) || typeof input.previewId !== 'string') return { status: 'not-found' }
      const entry = pending.get(input.previewId)
      if (!entry || entry.who !== who || entry.state !== 'pending' || now() >= entry.expires) return { status: 'not-found' }
      pending.delete(input.previewId)
      return { status: 'cancelled' }
    } catch { return { status: 'not-found' } }
  }
  async function apply(owner, input, signal) {
    let entry, id, slot, reserved = false
    try {
      const who = identity(owner)
      if (!active || !who || !request(input, ['previewId', 'digest']) ||
          typeof input.previewId !== 'string' || typeof input.digest !== 'string') return failure('REPREVIEW_REQUIRED')
      id = input.previewId
      entry = pending.get(id)
      if (!entry || entry.who !== who || entry.state !== 'pending') return failure('REPREVIEW_REQUIRED')
      if (now() >= entry.expires || input.digest !== entry.digest) {
        pending.delete(id)
        return failure('REPREVIEW_REQUIRED')
      }
      slot = admit(who, signal)
      if (!slot) return failure('SETTINGS_UNAVAILABLE')
      entry.state = 'reserved' // reserve synchronously, before any await
      reserved = true
      const settings = ctx.get('settings'), manager = ctx.get('pluginManager')
      if (typeof settings?.describe !== 'function' || typeof settings?.mutate !== 'function' ||
          typeof manager?.listPlugins !== 'function') return failure('SETTINGS_UNAVAILABLE')
      const { controller } = slot
      let attempts = 0, latest, snapshotChanged = false
      const valid = () => active && !controller.signal.aborted && pending.get(id) === entry && now() < entry.expires
      const wrappedSettings = {
        describe: options => {
          if (!valid()) throw Error('stale')
          const target = { namespace: entry.plan.target.namespace, providerPath: entry.plan.target.providerPath }
          const descriptors = array(settings.describe(options), 100000)
            .filter(row => own(row, 'ns') === target.namespace)
          if (descriptors.length !== 1) throw Error('changed')
          const revision = own(descriptors[0], 'revision')
          const result = boundDescriptor(target, descriptors[0], revision)
          if (result.digest !== entry.sourceBinding) { snapshotChanged = true; throw Error('changed') }
          return [result.snapshot]
        },
        mutate: (namespace, ops, revision) => {
          // No await between final local checks and dispatch. This is NOT an
          // atomic writer/secret lock; mutate's own revision check is the CAS.
          if (!valid() || !latest || latest.projected.revision !== revision || namespace !== entry.plan.target.namespace ||
              referenceEnabled() !== entry.referenceEnabled) throw Error('stale')
          const projection = runtime.project(latest.result, entry.plan.target.provider, entry.plan.selectedNewIds)
          if (projection.status !== 'complete' || canonical(collect(projection, entry.view.sources.upstream.lastAttemptAt, latest.result.inventory, latest.view.sources.reference)) !== canonical(entry.view) ||
              canonical(address(ctx, entry.plan.target.provider, revision)) !== canonical({ namespace, providerPath: entry.plan.target.providerPath }) ||
              projection.fingerprint !== entry.plan.target.endpointFingerprint || binding(entry.plan.target.provider, revision) !== entry.sourceBinding ||
              runtime.project(latest.result, entry.plan.target.provider, entry.plan.selectedNewIds)?.status !== 'complete') throw Error('stale')
          return settings.mutate(namespace, ops, revision)
        },
      }
      const wrappedManager = { async listPlugins() {
        let onAbort
        const cancelled = new Promise((_, reject) => {
          onAbort = () => reject(Error('stale'))
          controller.signal.addEventListener('abort', onAbort, { once: true })
          if (controller.signal.aborted) onAbort()
        })
        try {
          const rows = await Promise.race([Promise.resolve().then(() => {
            if (!valid()) throw Error('stale')
            const count = ownerManagers.get(who) ?? 0
            if (managerInflight.size >= MAX_INFLIGHT || count >= MAX_OWNER_INFLIGHT) throw Error('manager capacity')
            const permit = {}
            managerInflight.add(permit)
            ownerManagers.set(who, count + 1)
            let released = false
            const release = () => {
              if (released) return
              released = true
              managerInflight.delete(permit)
              const remaining = ownerManagers.get(who) - 1
              if (remaining) ownerManagers.set(who, remaining)
              else ownerManagers.delete(who)
            }
            // Keep the permit until the actual Host result settles, not until
            // this wrapper's abort race finishes. Preserve the Host receiver.
            try { return Promise.resolve(manager.listPlugins()).then(value => { release(); return value }, error => { release(); throw error }) }
            catch (error) { release(); throw error }
          }), cancelled])
          if (!valid()) throw Error('stale')
          return rows
        } finally { controller.signal.removeEventListener('abort', onAbort) }
      } }
      const commit = createSettingsCommit({ settings: wrappedSettings, pluginManager: wrappedManager,
        SettingsConflictError, proveNoWriteConflict, recompute: async ({ namespace, revision }) => {
          attempts++
          if (!valid() || referenceEnabled() !== entry.referenceEnabled || namespace !== entry.plan.target.namespace || attempts === 1 && revision !== entry.revision) {
            return { plan: Object.freeze({}), evidence: { revision, fields: [] } }
          }
          // Compare the private binding even after a proven conflict advances
          // the revision. A new reference or target/preservation basis requires
          // another preview even when the endpoint and public diff are unchanged.
          if (binding(entry.plan.target.provider, revision) !== entry.sourceBinding) {
            return { plan: Object.freeze({}), evidence: { revision, fields: [] } }
          }
          latest = await requestContext.run({ who, signal: controller.signal }, () =>
            discover(runtime, entry.plan.target.provider, entry.plan.selectedNewIds, controller.signal, entry.view.sources.upstream.lastAttemptAt))
          if (!valid() || latest.error || latest.projected.revision !== revision || latest.sourceBinding !== entry.sourceBinding ||
              canonical(latest.plan) !== canonical(entry.plan) || canonical(latest.view) !== canonical(entry.view)) {
            return { plan: Object.freeze({}), evidence: { revision, fields: [] } }
          }
          return { plan: latest.plan, evidence: { revision, fields: [] } }
        } })
      const outcome = await commit(entry.plan)
      return snapshotChanged && outcome.error?.code === 'SETTINGS_UNAVAILABLE' ? failure('REPREVIEW_REQUIRED') : outcome
    } catch { return failure('SETTINGS_UNAVAILABLE') }
    finally {
      slot?.release()
      if (reserved && pending.get(id) === entry) pending.delete(id)
    }
  }
  function unload() {
    active = false
    pending.clear()
    for (const controller of inflight) controller.abort()
  }
  return Object.freeze({ preview, apply, cancel, unload })
}
