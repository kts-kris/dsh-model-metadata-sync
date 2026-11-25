import { isDeepStrictEqual, types } from 'node:util'
import { isSafeMetadataText, isValidModelId } from './metadata-source.js'

const has = (v, k) => Object.prototype.hasOwnProperty.call(v, k)
const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !types.isProxy(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v))
const positive = v => Number.isSafeInteger(v) && v > 0
const error = code => ({ error: { code } })
const FIELDS = new Set(['contextWindow', 'maxTokens', 'reasoningEfforts'])
const EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const ORIGINAL = '@goodandready/dsh-model-sync'

// Read only own data properties, without evaluating a caller/descriptor getter.
function get(object, key) {
  if (!isRecord(object) && !(Array.isArray(object) && !types.isProxy(object))) throw Error('invalid data')
  const property = Object.getOwnPropertyDescriptor(object, key)
  if (!property || !has(property, 'value')) throw Error('missing data')
  return property.value
}
function maybe(object, key) {
  if (!isRecord(object)) throw Error('invalid object')
  return has(object, key) ? { present: true, value: get(object, key) } : { present: false }
}
function array(input, max = 20000) {
  if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > max ||
      Reflect.ownKeys(input).length !== input.length + 1) throw Error('invalid array')
  return Array.from({ length: input.length }, (_, index) => get(input, String(index)))
}
function pathRead(root, path) { return path.reduce(get, root) }
function same(left, right) { return isDeepStrictEqual(left, right) }
function frozenData(input, depth = 0) {
  if (depth > 32) return false
  if (input === null || typeof input === 'boolean' || typeof input === 'string') return true
  if (typeof input === 'number') return Number.isFinite(input)
  if (!input || typeof input !== 'object' || types.isProxy(input) || !Object.isFrozen(input)) return false
  if (Array.isArray(input)) return array(input).every(value => frozenData(value, depth + 1))
  if (!isRecord(input)) return false
  return Reflect.ownKeys(input).every(key => typeof key === 'string' &&
    Object.getOwnPropertyDescriptor(input, key)?.enumerable === true && frozenData(get(input, key), depth + 1))
}
function exactKeys(value, keys) {
  return isRecord(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => has(value, key))
}
function candidateValid(field, value) {
  if (field !== 'reasoningEfforts') return positive(value)
  if (!isRecord(value)) return false
  const keys = Reflect.ownKeys(value)
  return keys.length > 0 && keys.some(key => key !== 'off') && keys.every(key =>
    typeof key === 'string' && EFFORTS.has(key) && (key === 'off' && get(value, key) === null || isSafeMetadataText(get(value, key))))
}
function prefix(a, b) { return a.length <= b.length && a.every((part, index) => part === b[index]) }

function validatePlan(plan) {
  if (!frozenData(plan) || !exactKeys(plan, ['target', 'selectedNewIds', 'changes'])) throw Error('invalid plan')
  const target = get(plan, 'target')
  if (!exactKeys(target, ['namespace', 'provider', 'providerPath', 'protocol', 'endpointFingerprint'])) throw Error('invalid target')
  const ns = get(target, 'namespace'), provider = get(target, 'provider'), path = array(get(target, 'providerPath'), 2)
  if (!isValidModelId(ns) || !isValidModelId(provider) || path.length !== 2 || path[0] !== 'providers' || path[1] !== provider ||
      get(target, 'protocol') !== 'openai-completions' || !/^[a-f0-9]{64}$/.test(get(target, 'endpointFingerprint'))) throw Error('invalid target')
  const selected = array(get(plan, 'selectedNewIds'))
  if (selected.some(id => !isValidModelId(id)) || new Set(selected).size !== selected.length) throw Error('invalid selection')
  const changes = array(get(plan, 'changes'), 60000)
  const additions = [], fieldKeys = new Set()
  for (const change of changes) {
    if (get(change, 'type') === 'add-model') {
      if (!exactKeys(change, ['type', 'modelId']) || !isValidModelId(get(change, 'modelId'))) throw Error('invalid addition')
      additions.push(get(change, 'modelId'))
    } else {
      if (!exactKeys(change, ['type', 'scope', 'modelId', 'index', 'field', 'value']) || get(change, 'type') !== 'set-field' ||
          get(change, 'scope') !== 'models' || !isValidModelId(get(change, 'modelId')) ||
          !Number.isSafeInteger(get(change, 'index')) || get(change, 'index') < 0 || !FIELDS.has(get(change, 'field')) ||
          !candidateValid(get(change, 'field'), get(change, 'value'))) throw Error('invalid field')
      const key = `${change.modelId}\0${change.field}`
      if (fieldKeys.has(key)) throw Error('duplicate field')
      fieldKeys.add(key)
    }
  }
  if (!same(additions, selected)) throw Error('different selection')
  return { ns, path, selected, changes }
}

