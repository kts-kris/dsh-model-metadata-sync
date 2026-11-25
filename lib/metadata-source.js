const unknown = () => ({ state: 'unknown', value: null });

// Shared by the source and reconciliation boundaries: never turn malformed
// Unicode, controls or invisible edge whitespace into identities or wire data.
// With the Unicode flag, a valid surrogate pair is a single scalar and does
// not match the surrogate range; unpaired surrogates do.
export const isSafeMetadataText = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512
  && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value);
export const isValidModelId = (id) => isSafeMetadataText(id)
  && !['__proto__', 'prototype', 'constructor'].includes(id);
export function isValidUtcTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() ===
    (value.length === 20 ? value.replace('Z', '.000Z') : value);
}

// A catalog is authority only while its original, immutable in-memory object
// survives in the Host. Nothing serialized or supplied by a client can mint it.
const catalogBindings = new WeakMap();

function freezeCatalog(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeCatalog(child);
    Object.freeze(value);
  }
  return value;
}

/** The target must come from the Host's authoritative, same-revision settings. */
export function catalogMatchesTarget(catalog, { provider, endpoint, protocol } = {}) {
  const binding = catalogBindings.get(catalog);
  if (!binding || provider !== binding.provider || endpoint !== binding.endpoint || protocol !== binding.protocol) return false;
  try { return new URL(endpoint).origin === binding.origin; } catch { return false; }
}

/**
 * Normalize one completely retrieved OpenAI Chat Completions model catalog.
 *
 * trustedRegistry is an independent, host-controlled array of documentation
 * records. Never construct it from a remote response or a client request. Each
 * proof binds provider, exact endpoint and protocol, with a documentationUrl and
 * fields containing a raw name and documented meaning. This function checks the
 * binding, not the authenticity or content of a document. responseComplete is
 * likewise a trusted transport verdict; pagination and decoding must be bounded
 * and verified before calling. Callers must reject duplicate JSON object keys
 * before parsing: ordinary JSON.parse has already lost that information.
 */
export function normalizeUpstreamCatalog({ provider, protocol, endpoint, payload, source, existingModelIds = [], responseComplete } = {}, trustedRegistry = []) {
  const rows = payload?.data;
  let endpointUrl;
  try { endpointUrl = new URL(endpoint); } catch { /* invalid endpoint */ }
  if (!isSafeMetadataText(provider) || protocol !== 'openai-completions' || typeof endpoint !== 'string' || !endpointUrl ||
      !['http:', 'https:'].includes(endpointUrl.protocol) || endpointUrl.username || endpointUrl.password ||
      endpointUrl.search || endpointUrl.hash || source?.kind !== 'upstream' ||
      source.origin !== endpointUrl.origin || !isValidUtcTimestamp(source.fetchedAt)) {
    return { status: 'failed', applicable: false, models: [], reason: 'invalid-source' };
  }
  const seen = new Set();
  if (responseComplete !== true || payload?.error != null || payload?.errors != null ||
      (payload?.has_more !== undefined && payload.has_more !== false) ||
      !Array.isArray(existingModelIds) || !Array.isArray(rows) || rows.length === 0 || Array.from(rows).some((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !isValidModelId(row.id) || seen.has(row.id)) return true;
    seen.add(row.id);
    return false;
  })) return { status: 'failed', applicable: false, models: [], reason: 'invalid-or-incomplete-catalog' };
  const safeSource = { kind: 'upstream', origin: endpointUrl.origin, fetchedAt: source.fetchedAt,
    ...(typeof source.version === 'string' && source.version.length <= 128 ? { version: source.version } : {}) };
  const matches = Array.isArray(trustedRegistry) ? trustedRegistry.filter((entry) =>
    entry?.provider === provider && entry?.endpoint === endpoint && entry?.protocol === protocol) : [];
  const proof = matches.length === 1 ? matches[0] : null;
  let documentationUrl;
  try { documentationUrl = new URL(proof?.documentationUrl); } catch { /* no proof */ }
  const fields = documentationUrl && ['http:', 'https:'].includes(documentationUrl.protocol) &&
    !documentationUrl.username && !documentationUrl.password ? proof.fields : null;
  const capacity = (row, name, meaning) => {
    const field = fields?.[name];
    if (field?.meaning !== meaning || typeof field.name !== 'string') return unknown();
    const value = row[field.name];
    return Number.isSafeInteger(value) && value > 0 ? { state: 'known', value, source: safeSource } : unknown();
  };
  const reasoning = (row) => {
    const field = fields?.reasoningEfforts;
    const data = typeof field?.name === 'string' ? row[field.name] : undefined;
    if (data == null) return unknown();
    let entries;
    if (field.meaning === 'complete-levels-identity-wire' && Array.isArray(data)) {
      entries = Array.from(data, (level) => [level, level]);
    } else if (field.meaning === 'complete-level-wire-map' && data && typeof data === 'object' && !Array.isArray(data)) {
      entries = Object.entries(data);
    } else return unknown();
    const allowed = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    const seenLevels = new Set();
    for (const [level, wire] of entries) {
      if (!allowed.has(level) || seenLevels.has(level) ||
          !(level === 'off' && wire === null) && !isSafeMetadataText(wire)) {
        return { state: 'unrepresentable', value: null };
      }
      seenLevels.add(level);
    }
    if (seenLevels.size === 0 || seenLevels.size === 1 && seenLevels.has('off')) {
      return { state: 'unrepresentable', value: null };
    }
    return { state: 'known', complete: true, value: Object.fromEntries(entries), source: safeSource };
  };
  const catalog = freezeCatalog({
    status: 'complete',
    applicable: true,
    models: rows.map((row) => {
      const contextWindow = capacity(row, 'contextWindow', 'total-context-tokens');
      const maxTokens = capacity(row, 'maxTokens', 'max-output-tokens');
      // Only independently documented positive values can establish this
      // contradiction. Preserve each source/value for the preview without
      // treating either contradictory value as an applicable candidate.
      const conflicting = contextWindow.state === 'known' && maxTokens.state === 'known' &&
        maxTokens.value > contextWindow.value;
      return {
        id: row.id,
        existing: existingModelIds.includes(row.id),
        contextWindow: conflicting ? { ...contextWindow, state: 'conflicting' } : contextWindow,
        maxTokens: conflicting ? { ...maxTokens, state: 'conflicting' } : maxTokens,
        reasoningEfforts: reasoning(row),
      };
    }),
  });
  catalogBindings.set(catalog, Object.freeze({ provider, endpoint, protocol, origin: endpointUrl.origin }));
  return catalog;
}
