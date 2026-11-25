import { isSafeMetadataText, isValidModelId } from './metadata-source.js';

const REFERENCE_URL = 'https://models.dev/api.json';
const MAX_RECORDS = 20_000;
const MAX_RECORD_BYTES = 8 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_CHUNKS = 65_536;

function cancel(body) {
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* cleanup only */ }
}

async function readResponse(response) {
  if (!response?.headers || typeof response.headers.get !== 'function' || response.status !== 200 || !response.ok ||
      response.redirected || (response.url && response.url !== REFERENCE_URL) ||
      response.headers.get('link') !== null || response.headers.get('content-range') !== null) {
    cancel(response?.body);
    throw new Error('invalid response');
  }
  const encoding = response.headers.get('content-encoding');
  if (encoding !== null && (typeof encoding !== 'string' || encoding.trim().toLowerCase() !== 'identity')) {
    cancel(response.body);
    throw new Error('invalid response');
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > MAX_BYTES)) {
    cancel(response.body);
    throw new Error('invalid response');
  }
  if (!response.body || typeof response.body.getReader !== 'function') throw new Error('invalid body');
  const reader = response.body.getReader();
  const parts = [];
  let total = 0;
  let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || ++count > MAX_CHUNKS) throw new Error('invalid body');
      total += value.byteLength;
      if (total > MAX_BYTES) throw new Error('invalid body');
      if (value.byteLength) parts.push(value);
    }
    if (total === 0 || (declared !== null && total !== Number(declared))) throw new Error('invalid body');
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    cancel(reader);
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* cleanup only */ }
  }
}

// JSON.parse discards duplicate keys, so scan before building the graph. Every
// object key is decoded exactly as JSON.parse decodes it; this catches escaped
// equivalents. Only bounded key sets and at most 128 recursive frames coexist.
function scanJson(text) {
  let position = 0;
  let keys = 0;
  let values = 0;
  const invalid = () => { throw new SyntaxError('Invalid JSON'); };
  const whitespace = () => {
    while (text[position] === ' ' || text[position] === '\n' || text[position] === '\r' || text[position] === '\t') position++;
  };
  const stringEnd = () => {
    if (text[position] !== '"') invalid();
    const start = position++;
    while (position < text.length) {
      const character = text[position++];
      if (character === '"') return start;
      if (character === '\\') position++;
    }
    return invalid();
  };
  const value = depth => {
    if (++values > 2_000_000) invalid();
    whitespace();
    const character = text[position];
    if (character === '{' || character === '[') {
      if (depth >= 128) invalid();
      const object = character === '{';
      const close = object ? '}' : ']';
      const seen = object ? new Set() : null;
      position++;
      whitespace();
      if (text[position] === close) { position++; return; }
      for (;;) {
        if (object) {
          if (++keys > 1_000_000) invalid();
          const start = stringEnd();
          const key = JSON.parse(text.slice(start, position));
          if (seen.has(key)) invalid();
          seen.add(key);
          whitespace();
          if (text[position++] !== ':') invalid();
        }
        value(depth + 1);
        whitespace();
        if (text[position] === close) { position++; return; }
        if (text[position++] !== ',') invalid();
        whitespace();
      }
    }
    if (character === '"') { stringEnd(); return; }
    const start = position;
    while (position < text.length && !',]} \n\r\t'.includes(text[position])) position++;
    if (position === start) invalid();
  };
  value(0);
  whitespace();
  if (position !== text.length) invalid();
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasError = value => Object.hasOwn(value, 'error') || Object.hasOwn(value, 'errors');
const hasAlias = value => Object.hasOwn(value, 'alias') || Object.hasOwn(value, 'aliases');
const validCapacity = value => Number.isSafeInteger(value) && value > 0;

function validTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === (value.length === 20 ? value.replace('Z', '.000Z') : value);
}

