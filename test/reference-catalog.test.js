import test from 'node:test';
import assert from 'node:assert/strict';
import * as referenceCatalog from '../lib/reference-catalog.js';
import { fetchReferenceCatalog, selectReferenceCandidate } from '../lib/reference-catalog.js';
import { reconcileMetadata } from '../lib/safe-reconcile.js';
import { normalizeUpstreamCatalog } from '../lib/metadata-source.js';

const NOW = '2026-11-25T03:00:00.000Z';
const ENDPOINT = 'https://private-gateway.example/v1/chat/completions';
const binding = {
  provider: 'openai', modelId: 'gpt-4o', protocol: 'openai-completions', endpoint: ENDPOINT,
  documentationUrl: 'https://docs.example/openai-gateway/gpt-4o',
  applicability: 'exact-endpoint-model-protocol',
};
const source = { kind: 'reference', origin: 'https://models.dev/api.json', fetchedAt: '2026-11-25T02:00:00.000Z' };

function exactRecord(overrides = {}) {
  return {
    provider: 'openai',
    modelId: 'gpt-4o',
    protocol: 'openai-completions',
    contextWindow: 128000,
    maxTokens: 16384,
    source,
    ...overrides,
  };
}

function select(records, overrides = {}, bindings = [binding]) {
  return selectReferenceCandidate({
    provider: 'openai', modelId: 'gpt-4o', protocol: 'openai-completions', endpoint: ENDPOINT,
    records, now: NOW, ...overrides,
  }, bindings);
}

test('disabled public reference lookup performs zero requests', async () => {
  let calls = 0;
  const result = await fetchReferenceCatalog({ enabled: false, clock: () => NOW, transport: async () => { calls++; } });
  assert.equal(result.status, 'disabled');
  assert.deepEqual(result.records, []);
  assert.equal(calls, 0);
});

test('fetches and projects a models.dev snapshot without leaking upstream credentials or endpoints', async () => {
  const calls = [];
  const secret = 'synthetic-secret-only';
  const result = await fetchReferenceCatalog({
    clock: () => NOW,
    endpoint: ENDPOINT,
    headers: { authorization: `Bearer ${secret}` },
    transport: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        openai: { id: 'openai', npm: '@ai-sdk/openai', api: 'https://api.openai.com/v1', models: {
          'gpt-4o': { id: 'gpt-4o', limit: { context: 128000, input: 123000, output: 16384 },
            reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
          'input-only': { id: 'input-only', limit: { input: 9999 } },
        } },
      }));
    },
  });
  assert.equal(result.status, 'complete');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://models.dev/api.json');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(new Headers(calls[0].options.headers).has('authorization'), false);
  assert.equal(JSON.stringify(calls).includes(secret), false);
  assert.equal(JSON.stringify(calls).includes(ENDPOINT), false);
  assert.deepEqual(result.records.map(record => ({
    provider: record.provider, modelId: record.modelId, contextWindow: record.contextWindow,
    maxTokens: record.maxTokens, reasoningEfforts: record.reasoningEfforts, source: record.source,
  })), [
    { provider: 'openai', modelId: 'gpt-4o', contextWindow: 128000, maxTokens: 16384,
      reasoningEfforts: null, source: { kind: 'reference', origin: 'https://models.dev/api.json', fetchedAt: NOW } },
    { provider: 'openai', modelId: 'input-only', contextWindow: null, maxTokens: null,
      reasoningEfforts: null, source: { kind: 'reference', origin: 'https://models.dev/api.json', fetchedAt: NOW } },
  ]);
  assert.equal(result.records[0].protocol, null, 'v1 provider/npm/api do not declare route protocol');
  assert.equal(select(result.records).status, 'matched');
  assert.equal(select(result.records).candidate.protocol, 'openai-completions');
  assert.equal(selectReferenceCandidate({ provider: 'openai', modelId: 'gpt-4o', protocol: 'openai-completions',
    endpoint: ENDPOINT, records: result.records, now: NOW }).status, 'unknown');
});

