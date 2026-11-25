import { createHash, createHmac, randomBytes as secureRandomBytes } from 'node:crypto';
import { types } from 'node:util';
import { configuredModelsEndpoint } from './generic-adapter.js';
import { catalogMatchesTarget, isSafeMetadataText, isValidModelId } from './metadata-source.js';
import { reconcileMetadata } from './safe-reconcile.js';

const TTL_MS = 5 * 60 * 1000;
const MAX_PREVIEWS = 512;
const FIELDS = ['contextWindow', 'maxTokens', 'reasoningEfforts'];
const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const revisionValue = value => Number.isSafeInteger(value) && value >= 0;
const copy = value => structuredClone(value);
const promiseThen = Promise.prototype.then;
const discardPromiseResult = () => undefined;

const messages = Object.freeze({
  INVALID_RESPONSE: 'Invalid preview request or model catalog.',
  SETTINGS_UNAVAILABLE: 'Verified provider settings are unavailable.',
  UNKNOWN_SOURCE: 'Configured upstream source is unavailable.',
  UNSUPPORTED_PROTOCOL: 'Provider protocol is unsupported.',
  INCOMPLETE_RESPONSE: 'Model catalog discovery did not complete.',
  REVISION_CONFLICT: 'Settings changed; request a new preview.',
  REPREVIEW_REQUIRED: 'A fresh preview is required.',
});
function failure(code) { return { error: { code, message: messages[code] } }; }