function projectCatalog(catalog, fetchedAt) {
  if (!object(catalog) || hasError(catalog) || !Object.keys(catalog).length || !validTime(fetchedAt)) throw new Error('invalid catalog');
  const source = { kind: 'reference', origin: REFERENCE_URL, fetchedAt };
  const invalidProviders = new Set();
  for (const [provider, group] of Object.entries(catalog)) {
    if (!isSafeMetadataText(provider)) throw new Error('unknown provider');
    // A key alone is not proof of declared identity. A malformed provider or
    // missing/unusable ID cannot establish the affected scope of the source.
    if (!object(group) || !isSafeMetadataText(group.id)) throw new Error('unknown provider');
    if (group.id !== provider) { invalidProviders.add(provider); invalidProviders.add(group.id); }
    if (hasError(group)) invalidProviders.add(provider);
    // Unknown aliases at either identity level may point to any provider.
    // Inspect even providers that will be skipped for other reasons, before
    // publishing any records, so they cannot hide cross-provider ambiguity.
    if (hasAlias(group)) throw new Error('unknown provider alias');
    // Non-object containers could hide aliases whose scope cannot be bounded.
    if (!object(group.models)) throw new Error('unknown models');
    for (const model of Object.values(group.models)) {
      if (!object(model)) throw new Error('unknown model');
      if (hasAlias(model)) throw new Error('unknown model alias');
    }
  }
  const records = [];
  for (const [provider, group] of Object.entries(catalog)) {
    if (invalidProviders.has(provider)) continue;
    const contaminated = new Set();
    let ambiguousIdentity = false;
    for (const [modelId, model] of Object.entries(group.models)) {
      if (!isValidModelId(modelId)) { ambiguousIdentity = true; break; }
      if (!isValidModelId(model.id)) { ambiguousIdentity = true; break; }
      if (model.id !== modelId) { contaminated.add(modelId); contaminated.add(model.id); }
    }
    if (ambiguousIdentity) continue;
    // Contamination is retained as exact tombstones for *both* identities;
    // dropping a conflicting row could fabricate a unique match.
    const base = modelId => ({ provider, modelId, protocol: null, contextWindow: null,
      maxTokens: null, reasoningEfforts: null, source });
    const tombstone = modelId => ({ ...base(modelId), status: 'unknown', identityAmbiguous: true });
    for (const [modelId, model] of Object.entries(group.models)) {
      if (contaminated.has(modelId)) { records.push(tombstone(modelId)); continue; }
      const limit = model.limit;
      let invalid = hasError(model) || (Object.hasOwn(model, 'limit') && !object(limit));
      if (!invalid && limit) {
        if (hasError(limit)) invalid = true;
        for (const field of ['context', 'input', 'output']) {
          if (Object.hasOwn(limit, field) && !validCapacity(limit[field])) invalid = true;
        }
        if (Object.hasOwn(limit, 'context') && ['input', 'output'].some(field =>
          Object.hasOwn(limit, field) && limit[field] > limit.context)) invalid = true;
      }
      if (invalid) { records.push(tombstone(modelId)); continue; }
      records.push({ ...base(modelId), observedLimitContext: limit?.context ?? null,
        observedLimitOutput: limit?.output ?? null });
    }
    for (const modelId of contaminated) if (!Object.hasOwn(group.models, modelId)) records.push(tombstone(modelId));
  }
  return records;
}

/** Encode a complete result under the fixed worker IPC limits. */
export function encodeReferenceRecords(records) {
  if (!Array.isArray(records) || records.length === 0 || records.length > MAX_RECORDS) throw new Error('result limit');
  let length = 2;
  const encoded = [];
  for (const record of records) {
    const item = JSON.stringify(record);
    const size = Buffer.byteLength(item, 'utf8');
    if (size > MAX_RECORD_BYTES) throw new Error('result limit');
    length += size + (encoded.length ? 1 : 0);
    if (length > MAX_OUTPUT_BYTES) throw new Error('result limit');
    encoded.push(item);
  }
  return `[${encoded.join(',')}]`;
}

/** Host/test seam. Only a transport and a clock are consumed. */
export async function fetchReferenceWorker({ transport = globalThis.fetch, clock = () => new Date().toISOString() } = {}) {
  try {
    const response = await transport(REFERENCE_URL, {
      method: 'GET', headers: { 'Accept-Encoding': 'identity' }, redirect: 'manual', credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    const text = await readResponse(response);
    scanJson(text);
    const value = JSON.parse(text);
    const records = projectCatalog(value, clock());
    encodeReferenceRecords(records); // Apply the same fixed IPC limits to the pure seam.
    return { status: 'complete', records };
  } catch {
    return { status: 'unknown', records: [] };
  }
}
