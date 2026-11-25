import { boundedFetch } from './safe-fetch.js';
import { catalogMatchesTarget, isSafeMetadataText, isValidModelId } from './metadata-source.js';
import { fetchReferenceSnapshot, fetchReferenceSnapshotWithSignal, isProductionReferenceSnapshot,
  referenceSnapshotMatchesController, referenceSnapshotReceiptTime } from './reference-worker-client.js';

// Only Host-owned signals are accepted. The worker independently validates the
// signal; the native accessor also prevents a cancelled result becoming a capability.
const readAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const signalActive = signal => {
  if (signal === undefined) return true;
  try { return readAborted.call(signal) === false; } catch { return false; }
};

const REFERENCE_URL = 'https://models.dev/api.json';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const positiveCapacity = (value) => Number.isSafeInteger(value) && value > 0;

function validModel(model) {
  if (!plainObject(model) || Object.hasOwn(model, 'error') || Object.hasOwn(model, 'errors')) return false;
  if (!Object.hasOwn(model, 'limit')) return true;
  const limit = model.limit;
  if (!plainObject(limit)) return false;
  for (const field of ['context', 'input', 'output']) {
    if (Object.hasOwn(limit, field) && !positiveCapacity(limit[field])) return false;
  }
  return !Object.hasOwn(limit, 'context') ||
    ['input', 'output'].every((field) => !Object.hasOwn(limit, field) || limit[field] <= limit.context);
}

/**
 * Host-only: fetch the fixed public snapshot without accepting upstream request
 * data. `clock` and `transport` are Host-controlled dependencies, never supplied
 * by a client; unvalidated returned records are not a client response.
 */
export async function fetchReferenceCatalog({ enabled = true, clock = () => new Date().toISOString(), transport } = {}) {
  if (enabled === false) return { status: 'disabled', records: [] };
  const result = await boundedFetch({
    source: 'reference', mode: 'json', url: REFERENCE_URL,
    ...(transport === undefined ? {} : { fetchImpl: transport }),
  });
  if (!result.ok) return { status: 'unknown', records: [], reason: 'reference-unavailable' };
  let fetchedAt;
  try { fetchedAt = clock(); } catch { /* fail without exposing caller error */ }
  if (!Number.isFinite(utcTime(fetchedAt))) return { status: 'unknown', records: [], reason: 'invalid-time' };
  const records = [];
  const source = { kind: 'reference', origin: REFERENCE_URL, fetchedAt };
  for (const [provider, value] of Object.entries(result.value)) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.id !== provider || !value.models ||
        typeof value.models !== 'object' || Array.isArray(value.models)) {
      return { status: 'unknown', records: [], reason: 'invalid-catalog' };
    }
    for (const [modelId, model] of Object.entries(value.models)) {
      if (!validModel(model) || model.id !== modelId) {
        return { status: 'unknown', records: [], reason: 'invalid-catalog' };
      }
      records.push({
        provider, modelId, protocol: null,
        contextWindow: model.limit?.context ?? null,
        maxTokens: model.limit?.output ?? null,
        reasoningEfforts: null,
        identityAmbiguous: value.alias != null || value.aliases != null || model.alias != null || model.aliases != null,
        source,
      });
    }
  }
  if (!records.length) return { status: 'unknown', records: [], reason: 'invalid-catalog' };
  return { status: 'complete', records };
}

function utcTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return NaN;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return NaN;
  const canonical = new Date(time).toISOString();
  if (canonical !== (value.length === 20 ? value.replace('Z', '.000Z') : value)) return NaN;
  return time;
}

/**
 * Host-only: records must be the complete locally fetched/validated snapshot,
 * `now` the Host clock, and identity/endpoint the Host's configured route. None
 * may be supplied by a client. The optional second argument must come from a
 * Host-controlled registry, not from the catalog or a client. Its documentationUrl
 * identifies independent proof; this function cannot verify the authenticity or
 * contents of that proof. Do not trust client-supplied selectors or proof booleans.
 */