// A request is untrusted JSON. Refuse hidden keys, proxies and accessors instead
// of reading a client-provided endpoint, proof, clock or source even by accident.
function requestProjection(input) {
  try {
    if (!record(input) || types.isProxy(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return null;
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 2 || keys.some(key => typeof key !== 'string' || !['provider', 'selectedNewIds'].includes(key))) return null;
    const p = Object.getOwnPropertyDescriptor(input, 'provider');
    const s = Object.getOwnPropertyDescriptor(input, 'selectedNewIds');
    if (!p || !s || !has(p, 'value') || !has(s, 'value') || !isValidModelId(p.value) ||
        !Array.isArray(s.value) || types.isProxy(s.value) || s.value.length > 20000) return null;
    const ids = [];
    for (let i = 0; i < s.value.length; i++) {
      const entry = Object.getOwnPropertyDescriptor(s.value, String(i));
      if (!entry || !has(entry, 'value') || !isValidModelId(entry.value)) return null;
      ids.push(entry.value);
    }
    if (new Set(ids).size !== ids.length) return null;
    return { provider: p.value, selectedNewIds: ids };
  } catch { return null; }
}

// Unrecognized or malformed configured values remain present but opaque. This
// preserves the conservative 'configured/unknown' distinction without copying
// arbitrary model objects, credentials, headers, accessors or descriptor fields.
function metadataValue(field, value) {
  if (value === null || value === false) return value;
  if (field !== 'reasoningEfforts') return positive(value) ? value : null;
  if (!record(value) || types.isProxy(value)) return null;
  const entries = Object.entries(value);
  if (entries.some(([key, wire]) => !EFFORTS.includes(key) ||
      !(key === 'off' && wire === null) && !isSafeMetadataText(wire))) return null;
  return Object.fromEntries(entries);
}
function modelProjection(model) {
  if (!record(model) || types.isProxy(model)) return null;
  const result = { id: model.id };
  for (const field of FIELDS) if (has(model, field)) result[field] = metadataValue(field, model[field]);
  return result;
}
function routeProjection(route) {
  const result = {};
  if (has(route, 'models')) result.models = Array.isArray(route.models) ? Array.from(route.models, modelProjection) : null;
  for (const field of ['defaultContextWindow', 'defaultMaxTokens']) {
    if (has(route, field)) result[field] = positive(route[field]) ? route[field] : null;
  }
  if (has(route, 'modelOverrides')) {
    if (!record(route.modelOverrides) || types.isProxy(route.modelOverrides)) result.modelOverrides = null;
    else result.modelOverrides = Object.fromEntries(Object.entries(route.modelOverrides).map(([id, value]) => {
      if (!record(value) || types.isProxy(value)) return [id, null];
      const override = {};
      // An override containing id must still be rejected by reconciliation.
      if (has(value, 'id')) override.id = null;
      for (const field of FIELDS) if (has(value, field)) override[field] = metadataValue(field, value[field]);
      return [id, override];
    }));
  }
  return result;
}
function effectiveProjection(effective) {
  if (!record(effective) || types.isProxy(effective)) return { status: 'unknown' };
  const result = { status: effective.status === 'known' ? 'known' : 'unknown',
    inventoryComplete: effective.inventoryComplete === true };
  if (!Array.isArray(effective.models)) return result;
  result.models = Array.from(effective.models, model => {
    if (!record(model) || types.isProxy(model)) return null;
    const row = { id: model.id };
    if (record(model.fields) && !types.isProxy(model.fields)) {
      row.fields = {};
      for (const field of FIELDS) {
        const fact = model.fields[field];
        if (!record(fact) || types.isProxy(fact)) continue;
        const projected = { status: ['catalog', 'provider-default', 'absent', 'system-fallback'].includes(fact.status) ? fact.status : 'unknown' };
        if (fact.status === 'absent' && has(fact, 'value') && fact.value != null) projected.status = 'unknown';
        if (has(fact, 'value')) projected.value = metadataValue(field, fact.value);
        if (record(fact.evidence) && !types.isProxy(fact.evidence)) {
          projected.evidence = {
            explicit: fact.evidence.explicit === 'absent' ? 'absent' : 'unknown',
            catalog: fact.evidence.catalog === 'absent' ? 'absent' : 'unknown',
            routeDefault: ['absent', 'system-default'].includes(fact.evidence.routeDefault) ? fact.evidence.routeDefault : 'unknown',
          };
        }
        row.fields[field] = projected;
      }
    }
    return row;
  });
  return result;
}

// The trusted Host checker sees only projected output, never the private route
// or descriptor. Check keys, text and JSON scalar numbers before serialization;
// never mask an ID or wire value that could be mistaken for the original target.
function safeOutput(value, checkText, privateEndpointValues) {
  function safeText(text) {
    if (reflectsEndpoint(text, privateEndpointValues)) return false;
    const verdict = checkText(text);
    if (verdict !== true) {
      // Never assimilate a thenable: its getter/callback is not trustworthy.
      // A genuine Promise from a mistaken async Host checker must have its
      // rejection handled immediately, but can never grant authorization.
      if (types.isPromise(verdict)) promiseThen.call(verdict, discardPromiseResult, discardPromiseResult);
      return false;
    }
    return true;
  }
  const stack = [value];
  while (stack.length) {
    const item = stack.pop();
    if (typeof item === 'string') {
      if (!safeText(item)) return false;
    } else if (typeof item === 'number') {
      // JSON.stringify matches the representation sent to consumers, including
      // -0 as 0. No non-finite numbers or bigint belong to the response schema.
      if (!Number.isFinite(item) || !safeText(JSON.stringify(item))) return false;
    } else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) stack.push(key, child);
    } else if (item !== null && typeof item !== 'boolean') return false;
  }
  // Check assembled JSON as well, so the Host can reject a protected sequence
  // formed by escaping or adjacent structure. This is still only the projection.
  return safeText(JSON.stringify(value));
}