function readState(settings, info) {
  const matches = array(settings.describe({ redactSecrets: true })).filter(row => get(row, 'ns') === info.ns)
  if (matches.length !== 1) throw Error('namespace not unique')
  const descriptor = matches[0], revision = get(descriptor, 'revision')
  if (!Number.isSafeInteger(revision) || revision < 0 || get(descriptor, 'applies') !== 'live') throw Error('invalid revision')
  const secrets = array(get(descriptor, 'secrets'), 100000)
  for (const secret of secrets) {
    const secretPath = array(get(secret, 'path'), 64)
    if (secretPath.some(key => typeof key !== 'string') || typeof get(secret, 'set') !== 'boolean' ||
        prefix(info.path, secretPath) || prefix(secretPath, info.path)) throw Error('redacted target')
  }
  const user = pathRead(get(descriptor, 'user'), info.path)
  const effective = pathRead(get(descriptor, 'value'), info.path)
  const inherited = pathRead(get(descriptor, 'base'), info.path)
  for (const route of [user, effective, inherited]) if (!isRecord(route)) throw Error('unknown route')
  // A projected value may materialize an empty modelOverrides dict. Inspect the
  // raw user/base layers; any explicit override, including {}, prevents a write.
  if (maybe(user, 'modelOverrides').present || maybe(inherited, 'modelOverrides').present) throw Error('overrides present')
  const models = array(get(user, 'models'))
  const resolved = array(get(effective, 'models'))
  const inheritedModelsField = maybe(inherited, 'models')
  const inheritedModels = inheritedModelsField.present ? array(inheritedModelsField.value) : []
  const inheritedById = new Map()
  for (const model of inheritedModels) {
    const id = get(model, 'id')
    if (!isValidModelId(id) || inheritedById.has(id)) throw Error('unknown inherited model identity')
    inheritedById.set(id, model)
  }
  if (!models.length || models.length !== resolved.length) throw Error('explicit models required')
  const ids = models.map((model, index) => {
    const id = get(model, 'id')
    if (!isValidModelId(id) || get(resolved[index], 'id') !== id) throw Error('unknown model identity')
    return id
  })
  if (new Set(ids).size !== ids.length) throw Error('duplicate models')
  return { revision, user, effective, inherited, models, resolved, inheritedById, ids }
}

async function originalInactive(pluginManager) {
  const rows = array(await pluginManager.listPlugins(), 100000)
  for (const row of rows) {
    const moduleName = get(row, 'moduleName')
    if (typeof moduleName !== 'string' || !moduleName) return false
    if (moduleName === ORIGINAL && (get(row, 'enabled') !== false || get(row, 'fiberPhase') !== null)) return false
  }
  return true
}

function operations(info, current, evidence) {
  if (!isRecord(evidence) || get(evidence, 'revision') !== current.revision) throw Error('unknown evidence')
  const facts = array(get(evidence, 'fields'), 60000)
  const factMap = new Map()
  for (const fact of facts) {
    const key = `${get(fact, 'modelId')}\0${get(fact, 'field')}`
    if (factMap.has(key)) throw Error('duplicate evidence')
    factMap.set(key, fact)
  }
  const ids = [...current.ids], ops = []
  const capacity = new Map()
  for (const change of info.changes) {
    if (change.type === 'add-model') {
      if (ids.includes(change.modelId)) throw Error('model exists')
      ops.push({ op: 'set', path: [...info.path, 'models', String(ids.length)], value: { id: change.modelId } })
      ids.push(change.modelId)
      continue
    }
    if (ids[change.index] !== change.modelId) throw Error('model index changed')
    const existing = change.index < current.ids.length
    const inheritedModel = current.inheritedById.get(change.modelId)
    const visibleModels = [existing && current.models[change.index], existing && current.resolved[change.index], inheritedModel].filter(Boolean)
    if (visibleModels.some(model => maybe(model, change.field).present)) throw Error('model field is configured')
    const fact = factMap.get(`${change.modelId}\0${change.field}`)
    if (!fact || get(fact, 'explicit') !== 'absent' || get(fact, 'catalog') !== 'absent') throw Error('unknown inheritance')
    const status = get(fact, 'status'), routeDefault = get(fact, 'routeDefault')
    if (!(status === 'absent' && routeDefault === 'absent') &&
        !(change.field !== 'reasoningEfforts' && status === 'system-fallback' && routeDefault === 'system-default')) throw Error('unknown default')
    if (change.field !== 'reasoningEfforts') {
      const defaultKey = change.field === 'contextWindow' ? 'defaultContextWindow' : 'defaultMaxTokens'
      const visibleRoutes = [current.user, current.inherited, current.effective]
      if (visibleRoutes.some(route => maybe(route, defaultKey).present)) throw Error('configured default')
      const counterpart = get(fact, 'counterpart')
      if (counterpart !== null && !positive(counterpart)) throw Error('unknown counterpart')
      const opposite = change.field === 'contextWindow' ? 'maxTokens' : 'contextWindow'
      const oppositeDefault = change.field === 'contextWindow' ? 'defaultMaxTokens' : 'defaultContextWindow'
      // A projected base or effective layer may combine inherited fields and
      // schema defaults. Without provenance we cannot silently ignore a visible
      // contradiction, even if another layer takes precedence in some cases.
      const visible = [...visibleModels.map(model => maybe(model, opposite)),
        ...visibleRoutes.map(route => maybe(route, oppositeDefault))]
      if (visible.some(item => item.present && (!positive(item.value) || item.value !== counterpart))) {
        throw Error('counterpart mismatch')
      }
      const pair = capacity.get(change.modelId) ?? {}
      pair[change.field] = change.value
      pair[opposite] ??= counterpart
      capacity.set(change.modelId, pair)
    }
    ops.push({ op: 'set', path: [...info.path, 'models', String(change.index), change.field], value: structuredClone(change.value) })
  }
  for (const pair of capacity.values()) if (positive(pair.contextWindow) && positive(pair.maxTokens) && pair.maxTokens > pair.contextWindow) throw Error('capacity conflict')
  return ops
}

