import { types } from 'node:util'
import { isValidModelId } from './metadata-source.js'
import { configuredModelsEndpoint } from './generic-adapter.js'

const PI_MODULE = '@deepseek-ai/dsh-llm-pi-ai'
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const positive = value => Number.isSafeInteger(value) && value > 0
const refusal = code => ({ error: { code } })
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  !types.isProxy(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))

// Never execute getters or Proxy traps when establishing presence or absence.
function member(value, key) {
  if (!(plain(value) || Array.isArray(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Array.prototype)) throw Error('unknown')
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor) return { present: false }
  if (!has(descriptor, 'value') || !descriptor.enumerable) throw Error('unknown')
  return { present: true, value: descriptor.value }
}
function required(value, key) {
  const result = member(value, key)
  if (!result.present) throw Error('unknown')
  return result.value
}
function dataArray(value, max = 20000) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > max || Reflect.ownKeys(value).length !== value.length + 1) throw Error('unknown')
  return Array.from({ length: value.length }, (_, index) => required(value, String(index)))
}
function keys(value, expected) {
  return plain(value) && Reflect.ownKeys(value).length === expected.length && expected.every(key => member(value, key).present)
}
function frozenData(value, depth = 0) {
  if (depth > 32) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || types.isProxy(value) || !Object.isFrozen(value)) return false
  if (Array.isArray(value)) return dataArray(value).every(item => frozenData(item, depth + 1))
  if (!plain(value)) return false
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && frozenData(required(value, key), depth + 1))
}
function planFacts(plan) {
  if (!frozenData(plan) || !keys(plan, ['revision', 'target', 'modelIds', 'selectedNewIds', 'changes'])) throw Error('invalid plan')
  const target = required(plan, 'target')
  if (!keys(target, ['namespace', 'provider', 'providerPath', 'protocol', 'endpointFingerprint'])) throw Error('invalid target')
  const namespace = required(target, 'namespace'), provider = required(target, 'provider')
  const path = dataArray(required(target, 'providerPath'), 2)
  const ids = dataArray(required(plan, 'modelIds'))
  const selection = dataArray(required(plan, 'selectedNewIds'))
  const changes = dataArray(required(plan, 'changes'), 1)
  const change = changes[0]
  const revision = required(plan, 'revision')
  if (!isValidModelId(namespace) || !isValidModelId(provider) || path.length !== 2 || path[0] !== 'providers' || path[1] !== provider ||
      required(target, 'protocol') !== 'openai-completions' || !/^[a-f0-9]{64}$/.test(required(target, 'endpointFingerprint')) ||
      !Number.isSafeInteger(revision) || revision < 0 || !ids.length || ids.some(id => !isValidModelId(id)) ||
      new Set(ids).size !== ids.length || selection.length || changes.length !== 1 ||
      !keys(change, ['type', 'scope', 'modelId', 'index', 'field', 'value']) ||
      required(change, 'type') !== 'set-field' || required(change, 'scope') !== 'models' ||
      required(change, 'field') !== 'contextWindow' || !positive(required(change, 'value'))) throw Error('invalid plan')
  const index = required(change, 'index'), modelId = required(change, 'modelId')
  if (!Number.isSafeInteger(index) || index < 0 || ids[index] !== modelId) throw Error('invalid plan')
  return { namespace, provider, path, ids, index, modelId, revision, value: required(change, 'value') }
}
function immutableOpaque(value) {
  return value !== null && typeof value === 'object' && !types.isProxy(value) && Object.isFrozen(value)
}
function entryOptions(entry) {
  // Loader Entry is a class instance; options itself is an own data property.
  // Reject proxies/accessors before reading its profile-provided values.
  if (!entry || typeof entry !== 'object' || types.isProxy(entry)) throw Error('unknown entry')
  const descriptor = Object.getOwnPropertyDescriptor(entry, 'options')
  if (!descriptor || !has(descriptor, 'value') || !descriptor.enumerable || !plain(descriptor.value)) throw Error('unknown entry')
  return descriptor.value
}
function selectEntry(editor, facts) {
  const rows = dataArray(editor.configuration(), 100000)
  const matches = []
  for (const row of rows) {
    const entry = required(row, 'entry')
    const options = entryOptions(entry)
    if (required(options, 'id') === facts.namespace) matches.push({ entry, options })
  }
  if (matches.length !== 1 || required(matches[0].options, 'name') !== PI_MODULE) throw Error('entry unavailable')
  return matches[0].entry
}
function checkDirectory(llm, facts) {
  const rows = dataArray(llm.listConfigurableProviders(), 100000)
  const matches = rows.filter(row => required(row, 'provider') === facts.provider)
  if (matches.length !== 1) throw Error('directory ambiguity')
  const row = matches[0], path = dataArray(required(row, 'settingsPath'), 2)
  if (required(row, 'settingsNs') !== facts.namespace || required(row, 'declared') !== true ||
      path.length !== 2 || path[0] !== facts.path[0] || path[1] !== facts.path[1]) throw Error('directory mismatch')
}
function checkRevision(settings, facts) {
  const rows = dataArray(settings.describe({ redactSecrets: true }), 100000)
  const matches = rows.filter(row => required(row, 'ns') === facts.namespace)
  if (matches.length !== 1 || required(matches[0], 'applies') !== 'live' || required(matches[0], 'revision') !== facts.revision) throw Error('revision mismatch')
}
function inheritedRouteAbsent(inherited, facts) {
  let current = inherited
  for (const key of facts.path) {
    // A raw !!js expression is not an empty object and cannot prove absence.
    if (!plain(current) || member(current, '__jsExpr').present) throw Error('unknown inherited path')
    const next = member(current, key)
    if (!next.present) return true
    current = next.value
  }
  // Even an empty inherited route is refused, rather than pinning it into a
  // complete override. Other config is preserved from current, not recomposed.
  return false
}
function noExpression(value) {
  if (!(plain(value) || Array.isArray(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Array.prototype) ||
      member(value, '__jsExpr').present) throw Error('unknown expression')
}
function copyWith(value, key, replacement) {
  const copy = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value))
  const descriptors = Object.getOwnPropertyDescriptors(value)
  descriptors[key] = { value: replacement, writable: true, enumerable: true, configurable: true }
  return Object.defineProperties(copy, descriptors)
}
function trustedTrue(value) {
  if (value === true) return true
  if (types.isPromise(value)) Promise.prototype.then.call(value, () => {}, () => {})
  return false
}