export function selectReferenceCandidate({ provider, modelId, protocol, endpoint, records, now } = {}, trustedBindings = []) {
  const unknown = (reason) => ({ status: 'unknown', candidate: null, reason });
  if (!Array.isArray(records)) return unknown('invalid-records');
  if (!isSafeMetadataText(provider) || !isValidModelId(modelId) || protocol !== 'openai-completions') return unknown('invalid-identity');
  let endpointUrl;
  try { endpointUrl = new URL(endpoint); } catch { /* unproven route */ }
  if (!endpointUrl || !['http:', 'https:'].includes(endpointUrl.protocol) || endpointUrl.username ||
      endpointUrl.password || endpointUrl.search || endpointUrl.hash || endpointUrl.href !== endpoint) {
    return unknown('invalid-endpoint');
  }
  const bindings = Array.isArray(trustedBindings) ? trustedBindings.filter((entry) =>
    entry?.provider === provider && entry?.modelId === modelId && entry?.protocol === protocol &&
    entry?.endpoint === endpoint) : [];
  if (bindings.length !== 1 || bindings[0].applicability !== 'exact-endpoint-model-protocol') {
    return unknown('unproven-binding');
  }
  let documentationUrl;
  try { documentationUrl = new URL(bindings[0].documentationUrl); } catch { /* no proof */ }
  if (!documentationUrl || documentationUrl.protocol !== 'https:' || documentationUrl.username || documentationUrl.password ||
      documentationUrl.search || documentationUrl.hash) return unknown('unproven-binding');
  const matches = records.filter((record) => record && record.provider === provider && record.modelId === modelId);
  if (matches.length !== 1) return unknown('identity-ambiguous');
  const record = matches[0];
  if ((record.protocol != null && record.protocol !== protocol) || record.alias != null || record.providerAlias != null ||
      record.modelAlias != null || record.aliases != null || record.identityAmbiguous === true) {
    return unknown('identity-ambiguous');
  }
  if (record.source?.kind !== 'reference' || record.source?.origin !== REFERENCE_URL ||
      typeof record.source?.fetchedAt !== 'string' || !record.source.fetchedAt.endsWith('Z')) {
    return unknown('invalid-source');
  }
  const fetchedAt = utcTime(record.source.fetchedAt);
  const nowMs = utcTime(now);
  if (!Number.isFinite(fetchedAt) || !Number.isFinite(nowMs) || fetchedAt > nowMs || nowMs - fetchedAt > MAX_AGE_MS) {
    return unknown('stale-source');
  }
  const capacity = (value) => value == null || (Number.isSafeInteger(value) && value > 0);
  if (!capacity(record.contextWindow) || !capacity(record.maxTokens) ||
      (record.contextWindow != null && record.maxTokens != null && record.maxTokens > record.contextWindow)) {
    return unknown('invalid-capacity');
  }
  let reasoningEfforts = null;
  if (record.reasoningEfforts != null && record.reasoningEfforts !== false) {
    const value = record.reasoningEfforts;
    if (typeof value !== 'object' || Array.isArray(value)) return unknown('invalid-effort-map');
    const entries = Object.entries(value);
    const supported = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    if (!entries.length || entries.every(([key]) => key === 'off') || entries.some(([key, wire]) =>
      !supported.has(key) || (wire === null ? key !== 'off' : !isSafeMetadataText(wire)))) {
      return unknown('invalid-effort-map');
    }
    const proof = bindings[0].reasoningEvidence;
    if (proof?.complete === true && proof.wireParameter === 'reasoning_effort' &&
        proof.values && typeof proof.values === 'object' && !Array.isArray(proof.values) &&
        Object.keys(proof.values).length === entries.length && entries.every(([key, wire]) =>
          Object.hasOwn(proof.values, key) && proof.values[key] === wire)) {
      reasoningEfforts = Object.fromEntries(entries);
    }
  }
  return {
    status: 'matched',
    candidate: {
      provider, modelId, protocol,
      contextWindow: record.contextWindow || null,
      maxTokens: record.maxTokens || null,
      reasoningEfforts,
      source: { kind: 'reference', origin: REFERENCE_URL, fetchedAt: record.source.fetchedAt },
    },
  };
}

