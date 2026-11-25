import { types } from 'node:util'
import { configuredModelsEndpoint, discoverOpenAIModels } from './generic-adapter.js'
import { catalogMatchesTarget, isSafeMetadataText, isValidModelId } from './metadata-source.js'

const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const forbiddenKey = key => ['__proto__', 'prototype', 'constructor'].includes(key)
const safeSegment = key => typeof key === 'string' && key.length <= 512 && isValidModelId(key)
const safeRef = ref => typeof ref === 'string' && ref.length <= 512 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)
const codes = Object.freeze({
  UNKNOWN_SOURCE: 'Configured upstream source is unavailable.',
  UNSUPPORTED_PROTOCOL: 'Provider protocol is unsupported.',
  INVALID_RESPONSE: 'Model catalog response is invalid.',
  INCOMPLETE_RESPONSE: 'Model catalog discovery did not complete.',
  ORIGIN_REFUSED: 'Network target refused.',
  SETTINGS_UNAVAILABLE: 'Verified provider settings are unavailable.',
  AMBIGUOUS_IDENTITY: 'Provider identity is ambiguous.',
  REVISION_CONFLICT: 'Settings changed during discovery.',
})
const failure = code => ({ status: 'failed', error: { code, message: codes[code] } })
const reject = code => { throw code }
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const builtinBrands = Object.entries(types)
  .filter(([name, check]) => /^is/.test(name) && name !== 'isProxy' && typeof check === 'function')
  .map(([, check]) => check)
const platformBrandGetters = [Object.getOwnPropertyDescriptor(URL.prototype, 'href')?.get,
  Object.getOwnPropertyDescriptor(URLSearchParams.prototype, 'size')?.get].filter(Boolean)

// Do not invoke getters, toJSON, iterators or proxy traps while proving that a
// Host value is JSON data. This is a detached, bounded copy; it is never a
// complete secret inventory and is never delivered to a client.
function copyJson(root) {
  let nodes = 0
  let bytes = 0
  const visiting = new WeakSet()
  function copy(value, depth) {
    if (++nodes > 100000 || depth > 64) reject('SETTINGS_UNAVAILABLE')
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'string') {
      bytes += value.length
      if (bytes > 4 * 1024 * 1024) reject('SETTINGS_UNAVAILABLE')
      return value
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (!value || typeof value !== 'object' || types.isProxy(value) || visiting.has(value)) reject('SETTINGS_UNAVAILABLE')
    const array = Array.isArray(value)
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype) &&
        !(isRecord(value) && Object.getPrototypeOf(value) === null)) reject('SETTINGS_UNAVAILABLE')
    visiting.add(value)
    const keys = Reflect.ownKeys(value)
    if (keys.length > 100000) reject('SETTINGS_UNAVAILABLE')
    const result = array ? [] : Object.create(null)
    const length = array ? Object.getOwnPropertyDescriptor(value, 'length')?.value : 0
    if (array && (!Number.isSafeInteger(length) || length > 100000)) reject('SETTINGS_UNAVAILABLE')
    for (const key of keys) {
      if (typeof key !== 'string' || forbiddenKey(key)) reject('SETTINGS_UNAVAILABLE')
      if (array && key === 'length') continue
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) reject('SETTINGS_UNAVAILABLE')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !has(descriptor, 'value') || !descriptor.enumerable) reject('SETTINGS_UNAVAILABLE')
      Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true })
    }
    if (array && (keys.length !== length + 1 || result.length !== length)) reject('SETTINGS_UNAVAILABLE')
    // Native brand checks detect built-ins after their prototypes are reset.
    if (!array) {
      if (builtinBrands.some(check => check(value))) reject('SETTINGS_UNAVAILABLE')
      for (const getter of platformBrandGetters) {
        let branded = false
        try { getter.call(value); branded = true } catch { /* not this platform type */ }
        if (branded) reject('SETTINGS_UNAVAILABLE')
      }
    }
    visiting.delete(value)
    return result
  }
  const result = copy(root, 0)
  // Only after the entire tree is proven data-only may structuredClone run;
  // it rejects hidden Headers internal slots in the supported runtime. No
  // accessor is invoked, and the returned snapshot remains our manual copy.
  if (root && typeof root === 'object') {
    try { structuredClone(root) } catch { reject('SETTINGS_UNAVAILABLE') }
  }
  return result
}

