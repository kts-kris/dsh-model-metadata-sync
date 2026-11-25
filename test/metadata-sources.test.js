import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUpstreamCatalog } from '../lib/metadata-source.js';

const endpoint = 'https://gateway.example/v1/models';
const source = { kind: 'upstream', origin: 'https://gateway.example', fetchedAt: '2026-11-25T03:00:00.000Z' };
const provenance = {
  provider: 'TestGateway',
  endpoint,
  protocol: 'openai-completions',
  documentationUrl: 'https://docs.example/gateway/models',
  fields: {
    contextWindow: { name: 'context_window', meaning: 'total-context-tokens' },
    maxTokens: { name: 'max_output_tokens', meaning: 'max-output-tokens' },
  },
};

function normalize(rows, options = {}, registry = [provenance]) {
  return normalizeUpstreamCatalog({
    provider: 'TestGateway', protocol: 'openai-completions', endpoint, source,
    payload: { data: rows }, responseComplete: true, existingModelIds: ['Existing-Model'], ...options,
  }, registry);
}

test('documented total context and output are attributed while unknown models stay visible', () => {
  const result = normalize([
    { id: 'New-Model', context_window: 128000, max_output_tokens: 8192 },
    { id: 'Existing-Model', max_input_tokens: 32768 },
  ]);
  assert.equal(result?.status, 'complete');
  assert.equal(result.applicable, true);
  assert.deepEqual(result.models.map(({ id, existing }) => ({ id, existing })), [
    { id: 'New-Model', existing: false }, { id: 'Existing-Model', existing: true },
  ]);
  assert.deepEqual(result.models[0].contextWindow, { state: 'known', value: 128000, source });
  assert.deepEqual(result.models[0].maxTokens, { state: 'known', value: 8192, source });
  assert.equal(result.models[1].contextWindow.state, 'unknown');
  assert.equal(result.models[1].maxTokens.state, 'unknown');
  assert.equal(result.models[1].reasoningEfforts.state, 'unknown');
});

test('a malformed, empty, incomplete, duplicate or invalid-ID result cannot apply any models', () => {
  const cases = [
    { rows: [] },
    { rows: [{ id: 'Same' }, { id: 'Same' }] },
    { rows: [{ id: 'valid' }, { id: '' }] },
    { rows: [{ id: 'valid' }, { id: ' Leading' }] },
    { rows: [{ id: 'valid' }, { id: 'bad\u0000id' }] },
    { rows: [{ id: 42 }] },
    { rows: [{ id: 'valid' }], options: { responseComplete: false } },
    { rows: [{ id: 'valid' }], options: { responseComplete: undefined } },
    { rows: [{ id: 'valid' }], options: { payload: { data: [{ id: 'valid' }], has_more: true } } },
    { rows: [{ id: 'valid' }], options: { payload: { data: [{ id: 'valid' }], error: { message: 'untrusted' } } } },
    { rows: null },
    { rows: new Array(1) },
  ];
  for (const { rows, options } of cases) {
    const result = normalize(rows, options);
    assert.equal(result?.status, 'failed', JSON.stringify({ rows, options }));
    assert.equal(result.applicable, false);
    assert.deepEqual(result.models, []);
  }
});

test('response-provided claims and unrelated or malformed registry proofs cannot establish metadata', () => {
  const row = { id: 'valid', context_window: 128000, max_output_tokens: 8192, provenance };
  for (const registry of [
    [],
    [{ ...provenance, endpoint: 'https://other.example/v1/models' }],
    [{ ...provenance, protocol: 'openai-responses' }],
    [{ ...provenance, provider: 'OtherGateway' }],
    [{ ...provenance, documentationUrl: 'not a URL' }],
    [{ ...provenance, fields: { contextWindow: { name: 'context_window', meaning: 'input-only-tokens' } } }],
    [provenance, provenance],
  ]) {
    const result = normalize([row], { provenance }, registry);
    assert.equal(result.status, 'complete');
    assert.equal(result.models[0].contextWindow.state, 'unknown');
  }
});