test('duplicate and escaped-equivalent keys in the raw reference response invalidate the snapshot', async () => {
  const rawSnapshots = [
    '{"openai":{"id":"openai","models":{"gpt-4o":{"id":"gpt-4o","limit":{"context":64000}},"gpt-4o":{"id":"gpt-4o","limit":{"context":128000}}}}}',
    '{"openai":{"id":"openai","models":{"gpt-4o":{"id":"gpt-4o","limit":{"context":64000}},"gpt-4\\u006f":{"id":"gpt-4o","limit":{"context":128000}}}}}',
    '{"openai":{"id":"openai","models":{"gpt-4o":{"id":"gpt-4o","limit":{"context":64000,"context":128000}}}}}',
  ];
  for (const json of rawSnapshots) {
    const result = await fetchReferenceCatalog({ clock: () => NOW, transport: async () => new Response(json) });
    assert.equal(result.status, 'unknown');
    assert.deepEqual(result.records, []);
  }
});

test('contradictory catalog provider or model ids cannot produce a reference candidate', async () => {
  for (const catalog of [
    { openai: { id: 'another', models: { 'gpt-4o': { id: 'gpt-4o', limit: { context: 128000 } } } } },
    { openai: { id: 'openai', models: { 'gpt-4o': { id: 'other', limit: { context: 128000 } } } } },
    { openai: { id: 'openai', models: { 'gpt-4o': { id: 'gpt-4o', limit: { context: 128000 } },
      alias: { id: 'gpt-4o', limit: { context: 64000 } } } } },
  ]) {
    const result = await fetchReferenceCatalog({ clock: () => NOW, transport: async () => new Response(JSON.stringify(catalog)) });
    assert.notEqual(select(result.records).status, 'matched', JSON.stringify(catalog));
  }
});

test('aliases, malformed limits and unknown record details do not become reference facts', async () => {
  const makeCatalog = (model) => ({ openai: { id: 'openai', models: { 'gpt-4o': { id: 'gpt-4o', ...model } } } });
  for (const model of [
    { alias: 'other', limit: { context: 128000 } },
    { aliases: ['other'], limit: { context: 128000 } },
    { limit: { context: 128000, output: -1 } },
    { limit: { context: 128000, output: 256000 } },
    { limit: { context: false, output: 16384 } },
  ]) {
    const result = await fetchReferenceCatalog({ clock: () => NOW, transport: async () => new Response(JSON.stringify(makeCatalog(model))) });
    assert.equal(select(result.records).status, 'unknown', JSON.stringify(model));
  }
  const result = await fetchReferenceCatalog({ clock: () => NOW, transport: async () => new Response(JSON.stringify(makeCatalog({
    limit: { context: 128000, output: 16384 },
    canonical_model_id: 'openai/gpt-4o', // provenance only; not an alias to use for matching
  }))) });
  assert.equal(select(result.records).status, 'matched');
});

test('a malformed or error-marked model invalidates the entire fetched snapshot', async (t) => {
  for (const [description, model] of [
    ['input exceeds context', { limit: { context: 128000, input: 256000, output: 16384 } }],
    ['input is false', { limit: { context: 128000, input: false, output: 16384 } }],
    ['limit is an array', { limit: [] }],
    ['limit is null', { limit: null }],
    ['limit is false', { limit: false }],
    ['context is null', { limit: { context: null } }],
    ['output is fractional', { limit: { context: 128000, output: 1.5 } }],
    ['output exceeds context', { limit: { context: 128000, output: 128001 } }],
    ['model carries error', { limit: { context: 128000, output: 16384 }, error: { code: 'invalid' } }],
    ['model carries errors', { limit: { context: 128000, output: 16384 }, errors: ['invalid'] }],
    ['model carries null error marker', { limit: { context: 128000 }, error: null }],
  ]) await t.test(description, async () => {
    const catalog = { openai: { id: 'openai', models: {
      'other-model': { id: 'other-model', limit: { context: 32000 } },
      'gpt-4o': { id: 'gpt-4o', ...model },
    } } };
    const result = await fetchReferenceCatalog({ clock: () => NOW, transport: async () => new Response(JSON.stringify(catalog)) });
    assert.equal(result.status, 'unknown');
    assert.deepEqual(result.records, [], 'do not silently skip poisoned records');
    assert.equal(select(result.records).status, 'unknown');
  });
});