/**
 * Pure selector/projection only: its serializable fields confer no authority.
 * Only the private, source- and target-bound production capability bridge below
 * can supply reference evidence to production reconciliation. Selection inputs
 * and independent bindings must never be supplied by an HTTP request.
 */
export function selectReferenceFieldsForReconcile(options = {}, trustedBindings = []) {
  const selected = selectReferenceCandidate(options, trustedBindings);
  if (selected.status !== 'matched') return { status: 'unknown', fields: null, reason: selected.reason };
  const { provider, modelId, protocol, source } = selected.candidate;
  const referenceIdentity = { exact: true, unique: true, provider, modelId, protocol };
  const fields = {};
  for (const field of ['contextWindow', 'maxTokens', 'reasoningEfforts']) {
    const value = selected.candidate[field];
    if (value == null) {
      fields[field] = { state: 'unknown', value: null };
    } else {
      fields[field] = { state: 'known', value, source: { ...source }, referenceIdentity: { ...referenceIdentity },
        ...(field === 'reasoningEfforts' ? { complete: true } : {}) };
    }
  }
  return { status: 'matched', fields };
}

// A capability is meaningful only in this process and for its original
// normalizer object. It cannot be reconstructed from a serialized projection.
const referenceCapabilities = new WeakMap();
// The test capability registry is never read by the production resolver.
const syntheticCapabilities = new WeakMap();
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

/**
 * Private Host composition seam, NOT an HTTP route or an authorization API.
 * Only trusted Host code may construct a bridge or choose its dependencies:
 * fetchSnapshot must be the fixed bounded worker, clock the Host UTC clock,
 * bindings independently reviewed endpoint/model/protocol facts, and semantics
 * independently reviewed source-field meanings. None may come from the HTTP
 * request, response body, worker projection or user plugin configuration.
 * There is intentionally no production binding or semantic proof in this file.
 * The Host must separately check enablement, same-revision state, preview,
 * confirmation and CAS. Tests may inject explicitly synthetic dependencies.
 */
function createReferenceBridge({ fetchSnapshot, acceptsSnapshot, capabilities,
  clock = () => new Date().toISOString(), bindings = [], semantics = [] } = {}) {
  if (typeof fetchSnapshot !== 'function' || typeof clock !== 'function' || !Array.isArray(bindings) || !Array.isArray(semantics)) {
    throw new TypeError('Trusted Host reference dependencies are required');
  }
  // Detach the reviewed registry from later mutation by its owner.
  const hostBindings = freeze(structuredClone(bindings));
  const hostSemantics = freeze(structuredClone(semantics));
  return Object.freeze({
    async fetch({ catalog, provider, endpoint, protocol } = {}, signal) {
      if (!signalActive(signal) || !catalogMatchesTarget(catalog, { provider, endpoint, protocol })) return null;
      try {
        // Only the Host-owned abort signal crosses into the fixed worker client.
        const snapshot = await fetchSnapshot(signal);
        if (!signalActive(signal) || !acceptsSnapshot(snapshot) || snapshot?.status !== 'complete' || !Array.isArray(snapshot.records) || !snapshot.records.length) return null;
        const now = clock();
        const fetchedAt = referenceSnapshotReceiptTime(snapshot);
        if (!Number.isFinite(utcTime(fetchedAt))) return null;
        const documentation = hostSemantics.filter((entry) => entry?.source === REFERENCE_URL);
        const proof = documentation.length === 1 ? documentation[0] : null;
        let url;
        try { url = new URL(proof?.documentationUrl); } catch { /* no proof */ }
        const fields = url?.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
          ? proof.fields : null;
        const records = snapshot.records.map((row) => {
          // No model-provided field value, timestamp proof or documentation claim
          // is trusted. The worker's observed values are interpreted only under
          // the separate Host registry. Selector sees the entire projected set.
          const contextWindow = fields?.contextWindow?.name === 'limit.context' &&
            fields.contextWindow.meaning === 'total-context-tokens' ? row?.observedLimitContext : null;
          const maxTokens = fields?.maxTokens?.name === 'limit.output' &&
            fields.maxTokens.meaning === 'max-output-tokens' ? row?.observedLimitOutput : null;
          return { ...row, contextWindow, maxTokens, reasoningEfforts: null,
            source: { kind: 'reference', origin: REFERENCE_URL, fetchedAt } };
        });
        const selected = new Map();
        for (const row of catalog.models) {
          const result = selectReferenceFieldsForReconcile({ provider, modelId: row.id, endpoint, protocol, records, now }, hostBindings);
          if (result.status === 'matched') selected.set(row.id, freeze(result.fields));
        }
        if (!selected.size || !signalActive(signal)) return null;
        const capability = Object.freeze(Object.create(null));
        capabilities.set(capability, { catalog, provider, endpoint, protocol, selected, clock });
        return capability;
      } catch { return null; }
    },
  });
}