test('documented complete reasoning arrays and wire maps preserve every exact level', () => {
  const arrayProof = { ...provenance, fields: {
    ...provenance.fields,
    reasoningEfforts: { name: 'supported_reasoning_levels', meaning: 'complete-levels-identity-wire' },
  } };
  const mappedProof = { ...provenance, fields: {
    ...provenance.fields,
    reasoningEfforts: { name: 'reasoning_level_map', meaning: 'complete-level-wire-map' },
  } };
  const arrayResult = normalize([{ id: 'model', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'] }], {}, [arrayProof]);
  assert.deepEqual(arrayResult.models[0].reasoningEfforts, {
    state: 'known', complete: true, value: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' }, source,
  });
  const mapResult = normalize([{ id: 'model', reasoning_level_map: { off: null, low: 'budget-low', high: 'budget-high' } }], {}, [mappedProof]);
  assert.deepEqual(mapResult.models[0].reasoningEfforts, {
    state: 'known', complete: true, value: { off: null, low: 'budget-low', high: 'budget-high' }, source,
  });
});

test('missing or incomplete reasoning evidence is unknown, not an inferred mapping', () => {
  const rows = [
    { id: 'gpt-reasoning', reasoning: true },
    { id: 'another', supported_reasoning_levels: null },
    { id: 'third', supported_reasoning_levels: ['low', 'high'] },
  ];
  const result = normalize(rows, {}, []);
  for (const model of result.models) {
    assert.equal(model.reasoningEfforts.state, 'unknown');
    assert.equal(model.reasoningEfforts.value, null);
  }
  const proof = { ...provenance, fields: { reasoningEfforts: {
    name: 'supported_reasoning_levels', meaning: 'partial-levels-identity-wire',
  } } };
  assert.equal(normalize([{ id: 'partial', supported_reasoning_levels: ['low'] }], {}, [proof])
    .models[0].reasoningEfforts.state, 'unknown');
});

test('unrepresentable or conflicting reasoning declarations never generate partial maps', () => {
  const arrayProof = { ...provenance, fields: { reasoningEfforts: {
    name: 'supported_reasoning_levels', meaning: 'complete-levels-identity-wire',
  } } };
  const mapProof = { ...provenance, fields: { reasoningEfforts: {
    name: 'reasoning_level_map', meaning: 'complete-level-wire-map',
  } } };
  const sparseLevels = new Array(2);
  sparseLevels[0] = 'low';
  for (const value of [[], ['off'], ['low', 'low'], ['low', 'extreme'], ['low', null], sparseLevels]) {
    const field = normalize([{ id: 'model', supported_reasoning_levels: value }], {}, [arrayProof]).models[0].reasoningEfforts;
    assert.equal(field.state, 'unrepresentable', JSON.stringify(value));
    assert.equal(field.value, null);
  }
  for (const value of [{}, { off: null }, { low: null }, { low: '' }, { low: 'wire', extra: 'wire' }, { low: 'wire', high: false }]) {
    const field = normalize([{ id: 'model', reasoning_level_map: value }], {}, [mapProof]).models[0].reasoningEfforts;
    assert.equal(field.state, 'unrepresentable', JSON.stringify(value));
    assert.equal(field.value, null);
  }
});

test('normalization rejects C1 controls and unpaired surrogates in IDs, preserving well-formed Unicode', async (t) => {
  for (const [name, id] of [
    ['C1 first', 'model\u0080id'], ['C1 last', 'model\u009fid'],
    ['lone high surrogate', 'model\ud800id'], ['lone low surrogate', 'model\udfffid'],
  ]) await t.test(name, () => {
    const result = normalize([{ id: 'valid' }, { id }]);
    assert.equal(result.status, 'failed');
    assert.equal(result.applicable, false);
    assert.deepEqual(result.models, []);
  });
  const result = normalize([{ id: '模型-😀' }]);
  assert.equal(result.status, 'complete');
  assert.equal(result.models[0].id, '模型-😀');
});

test('complete reasoning maps reject unsafe wires as a whole and permit shared valid wires', async (t) => {
  const proof = { ...provenance, fields: { reasoningEfforts: {
    name: 'reasoning_level_map', meaning: 'complete-level-wire-map',
  } } };
  for (const [name, wire] of [
    ['empty', ''], ['whitespace only', ' '], ['leading space', ' low'], ['trailing space', 'low '],
    ['leading Unicode whitespace', '\u00a0low'], ['trailing Unicode whitespace', 'low\u00a0'],
    ['C0 control', 'a\u0001b'], ['DEL control', 'a\u007fb'], ['C1 first', 'a\u0080b'],
    ['C1 last', 'a\u009fb'], ['lone high surrogate', 'a\ud800b'], ['lone low surrogate', 'a\udfffb'],
    ['513 UTF-16 units', 'x'.repeat(513)],
  ]) await t.test(name, () => {
    const field = normalize([{ id: 'model', reasoning_level_map: { off: null, low: 'valid', high: wire } }], {}, [proof])
      .models[0].reasoningEfforts;
    assert.deepEqual(field, { state: 'unrepresentable', value: null });
  });
  for (const [name, value] of [
    ['shared wire', { low: 'same', high: 'same' }],
    ['maximum length', { low: 'x'.repeat(512) }],
    ['well-formed Unicode and internal space', { low: '深 度😀' }],
  ]) await t.test(name, () => {
    const field = normalize([{ id: 'model', reasoning_level_map: value }], {}, [proof]).models[0].reasoningEfforts;
    assert.deepEqual(field, { state: 'known', complete: true, value, source });
  });
});

test('only canonical valid UTC timestamps authorize a catalog', async (t) => {
  for (const fetchedAt of [
    '2026-02-29T03:00:00Z', '2026-04-31T03:00:00.000Z', '2026-11-25T24:00:00Z',
    '2026-11-25 03:00:00Z', '2026-11-25T03:00Z', '2026-11-25T03:00:00.0Z',
    '2026-11-25T03:00:00.0000Z', '2026-11-25T03:00:00+00:00', '2026-11-25T03:00:00',
    '+010000-01-01T00:00:00.000Z', '-000001-01-01T00:00:00.000Z',
  ]) await t.test(fetchedAt, () => {
    const result = normalize([{ id: 'new' }], { source: { ...source, fetchedAt } });
    assert.equal(result.status, 'failed');
    assert.equal(result.applicable, false);
    assert.deepEqual(result.models, []);
  });
  for (const fetchedAt of ['2024-02-29T03:00:00Z', '2024-02-29T03:00:00.123Z']) {
    assert.equal(normalize([{ id: 'valid' }], { source: { ...source, fetchedAt } }).status, 'complete');
  }
});

test('invalid or conflicting numeric capacities never turn into candidates', () => {
  for (const value of [0, -1, 2.5, Number.MAX_SAFE_INTEGER + 1, '128000', null]) {
    const result = normalize([{ id: 'valid', context_window: value, max_output_tokens: value }]);
    assert.equal(result.status, 'complete');
    assert.equal(result.models[0].contextWindow.state, 'unknown', String(value));
    assert.equal(result.models[0].maxTokens.state, 'unknown', String(value));
  }
  const result = normalize([{ id: 'safe', context_window: Number.MAX_SAFE_INTEGER }]);
  assert.equal(result.models[0].contextWindow.value, Number.MAX_SAFE_INTEGER);
});

test('only independently documented positive capacities participate in a same-source contradiction', () => {
  const result = normalize([
    { id: 'contradiction', context_window: 4096, max_output_tokens: 8192 },
    { id: 'equal', context_window: 8192, max_output_tokens: 8192 },
    { id: 'invalid', context_window: 0, max_output_tokens: 8192 },
  ]);
  assert.equal(result.status, 'complete');
  assert.deepEqual([result.models[0].contextWindow.state, result.models[0].maxTokens.state], ['conflicting', 'conflicting']);
  assert.deepEqual([result.models[1].contextWindow.value, result.models[1].maxTokens.value], [8192, 8192]);
  assert.deepEqual([result.models[2].contextWindow.state, result.models[2].maxTokens.state], ['unknown', 'known']);
  const undocumented = { ...provenance, fields: {
    ...provenance.fields, contextWindow: { name: 'context_window', meaning: 'input-only-tokens' },
  } };
  const [model] = normalize([{ id: 'm', context_window: 4096, max_output_tokens: 8192 }], {}, [undocumented]).models;
  assert.equal(model.contextWindow.state, 'unknown');
  assert.equal(model.maxTokens.state, 'known');
});

test('catalog identity and source must bind to the configured endpoint and supported protocol', () => {
  const rows = [{ id: 'valid' }];
  for (const options of [
    { provider: '' },
    { protocol: 'openai-responses' },
    { endpoint: 'https://other.example/v1/models' },
    { endpoint: 'https://user:password@gateway.example/v1/models' },
    { source: { ...source, kind: 'reference' } },
    { source: { ...source, origin: 'https://other.example' } },
    { source: { ...source, fetchedAt: 'not a date' } },
  ]) {
    const result = normalize(rows, options);
    assert.equal(result?.status, 'failed', JSON.stringify(options));
    assert.equal(result.applicable, false);
    assert.deepEqual(result.models, []);
  }
});