// Project only directory fields with exact data descriptors; ignore display
// labels, default endpoints and native-auth hints. Unselected property getters
// are never evaluated, and proxy containers are refused before any reflection.
function own(value, key) {
  if (!isRecord(value) || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject('SETTINGS_UNAVAILABLE')
  const desc = Object.getOwnPropertyDescriptor(value, key)
  if (!desc || !has(desc, 'value')) reject('SETTINGS_UNAVAILABLE')
  return desc.value
}
function arrayData(value) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) reject('SETTINGS_UNAVAILABLE')
  const keys = Reflect.ownKeys(value)
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
  if (!Number.isSafeInteger(length) || length > 100000 || keys.length !== length + 1) reject('SETTINGS_UNAVAILABLE')
  const out = []
  for (let i = 0; i < length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i))
    if (!d || !has(d, 'value') || !d.enumerable) reject('SETTINGS_UNAVAILABLE')
    out.push(d.value)
  }
  return out
}
function directory(ctx) {
  const service = ctx?.get?.('llm')
  if (!service || typeof service.listConfigurableProviders !== 'function') reject('SETTINGS_UNAVAILABLE')
  return arrayData(service.listConfigurableProviders()).map(row => ({ row, provider: own(row, 'provider') }))
}
function directoryAddress(row) {
  const ns = own(row, 'settingsNs')
  const path = arrayData(own(row, 'settingsPath'))
  if (!safeSegment(ns) || path.length > 32 || path.some(part => !safeSegment(part))) reject('UNKNOWN_SOURCE')
  return { ns, path }
}
function prefix(a, b) { return a.length <= b.length && a.every((part, i) => part === b[i]) }
function safeHeaders(value) {
  return value === null || isRecord(value) && Reflect.ownKeys(value).length === 0
}
function sourceProfile(provider, route) {
  if (!has(route, 'api') || route.api !== 'openai-completions') reject('UNSUPPORTED_PROTOCOL')
  if (!has(route, 'baseURL') || !configuredModelsEndpoint(route)) reject('UNKNOWN_SOURCE')
  if (has(route, 'headers') && !safeHeaders(route.headers)) reject('UNKNOWN_SOURCE')
  const refs = ['apiKeyEnv', 'credentialRef', 'apiKeyRef']
    .filter(key => has(route, key) && route[key] !== null && route[key] !== '')
    .map(key => route[key])
  if (refs.some(ref => !safeRef(ref)) || new Set(refs).size > 1) reject('UNKNOWN_SOURCE')
  const models = has(route, 'models') ? route.models : []
  if (!Array.isArray(models)) reject('INVALID_RESPONSE')
  const ids = models.map(model => typeof model === 'string' ? model : isRecord(model) ? model.id : undefined)
  if (ids.some(id => !isValidModelId(id)) || new Set(ids).size !== ids.length) reject('INVALID_RESPONSE')
  return { provider, api: route.api, baseURL: route.baseURL,
    ...(refs.length ? { apiKeyEnv: refs[0] } : {}), models: ids.map(id => ({ id })) }
}
function readSnapshot(ctx, provider) {
  const matches = directory(ctx).filter(entry => entry.provider === provider)
  if (matches.length === 0) reject('UNKNOWN_SOURCE')
  if (matches.length !== 1) reject('AMBIGUOUS_IDENTITY')
  const { ns, path } = directoryAddress(matches[0].row)
  const settings = ctx?.get?.('settings')
  if (!settings || typeof settings.describe !== 'function') reject('SETTINGS_UNAVAILABLE')
  const descriptors = arrayData(settings.describe({ redactSecrets: true }))
  const matchesNs = descriptors.filter(row => own(row, 'ns') === ns)
  if (matchesNs.length !== 1) reject('SETTINGS_UNAVAILABLE')
  const descriptor = matchesNs[0]
  const revision = own(descriptor, 'revision')
  if (!Number.isSafeInteger(revision) || revision < 0) reject('SETTINGS_UNAVAILABLE')
  const secrets = copyJson(own(descriptor, 'secrets'))
  if (!Array.isArray(secrets)) reject('SETTINGS_UNAVAILABLE')
  for (const item of secrets) {
    if (!isRecord(item) || !Array.isArray(item.path) || item.path.length > 64 ||
        item.path.some(part => !safeSegment(part)) || typeof item.set !== 'boolean') reject('SETTINGS_UNAVAILABLE')
    if (prefix(path, item.path) || prefix(item.path, path)) reject('UNKNOWN_SOURCE')
  }
  // Only the path is traversed in Host data. Copy the complete selected route,
  // including unknown fields, before deriving any proof or crossing an await.
  let original = own(descriptor, 'value')
  for (const key of path) original = own(original, key)
  const route = copyJson(original)
  if (!isRecord(route)) reject('UNKNOWN_SOURCE')
  const profile = sourceProfile(provider, route)
  return { ns, path, revision, route, profile,
    endpoint: configuredModelsEndpoint(profile), inventory: profile.models.length ? 'explicit' : 'unknown' }
}
function sameSnapshot(first, current) {
  // Route objects are bounded, JSON-shaped, immutable-by-ownership snapshots.
  // This comparison is private and never becomes a logged or public digest.
  return first.revision === current.revision && first.ns === current.ns &&
    JSON.stringify(first.path) === JSON.stringify(current.path) &&
    JSON.stringify(first.route) === JSON.stringify(current.route)
}
function currentMatches(ctx, provider, expected) {
  try { return sameSnapshot(expected, readSnapshot(ctx, provider)) } catch { return false }
}
function decoded(value) {
  const forms = [value]
  for (let i = 0; i < 4; i++) {
    try {
      const next = decodeURIComponent(forms[forms.length - 1])
      if (next === forms[forms.length - 1]) break
      forms.push(next)
    } catch { break }
  }
  return forms
}
function reflectsTarget(catalog, snapshot, credential) {
  const base = new URL(snapshot.profile.baseURL)
  const target = new URL(snapshot.endpoint)
  const privateParts = [snapshot.profile.baseURL, snapshot.endpoint, base.origin, base.host, base.hostname, credential].filter(Boolean)
  for (const path of [base.pathname, target.pathname]) for (const form of decoded(path)) {
    for (const part of form.split('/')) if (part && !/^\.+$/.test(part) && !/^(?:api|models|v\d+(?:beta\d*)?)$/i.test(part)) privateParts.push(part)
  }
  const text = JSON.stringify(catalog)
  return decoded(text).some(form => privateParts.some(part => form.includes(part)) || form.toLowerCase().includes(base.hostname.toLowerCase()))
}