/** Production bridge accepts only the fixed production controller. */
export function createTrustedReferenceBridge(options = {}) {
  if (!plainObject(options) || Reflect.ownKeys(options).some(key =>
    typeof key !== 'string' || !['clock', 'bindings', 'semantics'].includes(key))) {
    throw new TypeError('Unexpected Host reference dependency');
  }
  const { clock, bindings, semantics } = options;
  return createReferenceBridge({ fetchSnapshot: signal => signal === undefined
    ? fetchReferenceSnapshot() : fetchReferenceSnapshotWithSignal(signal), acceptsSnapshot: isProductionReferenceSnapshot,
    capabilities: referenceCapabilities, clock, bindings, semantics });
}

/** Tests only: a separate, controlled fake-controller domain, never HTTP wiring. */
export function createReferenceBridgeForTest({ controller, clock, bindings, semantics } = {}) {
  return createReferenceBridge({ fetchSnapshot: signal => signal === undefined
    ? controller.fetch() : controller.fetchWithSignal(signal),
    acceptsSnapshot: snapshot => referenceSnapshotMatchesController(snapshot, controller) &&
      !isProductionReferenceSnapshot(snapshot), capabilities: syntheticCapabilities, clock, bindings, semantics });
}

function resolveReferenceFields(capabilities, capability, { catalog, provider, endpoint, protocol, modelId } = {}) {
  const binding = capabilities.get(capability);
  if (!binding || binding.catalog !== catalog || binding.provider !== provider || binding.endpoint !== endpoint ||
      binding.protocol !== protocol || !catalogMatchesTarget(catalog, { provider, endpoint, protocol })) return null;
  const fields = binding.selected.get(modelId);
  if (!fields) return null;
  try {
    const now = utcTime(binding.clock());
    if (!Number.isFinite(now)) return null;
    for (const candidate of Object.values(fields)) if (candidate.state === 'known') {
      const fetched = utcTime(candidate.source?.fetchedAt);
      if (!Number.isFinite(fetched) || fetched > now || now - fetched > MAX_AGE_MS) return null;
    }
    return fields;
  } catch { return null; }
}

/** Host-only production resolver: synthetic test capabilities are never read. */
export function referenceFieldsForTarget(capability, target) {
  return resolveReferenceFields(referenceCapabilities, capability, target);
}

/** TESTS ONLY: isolated synthetic resolver; never wire to a production service. */
export function referenceFieldsForTargetForTest(capability, target) {
  return resolveReferenceFields(syntheticCapabilities, capability, target);
}