test('missing limits stay unknown while boundary capacities are preserved', async () => {
  const fetched = await fetchReferenceCatalog({ clock: () => NOW, transport: async () => new Response(JSON.stringify({
    openai: { id: 'openai', models: {
      'gpt-4o': { id: 'gpt-4o', limit: { context: 128000, input: 128000, output: 128000 } },
      'input-only': { id: 'input-only', limit: { input: 8000 } },
      'missing-limit': { id: 'missing-limit' },
    } },
  })) });
  assert.equal(fetched.status, 'complete');
  assert.deepEqual(fetched.records.map(({ modelId, contextWindow, maxTokens }) => ({ modelId, contextWindow, maxTokens })), [
    { modelId: 'gpt-4o', contextWindow: 128000, maxTokens: 128000 },
    { modelId: 'input-only', contextWindow: null, maxTokens: null },
    { modelId: 'missing-limit', contextWindow: null, maxTokens: null },
  ]);
  assert.equal(select(fetched.records).status, 'matched');
});

test('complete evidence cannot make unrepresentable effort wire values applicable', async (t) => {
  const fetched = await fetchReferenceCatalog({ clock: () => NOW, transport: async () => new Response(JSON.stringify({
    openai: { id: 'openai', models: { 'gpt-4o': { id: 'gpt-4o', limit: { context: 128000 } } } },
  })) });
  for (const [description, wire] of [
    ['leading and trailing whitespace', ' high\n'],
    ['leading whitespace', ' high'],
    ['control character', 'hi\u0001gh'],
    ['C1 control character', 'hi\u0085gh'],
    ['over 512 code units', 'x'.repeat(513)],
  ]) await t.test(description, () => {
    const values = { high: wire };
    // This synthetic map represents Host-controlled reference data; it is not
    // taken from a client, and the fetched snapshot itself does not prove it.
    const records = fetched.records.map((record) => ({ ...record, reasoningEfforts: values }));
    const proof = { ...binding, reasoningEvidence: { complete: true, wireParameter: 'reasoning_effort', values } };
    assert.equal(select(records, {}, [proof]).status, 'unknown');
  });
});

test('reference data does not prove effort wire mapping without separate complete wire evidence', () => {
  assert.equal(select([exactRecord({ reasoningEfforts: { low: 'low', high: 'high' } })]).candidate.reasoningEfforts, null);
  const wireBinding = { ...binding, reasoningEvidence: {
    complete: true, wireParameter: 'reasoning_effort',
    values: { low: 'wire-low', high: 'wire-high' },
  } };
  const record = exactRecord({ reasoningEfforts: { low: 'wire-low', high: 'wire-high' } });
  assert.deepEqual(select([record], {}, [wireBinding]).candidate.reasoningEfforts, { low: 'wire-low', high: 'wire-high' });
  assert.equal(select([record], {}, [{ ...wireBinding, reasoningEvidence: { ...wireBinding.reasoningEvidence, complete: false } }])
    .candidate.reasoningEfforts, null);
});

