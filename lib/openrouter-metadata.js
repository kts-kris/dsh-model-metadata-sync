import { types } from 'node:util';
import { isSafeMetadataText, isValidUtcTimestamp } from './metadata-source.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/models';
const ORIGIN = 'https://openrouter.ai';
// Separate read-only identity from metadata-source's write-authority binding.
// This brand establishes provenance for Host projection only, never applicability.
const readOnlyBindings = new WeakMap();
export function openRouterCatalogMatchesTarget(catalog, { provider, endpoint, protocol } = {}) {
  const binding = readOnlyBindings.get(catalog);
  return !!binding && binding.provider === provider && binding.endpoint === endpoint && binding.protocol === protocol;
}
const unknown = () => ({ state: 'unknown', value: null });
const failed = reason => ({ status: 'failed', applicable: false, models: [], reason });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const capacity = value => Number.isSafeInteger(value) && value > 0;
// metadata-source's equivalent uses Array.prototype.includes dynamically.
const isValidModelId = id => isSafeMetadataText(id) && id !== '__proto__' && id !== 'prototype' && id !== 'constructor';
const recognizableEfforts = new Set(['max', 'xhigh', 'high', 'medium', 'low', 'minimal']);

// Bound the entire decoded tree, including ignored fields. Even an unusually
// dense 4 MiB JSON response has fewer values than bytes; leave room for the
// host's surrounding input. Copy objects to null-prototype records so later
// field reads never fall through to inherited getters or polluted prototypes.
const MAX_JSON_DEPTH = 128;
const MAX_JSON_NODES = 4_200_000;
function copyPlainJson(input) {
  const seen = new WeakSet();
  let nodes = 0;
  function copy(value, depth) {
    if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new Error();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || types.isProxy(value) || seen.has(value)) throw new Error();
    seen.add(value);
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error();
    const length = array ? Object.getOwnPropertyDescriptor(value, 'length')?.value : 0;
    // Every element consumes a node, so reject impossible arrays before allocation.
    if (array && (!Number.isSafeInteger(length) || length > MAX_JSON_NODES - nodes)) throw new Error();
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== length + 1) throw new Error();
    const result = array ? new Array(length) : Object.create(null);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (typeof key !== 'string') throw new Error();
      if (array && key === 'length') continue;
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error();
      Object.defineProperty(result, key, { __proto__: null, value: copy(descriptor.value, depth + 1),
        enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  return copy(input, 0);
}

function reasoningEfforts(reasoning, source) {
  // The gateway's allowlist is not proof of the same-revision DSH/pi-ai wire
  // encoding. Keep even unfamiliar levels as evidence, never as a writable map.
  if (!record(reasoning) || !Array.isArray(reasoning.supported_efforts)) return unknown();
  const efforts = [];
  const seen = new Set();
  let recognized = typeof reasoning.mandatory === 'boolean' && reasoning.supported_efforts.length > 0;
  for (let i = 0; i < reasoning.supported_efforts.length; i++) {
    const level = reasoning.supported_efforts[i];
    if (!isSafeMetadataText(level)) return unknown();
    if (!recognizableEfforts.has(level) || seen.has(level)) recognized = false;
    seen.add(level);
    Object.defineProperty(efforts, i, { __proto__: null, value: level, enumerable: true, writable: true, configurable: true });
  }
  return { ...unknown(), candidates: efforts, candidateStatus: recognized ? 'recognized' : 'invalid-or-unmapped',
    scope: 'gateway-declared', applicable: false, source };
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    const children = Object.values(value);
    for (let i = 0; i < children.length; i++) freeze(children[i]);
    Object.freeze(value);
  }
  return value;
}

/**
 * Host-only pure projection; no network, no settings writes, no authority brand.
 * The Host must supply an independently retrieved, completed, duplicate-key-free,
 * JSON-decoded response and a controlled UTC timestamp, not client input. Exact
 * raw endpoint string comparison intentionally rejects aliases and query variants.
 * The returned catalog is for inspection only: existing reconciliation rejects it.
 */
