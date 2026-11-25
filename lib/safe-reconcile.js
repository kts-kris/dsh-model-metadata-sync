import { catalogFieldWasAbsent, catalogMatchesTarget, isSafeMetadataText, isValidModelId, isValidUtcTimestamp } from './metadata-source.js';
import { referenceFieldsForTarget, referenceFieldsForTargetForTest } from './reference-catalog.js';

const FIELDS = ['contextWindow', 'maxTokens', 'reasoningEfforts'];
const EFFORT_KEYS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const capacity = (value) => Number.isSafeInteger(value) && value > 0;

function effort(value, allowEmpty = false) {
  if (!record(value)) return null;
  const entries = Object.entries(value);
  if ((!allowEmpty && !entries.some(([key]) => key !== 'off')) || entries.some(([key, wire]) =>
    !EFFORT_KEYS.has(key) || (wire === null ? key !== 'off' : !isSafeMetadataText(wire)))) return null;
  return Object.fromEntries(entries);
}

function projectedValue(field, value) {
  if (value === null || value === false) return value;
  if (field === 'reasoningEfforts') return effort(value, true);
  return capacity(value) ? value : null;
}

function sourceProjection(source) {
  if (!record(source) || !['upstream', 'reference'].includes(source.kind) || !isValidUtcTimestamp(source.fetchedAt)) return null;
  try {
    const url = new URL(source.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    if (source.kind === 'reference' && source.origin !== 'https://models.dev/api.json') return null;
  } catch { return null; }
  return source.kind === 'reference'
    ? { kind: source.kind, origin: 'https://models.dev/api.json', fetchedAt: source.fetchedAt }
    : { kind: source.kind, fetchedAt: source.fetchedAt };
}

function candidateFor(field, candidate, expectedKind = 'upstream') {
  if (!record(candidate) || candidate.state !== 'known') return null;
  const source = sourceProjection(candidate.source);
  if (!source || source.kind !== expectedKind) return null;
  const value = field === 'reasoningEfforts' ? (candidate.complete === true ? effort(candidate.value) : null) :
    (capacity(candidate.value) ? candidate.value : null);
  return value === null ? null : { value, source };
}

function sameValue(a, b) {
  if (a === b) return true;
  if (!record(a) || !record(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => has(b, key) && a[key] === b[key]);
}

function provenAbsent(evidence, routeDefault) {
  return record(evidence) && evidence.explicit === 'absent' && evidence.catalog === 'absent'
    && evidence.routeDefault === routeDefault;
}

// A positive integer constrains the opposite write; null means the Host proved
// the effective value absent; undefined means its value is unknown. Evidence
// must be supplied by the Host from the same authoritative settings revision,
// never by a client. A fallback still constrains the pair until replaced.
function effectiveCapacity(field, configured, route, inherited) {
  if (has(configured, field)) return capacity(configured[field]) ? configured[field] : undefined;
  const defaultKey = field === 'contextWindow' ? 'defaultContextWindow' : 'defaultMaxTokens';
  if (has(route, defaultKey)) return capacity(route[defaultKey]) ? route[defaultKey] : undefined;
  const fact = inherited?.fields?.[field];
  if (!record(fact)) return undefined;
  if ((fact.status === 'catalog' || fact.status === 'provider-default' ||
      (fact.status === 'system-fallback' && provenAbsent(fact.evidence, 'system-default'))) && capacity(fact.value)) return fact.value;
  if (fact.status === 'absent' && fact.value == null && provenAbsent(fact.evidence, 'absent')) return null;
  return undefined;
}

/**
 * Reconcile Host inputs into a safe, path-oriented plan, never a provider/model
 * object. The Host must supply provider, endpoint, protocol, route and effective
 * from the same authoritative settings revision, never from an HTTP body. Only
 * the original immutable upstream catalog has authority; JSON copies and
 * self-declared provenance do not. A reference capability is usable only for
 * its exact original catalog and target; the private bridge rechecks freshness.
 * The Host must revalidate the exact plan and commit it through Host CAS.
 */
function reconcileWithResolver({ provider, endpoint, protocol, route, catalog, selectedNewIds, effective, reference } = {}, resolveReference) {
  const refused = (reason) => ({ status: 'refused', reason, changed: false, changes: [], items: [] });
  if (!catalogMatchesTarget(catalog, { provider, endpoint, protocol })) return refused('catalog-binding-mismatch');
  if (!record(route) || (route.models !== undefined && !Array.isArray(route.models)) ||
      catalog?.status !== 'complete' || catalog.applicable !== true ||
      !Array.isArray(catalog.models) || catalog.models.length === 0 || !Array.isArray(selectedNewIds)) return refused('invalid-or-incomplete');
  const explicit = Array.isArray(route.models) && route.models.length > 0;
  if (explicit && has(route, 'modelOverrides')) return refused('models-and-overrides');
  if (!explicit && route.modelOverrides !== undefined && !record(route.modelOverrides)) return refused('invalid-overrides');
  const currentRows = explicit ? route.models : effective?.status === 'known' && effective.inventoryComplete === true ? effective.models : null;
  if (!Array.isArray(currentRows) || currentRows.length === 0) return refused('unknown-catalog');
  const currentIds = Array.from(currentRows, (row) => record(row) ? row.id : undefined);
  const upstreamIds = Array.from(catalog.models, (row) => record(row) ? row.id : undefined);
  if ([currentIds, upstreamIds, Array.from(selectedNewIds)].some((ids) =>
    ids.some((id) => !isValidModelId(id)) || new Set(ids).size !== ids.length)) return refused('invalid-or-duplicate-id');
  const current = new Set(currentIds);
  const upstream = new Set(upstreamIds);
  if (selectedNewIds.some((id) => current.has(id) || !upstream.has(id))) return refused('invalid-selection');
  if (!explicit && route.modelOverrides && Object.entries(route.modelOverrides).some(([id, value]) =>
    !isValidModelId(id) || !current.has(id) || !record(value) || has(value, 'id'))) return refused('invalid-overrides');
  const selected = new Set(selectedNewIds);
  const effectiveRows = effective?.status === 'known' && Array.isArray(effective.models) ? effective.models : [];
  const effectiveIds = Array.from(effectiveRows, (row) => record(row) ? row.id : undefined);
  if (effectiveIds.some((id) => !isValidModelId(id)) || new Set(effectiveIds).size !== effectiveIds.length) return refused('invalid-effective-state');
  const effectiveById = new Map(effectiveRows.map((row) => [row.id, row]));
  const changes = [];
  const items = catalog.models.map((row) => {
    const modelId = row.id;
    const index = currentIds.indexOf(modelId);
    const existing = index >= 0;
    const selectedNew = !existing && explicit && selected.has(modelId);
    const configured = existing ? (explicit ? currentRows[index] : route.modelOverrides?.[modelId] ?? {}) : {};
    const inherited = effectiveById.get(modelId);
    const fields = [];
    const referenceFields = resolveReference(reference, { catalog, provider, endpoint, protocol, modelId });
    const matchedProtectedCapacities = new Set();
    const itemChangeStart = changes.length;
    for (const field of FIELDS) {
      if (!has(row, field)) continue;
      const upstreamCandidate = candidateFor(field, row[field]);
      const referenceCandidate = candidateFor(field, referenceFields?.[field], 'reference');
      if (upstreamCandidate && referenceCandidate && !sameValue(upstreamCandidate.value, referenceCandidate.value)) {
        fields.push({ field, state: 'conflict', reason: 'source-conflict', candidate: upstreamCandidate.value,
          source: upstreamCandidate.source, referenceCandidate: referenceCandidate.value, referenceSource: referenceCandidate.source });
        continue;
      }
      const candidate = upstreamCandidate ?? (row[field]?.state === 'unknown' &&
        catalogFieldWasAbsent(catalog, modelId, field) ? referenceCandidate : null);
      if (!candidate) {
        const conflict = row[field]?.state === 'conflicting';
        const source = conflict ? sourceProjection(row[field].source) : null;
        fields.push({ field, state: conflict ? 'conflict' : 'unknown', reason: conflict ? 'candidate-conflict' : 'candidate-unknown',
          ...(conflict && capacity(row[field].value) && source?.kind === 'upstream'
            ? { candidate: row[field].value, source } : {}) });
        continue;
      }
      let before;
      let reason;
      let canWrite = false;
      if (has(configured, field)) {
        before = projectedValue(field, configured[field]);
        reason = 'explicit-value';
      } else if ((field === 'contextWindow' && has(route, 'defaultContextWindow')) ||
                 (field === 'maxTokens' && has(route, 'defaultMaxTokens'))) {
        before = projectedValue(field, route[field === 'contextWindow' ? 'defaultContextWindow' : 'defaultMaxTokens']);
        reason = 'provider-default';
      } else {
        const fact = inherited?.fields?.[field];
        if (record(fact) && fact.status === 'catalog') {
          before = projectedValue(field, fact.value);
          reason = 'catalog-value';
        } else if (record(fact) && fact.status === 'provider-default') {
          before = projectedValue(field, fact.value);
          reason = 'provider-default';
        } else if (record(fact) && fact.status === 'absent' && fact.value == null && provenAbsent(fact.evidence, 'absent')) {
          before = null;
          reason = 'absent';
          canWrite = true;
        } else if (field !== 'reasoningEfforts' && record(fact) && fact.status === 'system-fallback' &&
                   capacity(fact.value) && provenAbsent(fact.evidence, 'system-default')) {
          before = fact.value;
          reason = 'system-fallback';
          canWrite = true;
        } else {
          reason = 'effective-state-unknown';
        }
      }
      if (!existing && !selectedNew && canWrite) {
        canWrite = false;
        reason = explicit ? 'model-not-selected' : 'inherited-add-unsupported';
      }
      const state = canWrite ? (sameValue(before, candidate.value) && field !== 'maxTokens' ? 'unchanged' : 'applicable') :
        ['effective-state-unknown', 'model-not-selected', 'inherited-add-unsupported'].includes(reason) ? 'unknown' :
          sameValue(before, candidate.value) ? 'unchanged' : 'conflict';
      if (field !== 'reasoningEfforts' && ['explicit-value', 'provider-default', 'catalog-value'].includes(reason) &&
          capacity(before) && sameValue(before, candidate.value)) matchedProtectedCapacities.add(field);
      fields.push({ field, state, reason, ...(before === undefined ? {} : { before }), candidate: candidate.value, source: candidate.source });
      if (state === 'applicable') changes.push({ type: 'set-field', scope: explicit ? 'models' : 'modelOverrides',
        modelId, ...(explicit ? { index: existing ? index : currentIds.length + upstreamIds.filter((id) => selected.has(id)).indexOf(modelId) } : {}), field, value: candidate.value });
    }
    // Recheck the capacity pair against the values that will actually survive
    // precedence and all proposed writes, rather than against upstream alone.
    // Remove only unsafe capacity writes, never unrelated metadata.
    const contextWrite = changes.slice(itemChangeStart).find((change) => change.field === 'contextWindow');
    const outputWrite = changes.slice(itemChangeStart).find((change) => change.field === 'maxTokens');
    const context = contextWrite?.value ?? effectiveCapacity('contextWindow', configured, route, inherited);
    const output = outputWrite?.value ?? effectiveCapacity('maxTokens', configured, route, inherited);
    if (capacity(context) && capacity(output) && output > context) {
      for (const fieldName of matchedProtectedCapacities) {
        const field = fields.find((entry) => entry.field === fieldName);
        field.state = 'conflict';
        field.reason = 'capacity-conflict';
      }
      for (const write of [contextWrite, outputWrite]) {
        if (!write) continue;
        const field = fields.find((entry) => entry.field === write.field);
        field.state = 'conflict';
        field.reason = 'capacity-conflict';
        changes.splice(changes.indexOf(write), 1);
      }
    } else {
      // An unreadable or invalid surviving opposite value is not proof that it
      // imposes no constraint. A proven absence is deliberately distinct.
      for (const [write, counterpart] of [[contextWrite, output], [outputWrite, context]]) {
        if (!write || counterpart !== undefined) continue;
        const field = fields.find((entry) => entry.field === write.field);
        field.state = 'unknown';
        field.reason = 'counterpart-capacity-unknown';
        changes.splice(changes.indexOf(write), 1);
      }
    }
    const reason = existing ? 'no-candidate' : explicit ? (selectedNew ? 'selected' : 'not-selected') : 'inherited-add-unsupported';
    const item = { modelId, existing, applicable: selectedNew || fields.some((field) => field.state === 'applicable') };
    // The model-level addition status remains visible even when the normalizer
    // also provides per-field unknowns (in particular for inherited routes).
    if (!existing || !fields.length) item.reason = reason;
    if (fields.length) item.fields = fields;
    return item;
  });
  if (explicit) for (const modelId of upstreamIds) {
    if (selected.has(modelId)) changes.push({ type: 'add-model', modelId });
  }
  // Additions precede field writes so a consumer can apply the plan sequentially.
  changes.sort((a, b) => (a.type === 'add-model' ? 0 : 1) - (b.type === 'add-model' ? 0 : 1));
  const warnings = changes.some((change) => change.type === 'set-field' && change.field === 'maxTokens')
    ? ['Setting maxTokens changes the DSH per-request default output limit.'] : [];
  return { status: 'ready', changed: changes.length > 0, changes, items, warnings };
}

/** Host-only production path; no caller-selected resolver or test brand. */
export function reconcileMetadata(options = {}) {
  return reconcileWithResolver(options, referenceFieldsForTarget);
}

/** TESTS ONLY: exercises synthetic capabilities; never expose through Host APIs. */
export function reconcileMetadataForTest(options = {}) {
  return reconcileWithResolver(options, referenceFieldsForTargetForTest);
}