test('a complete synthetic Host proof preserves shared wires in reference candidates and bridge fields', () => {
  const reasoningEfforts = { off: null, minimal: 'fast', low: 'shared-wire', high: 'shared-wire', max: '深 度😀' };
  const records = [exactRecord({ reasoningEfforts })];
  const options = { provider: binding.provider, modelId: binding.modelId, protocol: binding.protocol,
    endpoint: ENDPOINT, records, now: NOW };
  // Synthetic independently supplied Host binding, not evidence about a real gateway.
  const proof = { ...binding, reasoningEvidence: { complete: true, wireParameter: 'reasoning_effort',
    values: { ...reasoningEfforts } } };
  const candidate = selectReferenceCandidate(options, [proof]);
  assert.equal(candidate.status, 'matched');
  assert.deepEqual(candidate.candidate.reasoningEfforts,
    { off: null, minimal: 'fast', low: 'shared-wire', high: 'shared-wire', max: '深 度😀' });
  assert.notEqual(candidate.candidate.reasoningEfforts, reasoningEfforts);
  const selected = referenceCatalog.selectReferenceFieldsForReconcile(options, [proof]);
  assert.equal(selected.status, 'matched');
  assert.deepEqual(selected.fields.reasoningEfforts, { state: 'known', complete: true,
    value: { off: null, minimal: 'fast', low: 'shared-wire', high: 'shared-wire', max: '深 度😀' }, source,
    referenceIdentity: { exact: true, unique: true, provider: 'openai', modelId: 'gpt-4o', protocol: 'openai-completions' },
  });
  const incomplete = { ...proof, reasoningEvidence: { ...proof.reasoningEvidence, complete: false } };
  const mismatch = { ...proof, reasoningEvidence: { ...proof.reasoningEvidence,
    values: { ...proof.reasoningEvidence.values, high: 'other' } } };
  const extra = { ...proof, reasoningEvidence: { ...proof.reasoningEvidence,
    values: { ...proof.reasoningEvidence.values, xhigh: 'shared-wire' } } };
  for (const noProof of [binding, incomplete, mismatch, extra]) {
    assert.equal(selectReferenceCandidate(options, [noProof]).candidate.reasoningEfforts, null);
    assert.deepEqual(referenceCatalog.selectReferenceFieldsForReconcile(options, [noProof]).fields.reasoningEfforts,
      { state: 'unknown', value: null });
  }
});

test('complete synthetic Host proof cannot admit unsafe effort wires', async (t) => {
  for (const [name, wire] of [
    ['unpaired high surrogate', 'wire\ud800value'],
    ['unpaired low surrogate', 'wire\udfffvalue'],
    ['C1 control', 'wire\u0080value'],
    ['trailing Unicode whitespace', 'wire\u00a0'],
    ['more than 512 UTF-16 units', 'x'.repeat(513)],
  ]) await t.test(name, () => {
    const reasoningEfforts = { off: null, low: 'valid', high: wire };
    const options = { provider: binding.provider, modelId: binding.modelId, protocol: binding.protocol,
      endpoint: ENDPOINT, records: [exactRecord({ reasoningEfforts })], now: NOW };
    // Synthetic independently supplied Host binding, not proof about an actual endpoint.
    const proof = { ...binding, reasoningEvidence: { complete: true, wireParameter: 'reasoning_effort',
      values: { ...reasoningEfforts } } };
    assert.deepEqual(selectReferenceCandidate(options, [proof]),
      { status: 'unknown', candidate: null, reason: 'invalid-effort-map' });
    assert.deepEqual(referenceCatalog.selectReferenceFieldsForReconcile(options, [proof]),
      { status: 'unknown', fields: null, reason: 'invalid-effort-map' });
  });
});

test('retrieval time is measured after the complete response rather than request start', async () => {
  let afterResponse = false;
  const result = await fetchReferenceCatalog({
    clock: () => afterResponse ? NOW : '2026-11-24T03:00:00.000Z',
    transport: async () => {
      afterResponse = true;
      return new Response(JSON.stringify({ openai: { id: 'openai', models: {
        'gpt-4o': { id: 'gpt-4o', limit: { context: 128000 } },
      } } }));
    },
  });
  assert.equal(result.records[0]?.source.fetchedAt, NOW);
  assert.equal(select(result.records).status, 'matched');
});