/**
 * Read-only Host seam. `status` is suitable for safe projection; `discover` is
 * strictly Host-internal and returns an ORIGINAL private target-bound catalog,
 * not a client response. Neither method is a route or a preview/write authority.
 * The documented DSH APIs do not provide a secret generation, complete secret
 * inventory, inherited-model proof, or cross-writer commit lock; none is invented.
 *
 * Dependencies are trusted Host services and, optionally, a Host-owned fetch
 * implementation. Requests supply only a primitive exact provider string.
 * A response can still reflect an independent, unenumerable Host secret; known
 * bearer/endpoint checks are defense in depth, not permission to expose it.
 */
export function createHostRuntime(ctx, { fetchImpl = globalThis.fetch } = {}) {
  async function status() {
    try {
      const entries = directory(ctx)
      if (entries.some(entry => !isSafeMetadataText(entry.provider)) ||
          new Set(entries.map(entry => entry.provider)).size !== entries.length) reject('SETTINGS_UNAVAILABLE')
      const llm = ctx?.get?.('llm')
      const settings = ctx?.get?.('settings')
      if (!llm || typeof llm.listProviders !== 'function' || !settings || typeof settings.describe !== 'function') reject('SETTINGS_UNAVAILABLE')
      const registered = arrayData(llm.listProviders()).map(row => own(row, 'id'))
      if (registered.some(id => !isSafeMetadataText(id)) || new Set(registered).size !== registered.length) reject('SETTINGS_UNAVAILABLE')
      const descriptors = arrayData(settings.describe({ redactSecrets: true }))
      const providers = []
      for (const entry of entries) {
        if (!registered.includes(entry.provider)) continue
        const { ns, path } = directoryAddress(entry.row)
        const matches = descriptors.filter(row => own(row, 'ns') === ns)
        if (matches.length !== 1) reject('SETTINGS_UNAVAILABLE')
        let value = own(matches[0], 'value')
        let present = true
        for (const key of path) {
          if (!isRecord(value) || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject('SETTINGS_UNAVAILABLE')
          const field = Object.getOwnPropertyDescriptor(value, key)
          if (!field) { present = false; break }
          if (!has(field, 'value')) reject('SETTINGS_UNAVAILABLE')
          value = field.value
        }
        if (!present) continue
        if (!isRecord(value) || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject('SETTINGS_UNAVAILABLE')
        // No discovery has been started through this route: do not invent a
        // prior success, failure or timestamp, and never project Host values.
        providers.push({ id: entry.provider, status: 'unknown', lastAttemptAt: null })
      }
      return { status: 'available', providers }
    } catch { return failure('SETTINGS_UNAVAILABLE') }
  }
  async function discover(provider) {
    if (!isSafeMetadataText(provider)) return failure('UNKNOWN_SOURCE')
    let snapshot
    try { snapshot = readSnapshot(ctx, provider) } catch (error) {
      return failure(has(codes, error) ? error : 'SETTINGS_UNAVAILABLE')
    }
    let credential
    let changed = false
    try {
      const catalog = await discoverOpenAIModels(snapshot.profile, {
        fetchImpl,
        // Never accept a credential, endpoint, or proof from a call argument.
        resolveCredential: async ref => {
          if (!currentMatches(ctx, provider, snapshot)) { changed = true; throw Error('Target changed.') }
          const credentials = ctx?.get?.('credentials')
          if (!credentials || typeof credentials.resolve !== 'function') throw Error('Credentials unavailable.')
          const hit = await credentials.resolve(ref)
          if (!currentMatches(ctx, provider, snapshot)) { changed = true; throw Error('Target changed.') }
          // ResolvedCredential is Host-owned, but still avoid invoking a getter.
          credential = own(hit, 'value')
          return credential
        },
      })
      if (changed || !currentMatches(ctx, provider, snapshot)) return failure('REVISION_CONFLICT')
      if (catalog?.status !== 'complete') {
        const code = catalog?.error?.code
        return failure(has(codes, code) ? code : 'INVALID_RESPONSE')
      }
      if (!catalogMatchesTarget(catalog, { provider, endpoint: snapshot.endpoint, protocol: snapshot.profile.api }) ||
          reflectsTarget(catalog, snapshot, credential)) return failure('INVALID_RESPONSE')
      return { status: 'complete', revision: snapshot.revision, inventory: snapshot.inventory,
        effective: { status: 'unknown', inventoryComplete: false }, catalog }
    } catch {
      if (changed || !currentMatches(ctx, provider, snapshot)) return failure('REVISION_CONFLICT')
      return failure('INCOMPLETE_RESPONSE')
    }
  }
  return Object.freeze({ status, discover })
}