// Deliberately finite, not a universal URL/Unicode equivalence test. Decoding is
// applied to private patterns and each candidate text without altering output.
const MAX_DECODE_ROUNDS = 4;
function decodedForms(value) {
  const forms = [value];
  for (let i = 0; i < MAX_DECODE_ROUNDS; i++) {
    let next;
    try { next = decodeURIComponent(forms[forms.length - 1]); } catch { break; }
    if (next === forms[forms.length - 1]) break;
    forms.push(next);
  }
  return forms;
}
function endpointValues(baseURL, endpoint) {
  const base = new URL(baseURL);
  const target = new URL(endpoint);
  const exact = new Set([baseURL, base.href, base.origin, base.host, base.hostname, endpoint]);
  for (const path of [base.pathname, target.pathname]) {
    if (path === '/') continue;
    for (const form of decodedForms(path)) {
      exact.add(form);
      // Empty and dot-only components, generic API markers and API version
      // components do not identify a private route by themselves. Everything
      // else is conservatively private and may reject legitimate metadata.
      for (const segment of form.split('/')) {
        if (segment && !/^\.+$/.test(segment) && !/^(?:api|models|v\d+(?:beta\d*)?)$/i.test(segment)) exact.add(segment);
      }
    }
  }
  return { exact: [...exact].filter(Boolean), hosts: [...new Set([base.hostname, target.hostname].filter(Boolean))] };
}
function reflectsEndpoint(text, values) {
  return decodedForms(text).some(form => values.exact.some(part => form.includes(part)) ||
    values.hosts.some(host => form.toLowerCase().includes(host.toLowerCase())));
}

function protectionMatches(protection, revision, secretGeneration) {
  return record(protection) && protection.complete === true && protection.revision === revision &&
    protection.secretGeneration === secretGeneration && typeof protection.checkText === 'function';
}

function safePlan(plan) {
  // reconcileMetadata already validates candidates and returns a path plan.
  // Project again here so newly added internal fields cannot leak automatically.
  const value = (field, input) => metadataValue(field, input);
  const changes = plan.changes.map(change => change.type === 'add-model'
    ? { type: 'add-model', modelId: change.modelId }
    : { type: 'set-field', scope: change.scope, modelId: change.modelId,
      ...(has(change, 'index') ? { index: change.index } : {}), field: change.field, value: value(change.field, change.value) });
  const items = plan.items.map(item => ({ modelId: item.modelId, existing: item.existing, applicable: item.applicable,
    ...(has(item, 'reason') ? { reason: item.reason } : {}),
    ...(item.fields ? { fields: item.fields.map(field => ({ field: field.field, state: field.state, reason: field.reason,
      ...(has(field, 'before') ? { before: value(field.field, field.before) } : {}),
      ...(has(field, 'candidate') ? { candidate: value(field.field, field.candidate) } : {}),
      ...(field.source?.kind === 'upstream' ? { source: { kind: 'upstream', fetchedAt: field.source.fetchedAt } } : {}),
    })) } : {}),
  }));
  return { changes, items, warnings: [...plan.warnings] };
}

/**
 * PRIVATE Host-only, preview-only adapter; not a route or an authentication API.
 *
 * Dependencies are supplied once by trusted Host wiring, never by an HTTP body:
 * - readSnapshot(provider) => { revision, route:{revision,value},
 *   effective:{revision,value}, referenceEnabled?:boolean }. It must capture
 *   the route and effective inheritance from one authoritative revision. Route
 *   uses provider, api, baseURL, models, defaults and optional modelOverrides.
 *   It also returns secretGeneration and protection: { revision,
 *   secretGeneration, complete: true, checkText(text) }. The synchronous
 *   checkText must return strictly true only when text contains no Host-protected
 *   secret, including the actual Bearer and every independent configured secret.
 *   It receives individual projected keys, strings and JSON-number literals, then
 *   the complete serialized projection; it must not forward these to a non-Host.
 *   A false, non-boolean, thenable, Promise or thrown value never authorizes output.
 *   Standard rejected Promises are observed without logging their reason; arbitrary
 *   thenables are not invoked. Host wiring is trusted and must not provide modified
 *   Promise constructors/species or otherwise adversarial same-process intrinsics.
 *   The local endpoint reflection guard covers only bounded URI decoding, hostname
 *   case and selected path fragments; it cannot prove arbitrary encoding or Unicode
 *   equivalence. The trusted Host checker must detect all its protected secrets,
 *   including private endpoint equivalents, or leave the protection incomplete.
 *   The Host must bind its complete secret inventory and credential resolution to
 *   these same immutable revision/generation facts; no client can supply them.
 * - fetchCatalog({revision, secretGeneration, route}) performs bounded Host
 *   discovery with those same identity and credential snapshots, and returns the
 *   ORIGINAL immutable WeakMap-bound catalog. It must never return/log a descriptor.
 * - readRevision() reads the same namespace revision without exposing settings.
 * - readProtectionState() atomically reads {revision, secretGeneration} from the
 *   same authoritative settings/secret stores; a separate independently rotating
 *   secret store without a reliable generation is not a valid implementation.
 *   Reads before/after async work and on cache retrieval only describe those read
 *   instants. A secret can rotate immediately afterward; these checks do not close
 *   a TOCTOU race or authorize applying a preview. A future real Host commit must
 *   atomically revalidate the current revision and secret generation under a commit
 *   lock or equivalent conditional transaction, including all target/plan checks.
 * - clock(): epoch milliseconds; randomBytes(n): cryptographic bytes (the
 *   defaults are the Node Host clock and crypto.randomBytes).
 *
 * The actual DSH adapter and snapshot/inheritance proof have NOT been verified;
 * until they are, Host must not wire this seam to a real endpoint. No reference
 * bridge, network, settings mutation, CAS, apply or consent claim exists here.
 * getPreview is a non-authoritative local display cache: it has no authenticated
 * owner, no target revalidation and no atomic consumption. Never wire it to an
 * HTTP read or to apply/consent. Future Host work must implement owner binding,
 * source/target revalidation and one-use semantics at the commit authority.
 */