test('malformed identity or contradictory trusted bindings cannot authorize a reference candidate', () => {
  for (const bindings of [
    [], [binding, binding],
    [{ ...binding, endpoint: 'https://other.example/v1/chat/completions' }],
    [{ ...binding, provider: 'OpenAI' }], [{ ...binding, modelId: 'GPT-4o' }],
    [{ ...binding, protocol: 'openai-responses' }], [{ ...binding, applicability: 'compatible-family' }],
    [{ ...binding, documentationUrl: 'https://u:password@docs.example/spec' }],
    [{ ...binding, documentationUrl: 'http://docs.example/spec' }],
    [{ ...binding, documentationUrl: 'https://docs.example/spec?token=secret' }],
  ]) assert.equal(select([exactRecord()], {}, bindings).status, 'unknown', JSON.stringify(bindings));
  for (const identity of [
    { provider: 'openai\n' }, { modelId: ' gpt-4o' }, { modelId: 'gpt-4o\u0000' },
    { endpoint: 'https://user:password@private-gateway.example/v1/chat/completions' },
    { endpoint: `${ENDPOINT}?key=secret` },
  ]) {
    const candidateRecord = exactRecord({ provider: identity.provider ?? binding.provider, modelId: identity.modelId ?? binding.modelId });
    const candidateBinding = { ...binding, ...identity };
    assert.equal(select([candidateRecord], identity, [candidateBinding]).status, 'unknown', JSON.stringify(identity));
  }
});

test('reference identities reject unsafe text even with exact synthetic Host binding', async (t) => {
  for (const [name, identity] of [
    ['provider with unpaired high surrogate', { provider: 'vendor\ud800name' }],
    ['provider with unpaired low surrogate', { provider: 'vendor\udfffname' }],
    ['model with unpaired high surrogate', { modelId: 'model\ud800id' }],
    ['model with unpaired low surrogate', { modelId: 'model\udfffid' }],
    ['model with reserved __proto__ id', { modelId: '__proto__' }],
    ['model with reserved prototype id', { modelId: 'prototype' }],
    ['model with reserved constructor id', { modelId: 'constructor' }],
    ['model with C1 control', { modelId: 'model\u0080id' }],
  ]) await t.test(name, () => {
    const candidateBinding = { ...binding, ...identity };
    const options = { provider: candidateBinding.provider, modelId: candidateBinding.modelId,
      protocol: candidateBinding.protocol, endpoint: ENDPOINT,
      records: [exactRecord({ provider: candidateBinding.provider, modelId: candidateBinding.modelId })], now: NOW };
    assert.deepEqual(selectReferenceCandidate(options, [candidateBinding]),
      { status: 'unknown', candidate: null, reason: 'invalid-identity' });
    assert.deepEqual(referenceCatalog.selectReferenceFieldsForReconcile(options, [candidateBinding]),
      { status: 'unknown', fields: null, reason: 'invalid-identity' });
  });
});

test('reference selection preserves well-formed Unicode and maximum-length identities and wires', async (t) => {
  for (const [name, provider, modelId, wire] of [
    ['Unicode scalar pair', '供应商-😀', '模型-😀', '深 度😀'],
    ['512 UTF-16 units', 'p'.repeat(512), 'm'.repeat(512), 'w'.repeat(512)],
  ]) await t.test(name, () => {
    const candidateBinding = { ...binding, provider, modelId,
      reasoningEvidence: { complete: true, wireParameter: 'reasoning_effort', values: { high: wire } } };
    const options = { provider, modelId, protocol: binding.protocol, endpoint: ENDPOINT,
      records: [exactRecord({ provider, modelId, reasoningEfforts: { high: wire } })], now: NOW };
    const selected = selectReferenceCandidate(options, [candidateBinding]);
    assert.equal(selected.status, 'matched');
    assert.equal(selected.candidate.provider, provider);
    assert.equal(selected.candidate.modelId, modelId);
    assert.deepEqual(selected.candidate.reasoningEfforts, { high: wire });
    assert.deepEqual(referenceCatalog.selectReferenceFieldsForReconcile(options, [candidateBinding]).fields.reasoningEfforts.value,
      { high: wire });
  });
});

test('candidate provenance is projected without arbitrary private fields', () => {
  const result = select([exactRecord({ source: { ...source, headers: { authorization: 'synthetic-secret' },
    endpoint: ENDPOINT, privateInfo: 'do not expose' } })]);
  assert.equal(result.status, 'matched');
  assert.deepEqual(result.candidate.source, source);
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
  assert.equal(JSON.stringify(result).includes(ENDPOINT), false);
});