export function normalizeOpenRouterCatalog(input = {}) {
  try {
    return normalizePlainCatalog(copyPlainJson(input));
  } catch {
    // Never return exception content or a partially projected catalog.
    return failed('invalid-or-incomplete-catalog');
  }
}

function normalizePlainCatalog({ payload, source, provider, endpoint, protocol,
  responseComplete, existingModelIds = [] }) {
  if (endpoint !== ENDPOINT || protocol !== 'openai-completions' || !isSafeMetadataText(provider) ||
      source?.kind !== 'upstream' || source?.origin !== ORIGIN || !isValidUtcTimestamp(source?.fetchedAt)) {
    return failed('invalid-source');
  }
  const rows = payload?.data;
  if (responseComplete !== true || !record(payload) || payload.error != null || payload.errors != null ||
      (payload.has_more !== undefined && payload.has_more !== false) ||
      (payload.next !== undefined && payload.next !== null) ||
      (payload.links !== undefined && (!record(payload.links) || payload.links.next !== null)) ||
      !Array.isArray(rows) || rows.length === 0 ||
      (payload.total_count !== undefined && (!Number.isSafeInteger(payload.total_count) || payload.total_count !== rows.length)) ||
      !Array.isArray(existingModelIds)) return failed('invalid-or-incomplete-catalog');
  const ids = new Set();
  for (let i = 0; i < rows.length; i++) {
    const id = record(rows[i]) ? rows[i].id : undefined;
    if (!isValidModelId(id) || ids.has(id)) return failed('invalid-or-incomplete-catalog');
    ids.add(id);
  }
  const existing = new Set();
  for (let i = 0; i < existingModelIds.length; i++) {
    const id = existingModelIds[i];
    if (!isValidModelId(id) || existing.has(id)) return failed('invalid-or-incomplete-catalog');
    existing.add(id);
  }
  // Project only known-safe fixed URL and Host-provided metadata, never arbitrary
  // fields such as headers, upstream display text, or source.version.
  const provenance = { kind: 'upstream', origin: ORIGIN, fetchedAt: source.fetchedAt, provider, url: ENDPOINT };
  const project = row => {
    // A dynamic alias may retarget later. Keep its exact ID visible, but do not
    // establish durable configuration from its present target's metadata.
    if (row.id.endsWith('~latest') || (Object.hasOwn(row, 'alias_target') && row.alias_target !== null)) return {
      id: row.id, existing: existing.has(row.id), contextWindow: unknown(), maxTokens: unknown(),
      topProviderMaxTokens: { ...unknown(), scope: 'top-provider', applicable: false }, reasoningEfforts: unknown(),
    };
    const contextWindow = capacity(row.context_length) ? { state: 'known', value: row.context_length, source: provenance } : unknown();
    const output = record(row.top_provider) ? row.top_provider.max_completion_tokens : undefined;
    let topProviderMaxTokens = capacity(output)
      ? { state: 'known', value: output, scope: 'top-provider', applicable: false, source: provenance }
      : { ...unknown(), scope: 'top-provider', applicable: false };
    // Preserve contradictory values only as non-applicable evidence.
    if (contextWindow.state === 'known' && topProviderMaxTokens.state === 'known' && output > contextWindow.value) {
      contextWindow.state = 'conflicting';
      topProviderMaxTokens.state = 'conflicting';
    }
    return { id: row.id, existing: existing.has(row.id), contextWindow, maxTokens: unknown(), topProviderMaxTokens,
      reasoningEfforts: reasoningEfforts(row.reasoning, provenance) };
  };
  const models = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    Object.defineProperty(models, i, { __proto__: null, value: project(rows[i]), enumerable: true, writable: true, configurable: true });
  }
  const catalog = freeze({ status: 'complete', applicable: false, models });
  readOnlyBindings.set(catalog, Object.freeze({ provider, endpoint, protocol }));
  return catalog;
}