/**
 * Host-only commit primitive, never an HTTP handler or an authorization service.
 * Caller MUST consume a one-use, unexpired, owner-bound confirmed immutable plan,
 * validate credentials/source/target identity and recompute that exact plan from
 * the indicated revision. Caller provides independently verified catalog/default
 * evidence: redacted Settings forms cannot establish installed-model inheritance.
 * `proveNoWriteConflict` must prove the specific thrown real SettingsConflictError
 * occurred before persistence; error class/code alone cannot prove that. It is
 * trusted Host wiring, not client data. Omit it to disable all automatic retries.
 * `listPlugins` and credential checks are not atomic with mutate: no cross-process
 * exclusion or secret-generation guarantee is claimed. Real integration must be
 * verified separately. Inputs/results/errors must not be logged as raw descriptors.
 */
export function createSettingsCommit({ settings, pluginManager, recompute, SettingsConflictError, proveNoWriteConflict } = {}) {
  if (typeof settings?.describe !== 'function' || typeof settings?.mutate !== 'function' ||
      typeof pluginManager?.listPlugins !== 'function' || typeof recompute !== 'function' ||
      typeof SettingsConflictError !== 'function' || (proveNoWriteConflict !== undefined && typeof proveNoWriteConflict !== 'function')) {
    throw new TypeError('Trusted Host settings dependencies required.')
  }
  return async function commit(approved) {
    let info
    try { info = validatePlan(approved) } catch { return error('REPREVIEW_REQUIRED') }
    for (let attempt = 0; attempt < 3; attempt++) {
      let snapshot, result, ops
      try {
        snapshot = readState(settings, info)
        if (!await originalInactive(pluginManager)) return error('ORIGINAL_WRITER_ACTIVE')
        // Only the namespace and revision cross this boundary, never descriptors,
        // route objects, unknown model fields, headers or credentials.
        result = await recompute({ namespace: info.ns, revision: snapshot.revision })
        if (!isRecord(result) || !frozenData(get(result, 'plan')) || !same(get(result, 'plan'), approved)) return error('REPREVIEW_REQUIRED')
        ops = operations(info, snapshot, get(result, 'evidence'))
        // Recheck immediately before mutate (the async recompute can be slow).
        if (!await originalInactive(pluginManager)) return error('ORIGINAL_WRITER_ACTIVE')
      } catch { return error('SETTINGS_UNAVAILABLE') }
      if (!ops.length) return { status: 'unchanged' }
      try {
        const ack = await settings.mutate(info.ns, ops, snapshot.revision)
        if (ack !== undefined) return error('OUTCOME_UNKNOWN')
        return { status: 'applied' }
      } catch (cause) {
        let conflict = false
        try {
          conflict = cause instanceof SettingsConflictError && cause.code === 'SETTINGS_CONFLICT' &&
            cause.expected === snapshot.revision && Number.isSafeInteger(cause.actual) && cause.actual !== cause.expected &&
            typeof proveNoWriteConflict === 'function' && proveNoWriteConflict(cause) === true
        } catch { /* no verified receipt */ }
        if (!conflict) return error('OUTCOME_UNKNOWN')
        if (attempt === 2) return error('REVISION_CONFLICT')
      }
    }
    return error('REVISION_CONFLICT')
  }
}