export function createPreviewAuthority({ readSnapshot, fetchCatalog, readRevision, readProtectionState,
  clock = Date.now, randomBytes = secureRandomBytes } = {}) {
  if (![readSnapshot, fetchCatalog, readRevision, clock, randomBytes].every(fn => typeof fn === 'function')) {
    throw new TypeError('Host preview dependencies are required.');
  }
  const previews = new Map();
  let lastTime = 0;
  function time() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999 || value < lastTime) throw new Error('Invalid host clock.');
    lastTime = value;
    return value;
  }
  function bytes(size) {
    const value = randomBytes(size);
    if (!(value instanceof Uint8Array) || value.length !== size) throw new Error('Invalid Host entropy.');
    return Buffer.from(value);
  }
  let fingerprintKey;
  try { fingerprintKey = bytes(32); } catch { throw new TypeError('Host entropy is unavailable.'); }
  function purge(now) {
    for (const [id, entry] of previews) if (now >= entry.expires) previews.delete(id);
  }
  async function preview(input) {
    const request = requestProjection(input);
    if (!request) return failure('INVALID_RESPONSE');
    let revision, secretGeneration, endpoint, protocol, route, effective, referenceEnabled, attempt;
    try {
      const snapshot = await readSnapshot(request.provider);
      if (!record(snapshot) || !revisionValue(snapshot.revision) || !record(snapshot.route) ||
          !record(snapshot.effective) || snapshot.route.revision !== snapshot.revision ||
          snapshot.effective.revision !== snapshot.revision || !record(snapshot.route.value) ||
          snapshot.route.value.provider !== request.provider) return failure('SETTINGS_UNAVAILABLE');
      const original = snapshot.route.value;
      revision = snapshot.revision;
      secretGeneration = snapshot.secretGeneration;
      if (!revisionValue(secretGeneration) || !protectionMatches(snapshot.protection, revision, secretGeneration) ||
          typeof readProtectionState !== 'function') return failure('SETTINGS_UNAVAILABLE');
      const stateMatches = state => record(state) && state.revision === revision && state.secretGeneration === secretGeneration;
      if (!stateMatches(await readProtectionState())) return failure('SETTINGS_UNAVAILABLE');
      protocol = original.api;
      if (protocol !== 'openai-completions') return failure('UNSUPPORTED_PROTOCOL');
      endpoint = configuredModelsEndpoint(original);
      if (!endpoint) return failure('UNKNOWN_SOURCE');
      route = routeProjection(original);
      effective = effectiveProjection(snapshot.effective.value);
      referenceEnabled = snapshot.referenceEnabled !== false;
      attempt = time();
      // fetchCatalog receives the same original route object from the Host, not
      // a client object or a reconstructed descriptor. Never persist it here.
      let catalog;
      try { catalog = await fetchCatalog({ revision, secretGeneration, route: original }); }
      catch { return failure('INCOMPLETE_RESPONSE'); }
      if (!catalogMatchesTarget(catalog, { provider: request.provider, endpoint, protocol })) return failure('INCOMPLETE_RESPONSE');
      const plan = reconcileMetadata({ provider: request.provider, endpoint, protocol, route, effective,
        catalog, selectedNewIds: request.selectedNewIds });
      if (plan.status !== 'ready') return failure('INVALID_RESPONSE');
      if (await readRevision() !== revision) return failure('REVISION_CONFLICT');
      const created = time();
      purge(created);
      if (previews.size >= MAX_PREVIEWS || created + TTL_MS > 253402300799999) return failure('REPREVIEW_REQUIRED');
      const safe = safePlan(plan);
      const selected = new Set(request.selectedNewIds);
      const selectedNewIds = plan.items.filter(item => !item.existing && selected.has(item.modelId)).map(item => item.modelId);
      const fingerprint = createHmac('sha256', fingerprintKey).update(endpoint).digest('hex');
      const sources = {
        upstream: { kind: 'upstream', status: 'success', lastAttemptAt: new Date(attempt).toISOString() },
        reference: referenceEnabled
          ? { kind: 'reference', status: 'unknown', reason: 'reference-bridge-unavailable', lookupIdentifiers: ['provider', 'modelId', 'protocol'] }
          : { kind: 'reference', status: 'disabled', lookupIdentifiers: ['provider', 'modelId', 'protocol'] },
      };
      // Reject the entire projection before any digest, caching or return. The
      // exact IDs and wires remain untouched, so a redacted value cannot be used
      // as a write target. Include all keys and strings in the eventual response.
      const candidate = { provider: request.provider, selectedNewIds, items: safe.items,
        changes: safe.changes, warnings: safe.warnings, sources };
      if (!safeOutput(candidate, snapshot.protection.checkText, endpointValues(original.baseURL, endpoint))) {
        return failure('INVALID_RESPONSE');
      }
      if (await readRevision() !== revision || !stateMatches(await readProtectionState())) return failure('REVISION_CONFLICT');
      // Do not hash a descriptor, header, credential or arbitrary model object.
      // Bind only the keyed target fingerprint, normalized diff and provenance.
      const digestInput = { provider: request.provider, revision, protocol, endpointFingerprint: fingerprint,
        selectedNewIds, changes: safe.changes, items: safe.items, referenceStatus: sources.reference.status };
      const digest = createHash('sha256').update(JSON.stringify(digestInput)).digest('hex');
      let previewId;
      for (let i = 0; i < 4; i++) {
        const candidate = bytes(32).toString('base64url');
        if (!previews.has(candidate)) { previewId = candidate; break; }
      }
      if (!previewId) return failure('REPREVIEW_REQUIRED');
      const result = { previewId, expiresAt: new Date(created + TTL_MS).toISOString(), revision, digest, ...candidate };
      if (!safeOutput(result, snapshot.protection.checkText, endpointValues(original.baseURL, endpoint))) return failure('INVALID_RESPONSE');
      previews.set(previewId, { revision, secretGeneration, expires: created + TTL_MS, result });
      return copy(result);
    } catch {
      // No raw Host/transport/decoder errors or secrets cross this boundary.
      return failure('SETTINGS_UNAVAILABLE');
    }
  }
  async function getPreview(previewId) {
    try {
      const now = time();
      purge(now);
      if (typeof previewId !== 'string') return null;
      const entry = previews.get(previewId);
      if (!entry) return null;
      const revision = await readRevision();
      const state = await readProtectionState();
      if (previews.get(previewId) !== entry || revision !== entry.revision || !record(state) ||
          state.revision !== entry.revision || state.secretGeneration !== entry.secretGeneration || time() >= entry.expires) {
        previews.delete(previewId);
        return null;
      }
      return copy(entry.result);
    } catch { previews.clear(); return null; }
  }
  function cancel(previewId) {
    return typeof previewId === 'string' && previews.delete(previewId);
  }
  return Object.freeze({ preview, getPreview, cancel });
}