test('an exact catalog record without independent endpoint and protocol binding is not applicable', () => {
  const result = selectReferenceCandidate({
    provider: 'openai', modelId: 'gpt-4o', protocol: 'openai-completions',
    endpoint: 'https://private-gateway.example/v1/chat/completions',
    records: [exactRecord()], now: NOW,
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.candidate, null);
});

test('Host bridge connects fetch, exact selection and reconciliation without disclosing private inputs', async () => {
  const secret = 'synthetic-host-credential';
  const requested = [];
  const fetched = await fetchReferenceCatalog({ clock: () => NOW, transport: async (url, options) => {
    requested.push({ url, options });
    return new Response(JSON.stringify({ openai: { id: 'openai', models: {
      'gpt-4o': { id: 'gpt-4o', limit: { context: 128000, input: 123000, output: 16384 } },
    } } }));
  } });
  const args = { provider: binding.provider, modelId: binding.modelId, protocol: binding.protocol,
    endpoint: ENDPOINT, records: fetched.records, now: NOW };
  assert.equal(fetched.status, 'complete');
  assert.equal(selectReferenceCandidate(args).status, 'unknown');
  assert.equal(selectReferenceCandidate(args, [binding]).status, 'matched');
  assert.equal(typeof referenceCatalog.selectReferenceFieldsForReconcile, 'function');
  assert.equal(referenceCatalog.selectReferenceFieldsForReconcile(args).status, 'unknown');
  const bridged = referenceCatalog.selectReferenceFieldsForReconcile(args, [binding]);
  assert.equal(bridged.status, 'matched');
  assert.deepEqual(bridged.fields.contextWindow, { state: 'known', value: 128000,
    source: { kind: 'reference', origin: 'https://models.dev/api.json', fetchedAt: NOW },
    referenceIdentity: { exact: true, unique: true, provider: 'openai', modelId: 'gpt-4o', protocol: 'openai-completions' },
  });
  assert.deepEqual(bridged.fields.reasoningEfforts, { state: 'unknown', value: null });
  const absent = { status: 'absent', evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'absent' } };
  const upstream = normalizeUpstreamCatalog({ provider: binding.provider, protocol: binding.protocol, endpoint: ENDPOINT,
    source: { kind: 'upstream', origin: 'https://private-gateway.example', fetchedAt: NOW },
    payload: { data: [{ id: binding.modelId }] }, responseComplete: true });
  const base = { provider: binding.provider, protocol: binding.protocol, endpoint: ENDPOINT,
    route: { models: [{ id: binding.modelId }], headers: { authorization: secret } }, selectedNewIds: [],
    effective: { status: 'known', models: [{ id: binding.modelId, fields: {
      contextWindow: absent, maxTokens: absent, reasoningEfforts: absent,
    } }] },
  };
  const plan = reconcileMetadata({ ...base, catalog: upstream });
  assert.equal(plan.status, 'ready');
  assert.deepEqual(plan.changes, [], 'reference is not yet connected to the immutable upstream catalog');
  const forgedCatalog = { ...upstream, models: [{ id: binding.modelId, ...bridged.fields }] };
  const forged = reconcileMetadata({ ...base, catalog: forgedCatalog });
  assert.equal(forged.status, 'refused');
  assert.deepEqual(forged.changes, [], 'serializable candidate fields cannot mint write authority');
  assert.equal(requested.length, 1);
  assert.equal(requested[0].url, 'https://models.dev/api.json');
  assert.doesNotMatch(JSON.stringify({ requested, bridged, plan }), /synthetic-host-credential|private-gateway\.example|authorization/);
});