/**
 * Host-only transaction candidate, deliberately not mounted or exported to a
 * client. The factory's `verify` MUST be a trusted synchronous Host function,
 * independently authenticating the exact immutable plan, one-use owner and
 * opaque authority/proof, the source's original brand, freshness, exact target,
 * candidate/decision and explicit user confirmation. It must also establish any
 * required original-writer/credential conditions. The caller must reserve and
 * consume the authority once across concurrent or sequential calls; this sink
 * does not itself prevent replay. `ctx.get('llm')` must be the real Host-owned
 * directory service, never an adapter selected or constructed from a request.
 * The verifier receives the endpoint only in-process. Neither it nor its proof may come from HTTP, an endpoint, or client
 * data. A boolean supplied in a request or an always-true verifier is not proof.
 *
 * Scope: one contextWindow on one existing explicit-list model. The output cap
 * must be explicitly configured and positive; a fallback or unknown counterpart
 * is deliberately refused. `editor.edit` is entered at most once. Every error
 * after entry is OUTCOME_UNKNOWN, including callback rejection and a lost ack;
 * there is no automatic retry. The editor lock is not a cross-process lock over
 * unrelated writers, credentials, or the source. `configuration()` preflight is
 * not guaranteed side-effect-free: the installed profile loader may retire bundle
 * state. Complete-raw-override effects on unrelated inherited config also need
 * independent review. Before real integration the trusted Host must establish
 * those remaining invariants, safely handle preflight effects, and run isolated
 * installed-runtime tests.
 */
export function createRawContextCommit(ctx, { verify } = {}) {
  if (!ctx || typeof ctx.get !== 'function' || typeof verify !== 'function') throw new TypeError('Trusted Host dependencies required.')
  return async function commit({ owner, authority, proof, plan } = {}) {
    let facts, editor, settings, llm, entry
    try {
      if (![owner, authority, proof].every(immutableOpaque)) return refusal('REPREVIEW_REQUIRED')
      facts = planFacts(plan)
    } catch { return refusal('REPREVIEW_REQUIRED') }
    try {
      editor = ctx.get('configEditor'); settings = ctx.get('settings'); llm = ctx.get('llm')
      if (typeof editor?.configuration !== 'function' || typeof editor?.edit !== 'function' ||
          typeof settings?.describe !== 'function' || typeof llm?.listConfigurableProviders !== 'function') return refusal('SETTINGS_UNAVAILABLE')
      entry = selectEntry(editor, facts)
      checkDirectory(llm, facts)
    } catch { return refusal('SETTINGS_UNAVAILABLE') }
    let authorized = false
    try {
      const receipt = await editor.edit(entry, (current, inherited) => {
        if (authorized || selectEntry(editor, facts) !== entry) throw Error('entry changed')
        checkDirectory(llm, facts)
        checkRevision(settings, facts)
        if (!inheritedRouteAbsent(inherited, facts)) throw Error('inherited route')
        noExpression(current)
        const providers = required(current, 'providers')
        noExpression(providers)
        const route = required(providers, facts.provider)
        noExpression(route)
        if (!plain(route) || member(route, 'modelOverrides').present || member(route, 'defaultContextWindow').present) throw Error('protected route')
        const models = required(route, 'models')
        noExpression(models)
        const list = dataArray(models)
        if (!list.length || list.length !== facts.ids.length) throw Error('models changed')
        const ids = list.map(model => { noExpression(model); return required(model, 'id') })
        if (ids.some((id, index) => id !== facts.ids[index]) || new Set(ids).size !== ids.length) throw Error('models changed')
        const model = list[facts.index]
        if (member(model, 'contextWindow').present) throw Error('protected field')
        const maxTokens = required(model, 'maxTokens')
        if (!positive(maxTokens) || maxTokens > facts.value) throw Error('invalid capacity')
        const protocol = required(route, 'api'), baseURL = required(route, 'baseURL')
        const endpoint = configuredModelsEndpoint({ baseURL })
        if (protocol !== 'openai-completions' || !endpoint) throw Error('target mismatch')
        const evidence = Object.freeze({ owner, authority, proof, plan, revision: facts.revision,
          provider: facts.provider, modelId: facts.modelId, contextWindow: facts.value, maxTokens, protocol, endpoint })
        if (!trustedTrue(verify(evidence))) throw Error('unverified authority')
        authorized = true
        const nextModel = copyWith(model, 'contextWindow', facts.value)
        const nextModels = copyWith(models, String(facts.index), nextModel)
        const nextRoute = copyWith(route, 'models', nextModels)
        const nextProviders = copyWith(providers, facts.provider, nextRoute)
        return copyWith(current, 'providers', nextProviders)
      })
      if (!authorized || receipt !== undefined) return refusal('OUTCOME_UNKNOWN')
      return { status: 'applied' }
    } catch { return refusal('OUTCOME_UNKNOWN') }
  }
}