test('Host bridge keeps complete proven effort values but cannot manufacture proof', () => {
  const values = { off: null, low: 'quick', high: 'deep' };
  const records = [exactRecord({ reasoningEfforts: values })];
  const args = { provider: binding.provider, modelId: binding.modelId, protocol: binding.protocol,
    endpoint: ENDPOINT, records, now: NOW };
  const noProof = referenceCatalog.selectReferenceFieldsForReconcile(args, [binding]);
  assert.deepEqual(noProof.fields.reasoningEfforts, { state: 'unknown', value: null });
  const proof = { ...binding, reasoningEvidence: { complete: true, wireParameter: 'reasoning_effort', values } };
  const selected = referenceCatalog.selectReferenceFieldsForReconcile(args, [proof]);
  assert.deepEqual(selected.fields.reasoningEfforts, { state: 'known', complete: true, value: values, source,
    referenceIdentity: { exact: true, unique: true, provider: 'openai', modelId: 'gpt-4o', protocol: 'openai-completions' },
  });
  assert.notEqual(selected.fields.reasoningEfforts.value, values);
});

test('a single exact provider/model/protocol reference produces a nonofficial sourced candidate', () => {
  const result = select([exactRecord()]);
  assert.equal(result.status, 'matched');
  assert.deepEqual(result.candidate, {
    provider: 'openai', modelId: 'gpt-4o', protocol: 'openai-completions',
    contextWindow: 128000, maxTokens: 16384, reasoningEfforts: null, source,
  });
});

test('reference age is bounded strictly to a UTC timestamp, including future and 24-hour cases', () => {
  for (const fetchedAt of [undefined, '', '2026-11-25T03:00:00+00:00', '2026-11-25',
    '2026-11-25T03:00:00.001Z', '2026-11-24T02:59:59.999Z', '2026-02-30T00:00:00.000Z']) {
    assert.equal(select([exactRecord({ source: { ...source, fetchedAt } })]).status, 'unknown', String(fetchedAt));
  }
  assert.equal(select([exactRecord({ source: { ...source, fetchedAt: '2026-11-24T03:00:00.000Z' } })]).status, 'matched');
  assert.equal(select([exactRecord()], { now: '2026-11-25T04:00:00+01:00' }).status, 'unknown');
});

test('missing, false and malformed numeric metadata are never treated as known values', () => {
  const result = select([exactRecord({ contextWindow: null, maxTokens: undefined })]);
  assert.equal(result.status, 'matched');
  assert.equal(result.candidate.contextWindow, null);
  assert.equal(result.candidate.maxTokens, null);
  for (const value of [false, -1, 0, 1.5, '128000', Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = select([exactRecord({ contextWindow: value })]);
    assert.equal(invalid.status, 'unknown', String(value));
  }
});

test('effort mapping is complete, explicit, representable and never inferred from a boolean', () => {
  const reasoningEfforts = { low: 'low', high: 'vendor-high' };
  const proof = { ...binding, reasoningEvidence: { complete: true, wireParameter: 'reasoning_effort', values: reasoningEfforts } };
  assert.deepEqual(select([exactRecord({ reasoningEfforts })], {}, [proof]).candidate.reasoningEfforts, reasoningEfforts);
  assert.equal(select([exactRecord({ reasoningEfforts: false })]).candidate.reasoningEfforts, null);
  for (const invalid of [{}, { off: null }, { low: null }, { low: '' }, { low: 'low', unsupported: 'x' },
    ['low', 'high'], true]) {
    assert.equal(select([exactRecord({ reasoningEfforts: invalid })]).status, 'unknown', JSON.stringify(invalid));
  }
});

test('case, aliases, duplicate or contradictory identities never produce a candidate', () => {
  for (const records of [
    [exactRecord({ provider: 'OpenAI' })],
    [exactRecord({ modelId: 'GPT-4o' })],
    [exactRecord({ protocol: 'OpenAI-chat-completions' })],
    [exactRecord(), exactRecord()],
    [exactRecord(), exactRecord({ protocol: 'other', contextWindow: 123 })],
    [exactRecord({ alias: 'gpt-4o-alias' })],
    [exactRecord({ providerAlias: 'open-ai' })],
    [exactRecord({ identityAmbiguous: true })],
  ]) {
    const result = select(records);
    assert.equal(result.status, 'unknown', JSON.stringify(records));
    assert.equal(result.candidate, null);
  }
});
