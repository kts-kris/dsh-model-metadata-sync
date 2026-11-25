import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileMetadata as reconcileHostMetadata, reconcileMetadataForTest } from '../lib/safe-reconcile.js';
import { normalizeUpstreamCatalog } from '../lib/metadata-source.js';
import { createReferenceBridgeForTest } from '../lib/reference-catalog.js';
import { fetchReferenceWorker } from '../lib/reference-worker.js';
import { createReferenceWorkerControllerForTest } from '../lib/reference-worker-client.js';
import { EventEmitter } from 'node:events';

// Adapt synthetic rows into an actual immutable normalizer result. These are
// test fixtures for reconciliation, not a production evidence-minting API.
const testEndpoint = 'https://gateway.example/v1/models';
const testProtocol = 'openai-completions';
function syntheticController(snapshot) {
  return createReferenceWorkerControllerForTest({ receiptClock: () => '2026-11-25T03:00:00.000Z', createWorker() {
    const worker = new EventEmitter();
    queueMicrotask(() => { worker.emit('message', JSON.stringify(snapshot.records)); worker.emit('exit', 0); });
    return worker;
  } });
}
function trustedFixtureCatalog(rows) {
  const payloadRows = rows.map((row) => ({ id: row.id,
    ...(row.contextWindow?.state === 'known' ? { context: row.contextWindow.value } : {}),
    ...(row.maxTokens?.state === 'known' ? { output: row.maxTokens.value } : {}),
    ...(row.reasoningEfforts?.state === 'known' && row.reasoningEfforts.complete === true
      ? { effort: row.reasoningEfforts.value } : {}),
  }));
  return normalizeUpstreamCatalog({ provider: 'sample', protocol: testProtocol, endpoint: testEndpoint,
    source: { kind: 'upstream', origin: 'https://gateway.example', fetchedAt: '2026-11-25T03:00:00.000Z' },
    payload: { data: payloadRows }, responseComplete: true }, [{
    provider: 'sample', protocol: testProtocol, endpoint: testEndpoint, documentationUrl: 'https://docs.example/models',
    fields: { contextWindow: { name: 'context', meaning: 'total-context-tokens' },
      maxTokens: { name: 'output', meaning: 'max-output-tokens' },
      reasoningEfforts: { name: 'effort', meaning: 'complete-level-wire-map' } },
  }]);
}
function reconcileMetadata(options) {
  if (options.catalog?.status !== 'complete' || options.catalog?.applicable !== true ||
      !Array.isArray(options.catalog.models)) return reconcileHostMetadata(options);
  return reconcileHostMetadata({ provider: 'sample', endpoint: testEndpoint, protocol: testProtocol, ...options,
    catalog: trustedFixtureCatalog(options.catalog.models) });
}

test('preserves complete existing model objects and appends only selected IDs in upstream order', () => {
  const route = {
    models: [
      { id: 'beta', contextWindow: null, reasoningEfforts: false, input: [], compat: {}, extra: { nested: false }, headers: { 'X-Secret': 'model-secret' } },
      { id: 'alpha', maxTokens: 300, extra: { list: [null, false, {}] } },
    ],
    headers: { 'X-Secret': 'route-secret' },
  };
  const result = reconcileMetadata({
    provider: 'sample', route,
    catalog: { status: 'complete', applicable: true, models: [
      { id: 'new-first' }, { id: 'alpha' }, { id: 'not-selected' }, { id: 'beta' }, { id: 'new-last' },
    ] },
    selectedNewIds: ['new-last', 'new-first'],
    effective: { status: 'unknown', models: [] },
  });
  assert.equal(result?.status, 'ready');
  assert.equal(result.changed, true);
  assert.deepEqual(result.changes, [
    { type: 'add-model', modelId: 'new-first' },
    { type: 'add-model', modelId: 'new-last' },
  ]);
  assert.deepEqual(route.models, [
    { id: 'beta', contextWindow: null, reasoningEfforts: false, input: [], compat: {}, extra: { nested: false }, headers: { 'X-Secret': 'model-secret' } },
    { id: 'alpha', maxTokens: 300, extra: { list: [null, false, {}] } },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /model-secret|route-secret|X-Secret|headers|nested/);
});

test('previews inherited catalog additions as unsupported without replacing the catalog', () => {
  const route = { modelOverrides: { 'catalog-old': { custom: { retain: null } } } };
  const result = reconcileMetadata({
    provider: 'sample', route,
    catalog: { status: 'complete', applicable: true, models: [
      { id: 'new-first' }, { id: 'catalog-old' }, { id: 'new-last' },
    ] },
    selectedNewIds: ['new-last', 'new-first'],
    effective: { status: 'known', inventoryComplete: true, models: [{ id: 'catalog-old' }, { id: 'catalog-hidden' }] },
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.changed, false);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.items.map(({ modelId, existing, applicable, reason }) => ({ modelId, existing, applicable, reason })), [
    { modelId: 'new-first', existing: false, applicable: false, reason: 'inherited-add-unsupported' },
    { modelId: 'catalog-old', existing: true, applicable: false, reason: undefined },
    { modelId: 'new-last', existing: false, applicable: false, reason: 'inherited-add-unsupported' },
  ]);
  assert.ok(result.items.every(({ fields }) => fields.every(({ state }) => state === 'unknown')));
  assert.deepEqual(route, { modelOverrides: { 'catalog-old': { custom: { retain: null } } } });
});

test('protects explicit, catalog and unknown state while replacing a proven system fallback', () => {
  const source = { kind: 'upstream', origin: 'https://private.example', fetchedAt: '2026-11-25T03:00:00.000Z', headers: { Authorization: 'source-secret' } };
  const known = (value) => ({ state: 'known', value, source });
  const route = { models: [
    { id: 'configured', contextWindow: null, maxTokens: 500, input: [], reasoningEfforts: false, opaque: { headers: { auth: 'model-secret' } } },
    { id: 'catalog' },
    { id: 'system' },
    { id: 'unreadable' },
  ] };
  const result = reconcileMetadata({
    provider: 'sample', route,
    catalog: { status: 'complete', applicable: true, models: [
      { id: 'configured', contextWindow: known(64000), maxTokens: known(8192), reasoningEfforts: { ...known({ low: 'low', high: 'high' }), complete: true } },
      { id: 'catalog', contextWindow: known(64000), maxTokens: known(8192), reasoningEfforts: { ...known({ low: 'low', high: 'high' }), complete: true } },
      { id: 'system', contextWindow: known(64000), maxTokens: known(8192) },
      { id: 'unreadable', contextWindow: known(64000) },
    ] },
    selectedNewIds: [],
    effective: { status: 'known', models: [
      { id: 'configured', fields: {} },
      { id: 'catalog', fields: {
        contextWindow: { status: 'catalog', value: 32000 },
        maxTokens: { status: 'catalog', value: 1024 },
        reasoningEfforts: { status: 'catalog', value: { high: 'high' } },
      } },
      { id: 'system', fields: {
        contextWindow: { status: 'system-fallback', value: 131072, evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'system-default' } },
        maxTokens: { status: 'system-fallback', value: 4096, evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'system-default' } },
      } },
      { id: 'unreadable', fields: { contextWindow: { status: 'unknown' } } },
    ] },
  });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.changes, [
    { type: 'set-field', scope: 'models', modelId: 'system', index: 2, field: 'contextWindow', value: 64000 },
    { type: 'set-field', scope: 'models', modelId: 'system', index: 2, field: 'maxTokens', value: 8192 },
  ]);
  const configured = result.items.find((item) => item.modelId === 'configured');
  const inherited = result.items.find((item) => item.modelId === 'catalog');
  const unreadable = result.items.find((item) => item.modelId === 'unreadable');
  assert.deepEqual(configured.fields.map(({ field, reason }) => [field, reason]), [
    ['contextWindow', 'explicit-value'], ['maxTokens', 'explicit-value'], ['reasoningEfforts', 'explicit-value'],
  ]);
  assert.deepEqual(inherited.fields.map(({ field, state, reason }) => [field, state, reason]), [
    ['contextWindow', 'conflict', 'catalog-value'], ['maxTokens', 'conflict', 'catalog-value'], ['reasoningEfforts', 'conflict', 'catalog-value'],
  ]);
  assert.equal(unreadable.fields[0].reason, 'effective-state-unknown');
  assert.doesNotMatch(JSON.stringify(result), /source-secret|model-secret|Authorization|headers|private\.example/);
  assert.deepEqual(route.models[0], { id: 'configured', contextWindow: null, maxTokens: 500, input: [], reasoningEfforts: false, opaque: { headers: { auth: 'model-secret' } } });
});

test('an explicitly supplied provider default is protected even against conflicting fallback evidence', () => {
  const result = reconcileMetadata({
    provider: 'sample',
    route: { models: [{ id: 'm' }], defaultContextWindow: 131072 },
    catalog: { status: 'complete', applicable: true, models: [{ id: 'm', contextWindow: {
      state: 'known', value: 64000, source: { kind: 'upstream', origin: 'https://gateway.example', fetchedAt: '2026-11-25T03:00:00.000Z' },
    } }] },
    selectedNewIds: [],
    effective: { status: 'known', models: [{ id: 'm', fields: { contextWindow: {
      status: 'system-fallback', value: 131072,
      evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'system-default' },
    } } }] },
  });
  assert.deepEqual(result.changes, []);
  assert.equal(result.items[0].fields[0].reason, 'provider-default');
});

test('a selected new model cannot bypass unknown inherited capacity or effort evidence', () => {
  const source = { kind: 'upstream', origin: 'https://gateway.example', fetchedAt: '2026-11-25T03:00:00.000Z' };
  const known = (value) => ({ state: 'known', value, source });
  const result = reconcileMetadata({
    provider: 'sample', route: { models: [{ id: 'existing' }] }, selectedNewIds: ['new'],
    catalog: { status: 'complete', applicable: true, models: [
      { id: 'new', contextWindow: known(64000), maxTokens: known(8192), reasoningEfforts: { ...known({ low: 'low', high: 'high' }), complete: true } },
      { id: 'existing' },
    ] },
    effective: { status: 'unknown', models: [] },
  });
  assert.deepEqual(result.changes, [{ type: 'add-model', modelId: 'new' }]);
  assert.ok(Array.isArray(result.items[0].fields));
  assert.deepEqual(result.items[0].fields.map(({ field, state, reason }) => [field, state, reason]), [
    ['contextWindow', 'unknown', 'effective-state-unknown'],
    ['maxTokens', 'unknown', 'effective-state-unknown'],
    ['reasoningEfforts', 'unknown', 'effective-state-unknown'],
  ]);
});

test('fills proven absent fields and complete efforts after the ordered new-model addition', () => {
  const source = { kind: 'upstream', origin: 'https://gateway.example', fetchedAt: '2026-11-25T03:00:00.000Z' };
  const absent = { status: 'absent', evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'absent' } };
  const result = reconcileMetadata({
    provider: 'sample', route: { models: [{ id: 'existing', compat: { x: false } }] }, selectedNewIds: ['new'],
    catalog: { status: 'complete', applicable: true, models: [
      { id: 'new', contextWindow: { state: 'known', value: 64000, source },
        reasoningEfforts: { state: 'known', value: { off: null, low: 'quick', high: 'deep' }, source, complete: true } },
    ] },
    effective: { status: 'known', models: [{ id: 'new', fields: { contextWindow: absent, maxTokens: absent, reasoningEfforts: absent } }] },
  });
  assert.deepEqual(result.changes, [
    { type: 'add-model', modelId: 'new' },
    { type: 'set-field', scope: 'models', modelId: 'new', index: 1, field: 'contextWindow', value: 64000 },
    { type: 'set-field', scope: 'models', modelId: 'new', index: 1, field: 'reasoningEfforts', value: { off: null, low: 'quick', high: 'deep' } },
  ]);
});

test('a self-reported reference candidate cannot establish trusted authority', () => {
  const source = { kind: 'reference', origin: 'https://models.dev/api.json', fetchedAt: '2026-11-25T03:00:00.000Z' };
  const result = reconcileHostMetadata({
    provider: 'sample', endpoint: testEndpoint, protocol: testProtocol, route: { models: [{ id: 'm' }] },
    selectedNewIds: [], now: '2026-11-25T04:00:00.000Z',
    catalog: { status: 'complete', applicable: true, models: [{ id: 'm', contextWindow: { state: 'known', value: 64000, source,
      referenceIdentity: { exact: true, unique: true, provider: 'sample', modelId: 'm', protocol: testProtocol } } }] },
    effective: { status: 'known', models: [{ id: 'm', fields: { contextWindow: {
      status: 'absent', evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'absent' },
    } } }] },
  });
  assert.equal(result.status, 'refused');
  assert.deepEqual(result.changes, []);
});

// All transport, documentation, target binding and clock evidence here is
// synthetic Host-controlled test data, not proof about a real deployment.
test('validated exact reference can fill a proven absence within its freshness window', async () => {
  const fetchedAt = '2026-11-25T03:00:00.000Z';
  let now = '2026-11-25T04:00:00.000Z';
  const catalog = trustedFixtureCatalog([{ id: 'm' }]);
  const snapshot = await fetchReferenceWorker({ clock: () => fetchedAt, transport: async () => new Response(JSON.stringify({
    sample: { id: 'sample', models: { m: { id: 'm', limit: { context: 64000 } } } },
  })) });
  const bridge = createReferenceBridgeForTest({ clock: () => now, controller: syntheticController(snapshot),
    bindings: [{ provider: 'sample', endpoint: testEndpoint, protocol: testProtocol, modelId: 'm',
      documentationUrl: 'https://synthetic-docs.example/target', applicability: 'exact-endpoint-model-protocol' }],
    semantics: [{ source: 'https://models.dev/api.json', documentationUrl: 'https://synthetic-docs.example/source',
      fields: { contextWindow: { name: 'limit.context', meaning: 'total-context-tokens' } } }],
  });
  const capability = await bridge.fetch({ catalog, provider: 'sample', endpoint: testEndpoint, protocol: testProtocol });
  const absent = { status: 'absent', evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'absent' } };
  const base = { provider: 'sample', endpoint: testEndpoint, protocol: testProtocol, catalog, reference: capability,
    route: { models: [{ id: 'm' }], headers: { secret: 'discard' } }, selectedNewIds: [],
    effective: { status: 'known', models: [{ id: 'm', fields: { contextWindow: absent, maxTokens: absent } }] } };
  const result = reconcileMetadataForTest(base);
  assert.deepEqual(result.changes, [{ type: 'set-field', scope: 'models', modelId: 'm', index: 0, field: 'contextWindow', value: 64000 }]);
  assert.deepEqual(result.items[0].fields[0].source, { kind: 'reference', origin: 'https://models.dev/api.json', fetchedAt });
  assert.doesNotMatch(JSON.stringify(result), /secret|discard/);
  assert.deepEqual(reconcileHostMetadata(base).changes, [], 'synthetic capability is not production authority');
  for (const options of [{ provider: 'Sample' }, { protocol: 'openai-responses' }]) {
    assert.deepEqual(reconcileMetadataForTest({ ...base, ...options }).changes, []);
  }
  for (const instant of ['2026-11-26T03:00:00.001Z', '2026-11-25T02:00:00.000Z', null]) {
    now = instant;
    assert.deepEqual(reconcileMetadataForTest(base).changes, []);
  }
});

test('rejects duplicate or malformed identities, incomplete discovery and conflicting list plus overrides', () => {
  const base = { provider: 'sample', route: { models: [{ id: 'old' }] }, selectedNewIds: [],
    catalog: { status: 'complete', applicable: true, models: [{ id: 'new' }] }, effective: { status: 'unknown', models: [] } };
  for (const input of [
    { route: { models: [] } },
    { route: { models: [{ id: 'old' }, { id: 'old' }] } },
    { route: { models: [{ id: '' }] } },
    { route: { models: [{ id: 'old' }], modelOverrides: {} } },
    { catalog: { status: 'complete', applicable: true, models: [] } },
    { catalog: { status: 'complete', applicable: true, models: [{ id: 'new' }, { id: 'new' }] } },
    { catalog: { status: 'complete', applicable: true, models: [{ id: ' bad' }] } },
    { catalog: { status: 'complete', applicable: true, models: [{ id: '__proto__' }] } },
    { catalog: { status: 'incomplete', applicable: false, models: [{ id: 'new' }] } },
    { selectedNewIds: ['new', 'new'] }, { selectedNewIds: [''] },
    { selectedNewIds: ['missing'] }, { selectedNewIds: ['old'] },
    { effective: { status: 'known', models: [{ id: 'old' }, { id: 'old' }] } },
  ]) {
    const result = reconcileMetadata({ ...base, ...input });
    assert.equal(result.status, 'refused', JSON.stringify(input));
    assert.deepEqual(result.changes, []);
  }
});

test('empty selection never appends models and false/null/empty existing metadata wins', () => {
  const source = { kind: 'upstream', origin: 'https://gateway.example', fetchedAt: '2026-11-25T03:00:00.000Z' };
  const model = { id: 'old', contextWindow: null, maxTokens: false, input: [], reasoningEfforts: {} };
  const result = reconcileMetadata({ provider: 'sample', route: { models: [model] }, selectedNewIds: [],
    catalog: { status: 'complete', applicable: true, models: [
      { id: 'new' }, { id: 'old', contextWindow: { state: 'known', value: 64000, source },
        maxTokens: { state: 'known', value: 8192, source },
        reasoningEfforts: { state: 'known', value: { low: 'low' }, complete: true, source } },
    ] }, effective: { status: 'unknown', models: [] } });
  assert.equal(result.changed, false);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(model, { id: 'old', contextWindow: null, maxTokens: false, input: [], reasoningEfforts: {} });
  assert.deepEqual(result.items[1].fields.map(({ reason }) => reason), ['explicit-value', 'explicit-value', 'explicit-value']);
});

test('writes inherited-catalog metadata only as an override for a proven existing model', () => {
  const source = { kind: 'upstream', origin: 'https://gateway.example', fetchedAt: '2026-11-25T03:00:00.000Z' };
  const route = { models: [], modelOverrides: { m: { compat: { nested: false }, custom: { headers: { 'X-Custom': 'private' } } } } };
  const result = reconcileMetadata({ provider: 'sample', route, selectedNewIds: ['new'],
    catalog: { status: 'complete', applicable: true, models: [{ id: 'new' }, { id: 'm', maxTokens: { state: 'known', value: 16000, source } }] },
    effective: { status: 'known', inventoryComplete: true, models: [{ id: 'm', fields: {
      contextWindow: { status: 'catalog', value: 32000 }, maxTokens: { status: 'system-fallback', value: 4096,
        evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'system-default' } },
    } }, { id: 'not-discovered' }] } });
  assert.deepEqual(result.changes, [{ type: 'set-field', scope: 'modelOverrides', modelId: 'm', field: 'maxTokens', value: 16000 }]);
  assert.equal(result.items[0].reason, 'inherited-add-unsupported');
  assert.deepEqual(route.modelOverrides.m, { compat: { nested: false }, custom: { headers: { 'X-Custom': 'private' } } });
  assert.doesNotMatch(JSON.stringify(result), /X-Custom|private|headers/);
});

test('rejects incomplete effort maps and unproven fallback, but preserves provider and catalog defaults', () => {
  const source = { kind: 'upstream', origin: 'https://gateway.example', fetchedAt: '2026-11-25T03:00:00.000Z' };
  const absent = { status: 'absent', evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'absent' } };
  const rows = [
    { id: 'partial', reasoningEfforts: { state: 'known', value: { low: 'low' }, source } },
    { id: 'off-only', reasoningEfforts: { state: 'known', value: { off: null }, source, complete: true } },
    { id: 'unsupported', reasoningEfforts: { state: 'known', value: { low: 'low', extra: 'bad' }, source, complete: true } },
    { id: 'no-proof', contextWindow: { state: 'known', value: 64000, source } },
    { id: 'input', reasoningEfforts: { state: 'known', value: { low: 'low' }, source, complete: true } },
  ];
  const result = reconcileMetadata({ provider: 'sample', route: { models: rows.map(({ id }) => ({ id })) }, selectedNewIds: [],
    catalog: { status: 'complete', applicable: true, models: rows },
    effective: { status: 'known', models: [
      { id: 'partial', fields: { reasoningEfforts: absent } }, { id: 'off-only', fields: { reasoningEfforts: absent } },
      { id: 'unsupported', fields: { reasoningEfforts: absent } },
      { id: 'no-proof', fields: { contextWindow: { status: 'system-fallback', value: 131072 } } },
      { id: 'input', fields: { input: { status: 'catalog', value: ['image'] }, reasoningEfforts: { status: 'catalog', value: false } } },
    ] } });
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.items.map((item, i) => item.fields.find(({ field }) =>
    field === (i === 3 ? 'contextWindow' : 'reasoningEfforts')).reason),
    ['candidate-unknown', 'candidate-unknown', 'candidate-unknown', 'effective-state-unknown', 'catalog-value']);
});

test('explicit empty selection is required rather than treating a missing selection as consent', () => {
  const result = reconcileMetadata({ provider: 'sample', route: { models: [{ id: 'old' }] },
    catalog: { status: 'complete', applicable: true, models: [{ id: 'new' }] }, effective: { status: 'unknown' } });
  assert.equal(result.status, 'refused');
  assert.deepEqual(result.changes, []);
});

test('status known without a catalog model inventory cannot authorize additions on inherited routes', () => {
  const result = reconcileMetadata({ provider: 'sample', route: {}, selectedNewIds: ['new'],
    catalog: { status: 'complete', applicable: true, models: [{ id: 'old' }, { id: 'new' }] },
    effective: { status: 'known', models: [{ id: 'old' }] } });
  assert.equal(result.status, 'refused');
  assert.deepEqual(result.changes, []);
});

test('rejects model arrays with missing entries rather than constructing an ambiguous write', () => {
  const models = new Array(1);
  const result = reconcileMetadata({ provider: 'sample', route: { models }, selectedNewIds: [],
    catalog: { status: 'complete', applicable: true, models: [{ id: 'new' }] }, effective: { status: 'unknown' } });
  assert.equal(result.status, 'refused');
  assert.deepEqual(result.changes, []);
});

test('distinguishes upstream, reference and conflicting source declarations without leaking private origins', async () => {
  const fetchedAt = '2026-11-25T03:00:00.000Z';
  const known = value => ({ state: 'known', value });
  const catalog = trustedFixtureCatalog([{ id: 'm', contextWindow: known(12000), maxTokens: known(4000) }]);
  const snapshot = await fetchReferenceWorker({ clock: () => fetchedAt, transport: async () => new Response(JSON.stringify({
    sample: { id: 'sample', models: { m: { id: 'm', limit: { context: 20000, output: 4000 } } } },
  })) });
  const bridge = createReferenceBridgeForTest({ clock: () => fetchedAt, controller: syntheticController(snapshot),
    bindings: [{ provider: 'sample', endpoint: testEndpoint, protocol: testProtocol, modelId: 'm',
      documentationUrl: 'https://synthetic-docs.example/target', applicability: 'exact-endpoint-model-protocol' }],
    semantics: [{ source: 'https://models.dev/api.json', documentationUrl: 'https://synthetic-docs.example/source', fields: {
      contextWindow: { name: 'limit.context', meaning: 'total-context-tokens' },
      maxTokens: { name: 'limit.output', meaning: 'max-output-tokens' },
    } }],
  });
  const capability = await bridge.fetch({ catalog, provider: 'sample', endpoint: testEndpoint, protocol: testProtocol });
  const absent = { status: 'absent', evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'absent' } };
  const result = reconcileMetadataForTest({ provider: 'sample', endpoint: testEndpoint, protocol: testProtocol,
    route: { models: [{ id: 'm' }] }, selectedNewIds: [], catalog, reference: capability,
    effective: { status: 'known', models: [{ id: 'm', fields: { contextWindow: absent, maxTokens: absent } }] } });
  assert.deepEqual(result.changes, [{ type: 'set-field', scope: 'models', modelId: 'm', index: 0, field: 'maxTokens', value: 4000 }]);
  const conflict = result.items[0].fields.find(field => field.field === 'contextWindow');
  assert.equal(conflict.state, 'conflict');
  assert.equal(conflict.reason, 'source-conflict');
  assert.equal(conflict.referenceCandidate, 20000);
  assert.deepEqual(conflict.referenceSource, { kind: 'reference', origin: 'https://models.dev/api.json', fetchedAt });
  assert.doesNotMatch(JSON.stringify(result), /gateway\.example|synthetic-docs\.example/);
});

test('accepts a normalizer-verified full wire map but not a partial declaration', () => {
  const endpoint = 'https://gateway.example/v1/models';
  const source = { kind: 'upstream', origin: 'https://gateway.example', fetchedAt: '2026-11-25T03:00:00.000Z' };
  const proof = { provider: 'sample', endpoint, protocol: 'openai-completions', documentationUrl: 'https://docs.example/models',
    fields: { reasoningEfforts: { name: 'reasoning_level_map', meaning: 'complete-level-wire-map' } } };
  const catalog = normalizeUpstreamCatalog({ provider: 'sample', protocol: 'openai-completions', endpoint, source,
    payload: { data: [{ id: 'm', reasoning_level_map: { off: null, low: 'quick', high: 'deep' } }] }, responseComplete: true }, [proof]);
  const result = reconcileHostMetadata({ provider: 'sample', endpoint, protocol: 'openai-completions', route: { models: [{ id: 'm' }] }, selectedNewIds: [], catalog,
    effective: { status: 'known', models: [{ id: 'm', fields: { reasoningEfforts: {
      status: 'absent', evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'absent' },
    } } }] },
  });
  assert.deepEqual(result.changes, [
    { type: 'set-field', scope: 'models', modelId: 'm', index: 0, field: 'reasoningEfforts', value: { off: null, low: 'quick', high: 'deep' } },
  ]);
  assert.deepEqual(result.items[0].fields.find(({ field }) => field === 'reasoningEfforts').source,
    { kind: 'upstream', fetchedAt: '2026-11-25T03:00:00.000Z' });
});

test('upstream discovery can authorize additions and fields only for its exact target binding', async (t) => {
  const endpoint = 'https://b.example/v1/models';
  const protocol = 'openai-completions';
  const source = { kind: 'upstream', origin: 'https://b.example', fetchedAt: '2026-11-25T03:00:00.000Z' };
  const catalog = normalizeUpstreamCatalog({ provider: 'B', endpoint, protocol, source, responseComplete: true,
    payload: { data: [{ id: 'old', context_window: 64000 }, { id: 'new', context_window: 32000 }] },
  }, [{ provider: 'B', endpoint, protocol, documentationUrl: 'https://docs.example/models',
    fields: { contextWindow: { name: 'context_window', meaning: 'total-context-tokens' } } }]);
  const absent = { status: 'absent', evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'absent' } };
  const base = { provider: 'B', endpoint, protocol, route: { models: [{ id: 'old' }] }, catalog,
    selectedNewIds: ['new'], effective: { status: 'known', models: [
      { id: 'old', fields: { contextWindow: absent, maxTokens: absent } }, { id: 'new', fields: { contextWindow: absent, maxTokens: absent } },
    ] } };
  assert.equal(catalog.status, 'complete');
  assert.deepEqual(reconcileHostMetadata(base).changes, [
    { type: 'add-model', modelId: 'new' },
    { type: 'set-field', scope: 'models', modelId: 'old', index: 0, field: 'contextWindow', value: 64000 },
    { type: 'set-field', scope: 'models', modelId: 'new', index: 1, field: 'contextWindow', value: 32000 },
  ]);
  for (const [name, target] of [
    ['different provider', { provider: 'A' }],
    ['different endpoint path', { endpoint: 'https://b.example/another/v1/models' }],
    ['different origin', { endpoint: 'https://a.example/v1/models' }],
    ['different port', { endpoint: 'https://b.example:8443/v1/models' }],
    ['missing endpoint', { endpoint: undefined }],
    ['different protocol', { protocol: 'openai-responses' }],
    ['missing protocol', { protocol: undefined }],
  ]) await t.test(name, () => {
    const result = reconcileHostMetadata({ ...base, ...target });
    assert.deepEqual(result.changes, []);
    assert.equal(result.status, 'refused');
    assert.equal(result.changed, false);
  });
});

test('catalog capabilities reject cloned, forged, or mutated catalog data', () => {
  const endpoint = 'https://private-gateway.example/v1/models';
  const protocol = 'openai-completions';
  const source = { kind: 'upstream', origin: 'https://private-gateway.example', fetchedAt: '2026-11-25T03:00:00.000Z' };
  const payload = { data: [{ id: 'old', context_window: 64000 }, { id: 'new', context_window: 32000 }] };
  const proof = { provider: 'B', endpoint, protocol, documentationUrl: 'https://docs.example/models',
    fields: { contextWindow: { name: 'context_window', meaning: 'total-context-tokens' } } };
  const catalog = normalizeUpstreamCatalog({ provider: 'B', endpoint, protocol, source, payload, responseComplete: true }, [proof]);
  const absent = { status: 'absent', evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'absent' } };
  const base = { provider: 'B', endpoint, protocol, route: { models: [{ id: 'old' }], headers: { Authorization: 'route-secret' } },
    catalog, selectedNewIds: ['new'], effective: { status: 'known', models: [
      { id: 'old', fields: { contextWindow: absent } }, { id: 'new', fields: { contextWindow: absent } },
    ] } };
  const originalPlan = reconcileHostMetadata(base);
  assert.equal(originalPlan.changed, true);
  assert.doesNotMatch(JSON.stringify(originalPlan), /private-gateway|route-secret|Authorization|headers/);
  assert.throws(() => { catalog.models[0].contextWindow.value = 1; }, TypeError);
  assert.throws(() => { catalog.models[0].contextWindow.source.origin = 'https://attacker.example'; }, TypeError);
  assert.throws(() => { catalog.models[0].id = 'forged'; }, TypeError);
  assert.throws(() => { catalog.models.push({ id: 'forged' }); }, TypeError);
  payload.data[0].context_window = 1;
  payload.data[1].id = 'forged';
  proof.fields.contextWindow.meaning = 'different';
  source.origin = 'https://attacker.example';
  assert.deepEqual(reconcileHostMetadata(base).changes, originalPlan.changes);
  for (const fake of [
    { ...catalog }, JSON.parse(JSON.stringify(catalog)), structuredClone(catalog),
    { ...catalog, binding: { provider: 'B', endpoint, protocol, origin: 'https://private-gateway.example' } },
  ]) {
    const result = reconcileHostMetadata({ ...base, catalog: fake });
    assert.equal(result.status, 'refused');
    assert.deepEqual(result.changes, []);
    assert.doesNotMatch(JSON.stringify(result), /private-gateway|route-secret|Authorization|headers/);
  }
});

test('inconsistent same-source context and output cannot generate capacity writes', () => {
  const known = (value) => ({ state: 'known', value });
  const absent = { status: 'absent', evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'absent' } };
  const catalog = trustedFixtureCatalog([{ id: 'm', contextWindow: known(4096), maxTokens: known(8192) }]);
  const result = reconcileHostMetadata({ provider: 'sample', endpoint: testEndpoint, protocol: testProtocol,
    route: { models: [{ id: 'm' }] }, selectedNewIds: [], catalog,
    effective: { status: 'known', models: [{ id: 'm', fields: { contextWindow: absent, maxTokens: absent } }] },
  });
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.items[0].fields.filter(({ field }) => ['contextWindow', 'maxTokens'].includes(field))
    .map(({ field, state }) => [field, state]), [['contextWindow', 'conflict'], ['maxTokens', 'conflict']]);
});

test('an explicit context prevents an output candidate from exceeding it', () => {
  const known = (value) => ({ state: 'known', value });
  const absent = { status: 'absent', evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'absent' } };
  const catalog = trustedFixtureCatalog([{ id: 'm', contextWindow: known(64000), maxTokens: known(8192) }]);
  const result = reconcileHostMetadata({ provider: 'sample', endpoint: testEndpoint, protocol: testProtocol,
    route: { models: [{ id: 'm', contextWindow: 4096 }] }, selectedNewIds: [], catalog,
    effective: { status: 'known', models: [{ id: 'm', fields: { maxTokens: absent } }] },
  });
  assert.deepEqual(result.changes, []);
  assert.equal(result.items[0].fields.find(({ field }) => field === 'maxTokens').state, 'conflict');
});

test('an explicit output prevents a context candidate smaller than it', () => {
  const known = (value) => ({ state: 'known', value });
  const absent = { status: 'absent', evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'absent' } };
  const catalog = trustedFixtureCatalog([{ id: 'm', contextWindow: known(32768), maxTokens: known(8192) }]);
  const result = reconcileHostMetadata({ provider: 'sample', endpoint: testEndpoint, protocol: testProtocol,
    route: { models: [{ id: 'm', maxTokens: 65536 }] }, selectedNewIds: [], catalog,
    effective: { status: 'known', models: [{ id: 'm', fields: { contextWindow: absent } }] },
  });
  assert.deepEqual(result.changes, []);
  assert.equal(result.items[0].fields.find(({ field }) => field === 'contextWindow').state, 'conflict');
});

test('equal numeric system fallback still needs an explicit value to set the request default', () => {
  const source = { kind: 'upstream', origin: 'https://gateway.example', fetchedAt: '2026-11-25T03:00:00.000Z' };
  const result = reconcileMetadata({ provider: 'sample', route: { models: [{ id: 'm' }] }, selectedNewIds: [],
    catalog: { status: 'complete', applicable: true, models: [{ id: 'm', maxTokens: { state: 'known', value: 4096, source } }] },
    effective: { status: 'known', models: [{ id: 'm', fields: {
      contextWindow: { status: 'catalog', value: 64000 }, maxTokens: { status: 'system-fallback', value: 4096,
        evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'system-default' } },
    } }] },
  });
  assert.deepEqual(result.changes, [{ type: 'set-field', scope: 'models', modelId: 'm', index: 0, field: 'maxTokens', value: 4096 }]);
  assert.deepEqual(result.warnings, ['Setting maxTokens changes the DSH per-request default output limit.']);
});

// Exercise the actual immutable upstream normalizer and Host reconciliation seam,
// not a forged catalog: proof is scoped to this endpoint, provider and protocol.
const capacityAbsent = { status: 'absent', evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'absent' } };
function normalizeCapacityRows(rows) {
  return normalizeUpstreamCatalog({ provider: 'sample', protocol: testProtocol, endpoint: testEndpoint,
    source: { kind: 'upstream', origin: 'https://gateway.example', fetchedAt: '2026-11-25T03:00:00.000Z' },
    payload: { data: rows }, responseComplete: true,
  }, [{ provider: 'sample', protocol: testProtocol, endpoint: testEndpoint,
    documentationUrl: 'https://docs.example/models', fields: {
      contextWindow: { name: 'context', meaning: 'total-context-tokens' },
      maxTokens: { name: 'output', meaning: 'max-output-tokens' },
      reasoningEfforts: { name: 'effort', meaning: 'complete-level-wire-map' },
    } }]);
}
function capacityPlan(catalog, models, effectiveModels) {
  return reconcileHostMetadata({ provider: 'sample', endpoint: testEndpoint, protocol: testProtocol,
    route: { models }, catalog, selectedNewIds: [], effective: { status: 'known', models: effectiveModels } });
}

test('an unknown effective context blocks an otherwise writable output without blocking unrelated changes', () => {
  const catalog = normalizeCapacityRows([
    { id: 'existing', output: 8192, effort: { low: 'quick' } }, { id: 'new' },
  ]);
  const route = { models: [{ id: 'existing', custom: { preserve: true } }] };
  const result = reconcileHostMetadata({ provider: 'sample', endpoint: testEndpoint, protocol: testProtocol,
    route, catalog, selectedNewIds: ['new'], effective: { status: 'known', models: [{ id: 'existing', fields: {
      contextWindow: { status: 'unknown' }, maxTokens: capacityAbsent, reasoningEfforts: capacityAbsent,
    } }] },
  });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.changes, [
    { type: 'add-model', modelId: 'new' },
    { type: 'set-field', scope: 'models', modelId: 'existing', index: 0, field: 'reasoningEfforts', value: { low: 'quick' } },
  ]);
  const fields = result.items.find(({ modelId }) => modelId === 'existing').fields;
  assert.deepEqual(fields.filter(({ field }) => ['contextWindow', 'maxTokens'].includes(field))
    .map(({ field, state }) => [field, state]), [['contextWindow', 'unknown'], ['maxTokens', 'unknown']]);
  assert.equal(fields.find(({ field }) => field === 'maxTokens').reason, 'counterpart-capacity-unknown');
  assert.deepEqual(route.models, [{ id: 'existing', custom: { preserve: true } }]);
});

test('an unknown effective output blocks an otherwise writable context without blocking unrelated changes', () => {
  const catalog = normalizeCapacityRows([
    { id: 'existing', context: 4096, effort: { high: 'deep' } }, { id: 'new' },
  ]);
  const route = { models: [{ id: 'existing', custom: { preserve: null } }] };
  const result = reconcileHostMetadata({ provider: 'sample', endpoint: testEndpoint, protocol: testProtocol,
    route, catalog, selectedNewIds: ['new'], effective: { status: 'known', models: [{ id: 'existing', fields: {
      contextWindow: capacityAbsent, maxTokens: { status: 'unknown' }, reasoningEfforts: capacityAbsent,
    } }] },
  });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.changes, [
    { type: 'add-model', modelId: 'new' },
    { type: 'set-field', scope: 'models', modelId: 'existing', index: 0, field: 'reasoningEfforts', value: { high: 'deep' } },
  ]);
  const fields = result.items.find(({ modelId }) => modelId === 'existing').fields;
  assert.deepEqual(fields.filter(({ field }) => ['contextWindow', 'maxTokens'].includes(field))
    .map(({ field, state }) => [field, state]), [['contextWindow', 'unknown'], ['maxTokens', 'unknown']]);
  assert.equal(fields.find(({ field }) => field === 'contextWindow').reason, 'counterpart-capacity-unknown');
  assert.deepEqual(route.models, [{ id: 'existing', custom: { preserve: null } }]);
});

test('only a proven opposite absence is unconstrained; unreadable or malformed evidence stays unknown', async (t) => {
  const invalidFacts = [
    ['missing', undefined],
    ['unknown', { status: 'unknown' }],
    ['absence without evidence', { status: 'absent' }],
    ['partial absence evidence', { status: 'absent', evidence: { explicit: 'absent', catalog: 'absent' } }],
    ['contradictory absence value', { ...capacityAbsent, value: 1024 }],
    ['fallback without proof', { status: 'system-fallback', value: 64000 }],
    ['invalid inherited value', { status: 'catalog', value: null }],
  ];
  for (const [name, fact] of invalidFacts) for (const candidateField of ['contextWindow', 'maxTokens']) {
    await t.test(`${name}; ${candidateField}`, () => {
      const oppositeField = candidateField === 'contextWindow' ? 'maxTokens' : 'contextWindow';
      const row = candidateField === 'contextWindow' ? { id: 'm', context: 4096 } : { id: 'm', output: 8192 };
      const fields = { [candidateField]: capacityAbsent, ...(fact === undefined ? {} : { [oppositeField]: fact }) };
      const result = capacityPlan(normalizeCapacityRows([row]), [{ id: 'm' }], [{ id: 'm', fields }]);
      assert.deepEqual(result.changes, []);
      const candidate = result.items[0].fields.find(({ field }) => field === candidateField);
      assert.equal(candidate.state, 'unknown');
      assert.equal(candidate.reason, 'counterpart-capacity-unknown');
    });
  }
  for (const candidateField of ['contextWindow', 'maxTokens']) await t.test(`contradictory own absence; ${candidateField}`, () => {
    const oppositeField = candidateField === 'contextWindow' ? 'maxTokens' : 'contextWindow';
    const row = candidateField === 'contextWindow' ? { id: 'm', context: 4096 } : { id: 'm', output: 8192 };
    const fields = { [candidateField]: { ...capacityAbsent, value: 1024 }, [oppositeField]: capacityAbsent };
    const result = capacityPlan(normalizeCapacityRows([row]), [{ id: 'm' }], [{ id: 'm', fields }]);
    assert.deepEqual(result.changes, []);
    const candidate = result.items[0].fields.find(({ field }) => field === candidateField);
    assert.equal(candidate.state, 'unknown');
    assert.equal(candidate.reason, 'effective-state-unknown');
  });
  for (const [name, candidateField, model] of [
    ['null explicit context', 'maxTokens', { id: 'm', contextWindow: null }],
    ['false explicit output', 'contextWindow', { id: 'm', maxTokens: false }],
    ['zero explicit context', 'maxTokens', { id: 'm', contextWindow: 0 }],
  ]) await t.test(name, () => {
    const row = candidateField === 'contextWindow' ? { id: 'm', context: 4096 } : { id: 'm', output: 8192 };
    const result = capacityPlan(normalizeCapacityRows([row]), [model], [{ id: 'm', fields: { [candidateField]: capacityAbsent } }]);
    assert.deepEqual(result.changes, []);
    assert.equal(result.items[0].fields.find(({ field }) => field === candidateField).reason, 'counterpart-capacity-unknown');
  });
  const result = capacityPlan(normalizeCapacityRows([
    { id: 'context-only', context: 4096 }, { id: 'output-only', output: 8192 },
  ]), [{ id: 'context-only' }, { id: 'output-only' }], [
    { id: 'context-only', fields: { contextWindow: capacityAbsent, maxTokens: capacityAbsent } },
    { id: 'output-only', fields: { contextWindow: capacityAbsent, maxTokens: capacityAbsent } },
  ]);
  assert.deepEqual(result.changes, [
    { type: 'set-field', scope: 'models', modelId: 'context-only', index: 0, field: 'contextWindow', value: 4096 },
    { type: 'set-field', scope: 'models', modelId: 'output-only', index: 1, field: 'maxTokens', value: 8192 },
  ]);
  assert.deepEqual(result.warnings, ['Setting maxTokens changes the DSH per-request default output limit.']);
});

test('a selected new model is still added without an unsafe unknown-pair capacity', () => {
  const result = reconcileHostMetadata({ provider: 'sample', endpoint: testEndpoint, protocol: testProtocol,
    route: { models: [{ id: 'existing' }] }, catalog: normalizeCapacityRows([{ id: 'new', output: 8192 }]),
    selectedNewIds: ['new'], effective: { status: 'known', models: [{ id: 'new', fields: { maxTokens: capacityAbsent } }] },
  });
  assert.deepEqual(result.changes, [{ type: 'add-model', modelId: 'new' }]);
  assert.equal(result.items[0].fields.find(({ field }) => field === 'maxTokens').state, 'unknown');
  assert.equal(result.items[0].fields.find(({ field }) => field === 'maxTokens').reason, 'counterpart-capacity-unknown');
});

test('a copied catalog cannot use fabricated absence evidence to obtain write authority', () => {
  const catalog = normalizeCapacityRows([{ id: 'm', context: 64000, output: 8192 }]);
  const copiedCatalog = JSON.parse(JSON.stringify(catalog));
  const result = reconcileHostMetadata({ provider: 'sample', endpoint: testEndpoint, protocol: testProtocol,
    route: { models: [{ id: 'm' }] }, catalog: copiedCatalog, selectedNewIds: [],
    effective: { status: 'known', models: [{ id: 'm', fields: { contextWindow: capacityAbsent, maxTokens: capacityAbsent } }] },
  });
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'catalog-binding-mismatch');
  assert.deepEqual(result.changes, []);
});

test('capacity safety rejects a contradictory upstream pair but preserves unrelated fields and models', () => {
  const catalog = normalizeCapacityRows([
    { id: 'bad', context: 4096, output: 8192, effort: { low: 'low' } },
    { id: 'safe', context: 64000, output: 8192 },
  ]);
  const models = [{ id: 'bad', custom: { preserve: true } }, { id: 'safe' }];
  const result = capacityPlan(catalog, models, [
    { id: 'bad', fields: { contextWindow: capacityAbsent, maxTokens: capacityAbsent, reasoningEfforts: capacityAbsent } },
    { id: 'safe', fields: { contextWindow: capacityAbsent, maxTokens: capacityAbsent } },
  ]);
  assert.deepEqual(result.changes, [
    { type: 'set-field', scope: 'models', modelId: 'bad', index: 0, field: 'reasoningEfforts', value: { low: 'low' } },
    { type: 'set-field', scope: 'models', modelId: 'safe', index: 1, field: 'contextWindow', value: 64000 },
    { type: 'set-field', scope: 'models', modelId: 'safe', index: 1, field: 'maxTokens', value: 8192 },
  ]);
  assert.deepEqual(['contextWindow', 'maxTokens'].map((field) => catalog.models[0][field].state), ['conflicting', 'conflicting']);
  assert.deepEqual(result.items[0].fields.filter(({ field }) => ['contextWindow', 'maxTokens'].includes(field))
    .map(({ field, state }) => [field, state]), [['contextWindow', 'conflict'], ['maxTokens', 'conflict']]);
  assert.deepEqual(models[0], { id: 'bad', custom: { preserve: true } });
});

test('capacity safety refuses output above explicit context even if upstream context is larger', () => {
  const catalog = normalizeCapacityRows([{ id: 'm', context: 64000, output: 8192, effort: { low: 'low' } }]);
  const models = [{ id: 'm', contextWindow: 4096, extra: { preserve: false } }];
  const result = capacityPlan(catalog, models, [{ id: 'm', fields: { maxTokens: capacityAbsent, reasoningEfforts: capacityAbsent } }]);
  assert.deepEqual(result.changes, [
    { type: 'set-field', scope: 'models', modelId: 'm', index: 0, field: 'reasoningEfforts', value: { low: 'low' } },
  ]);
  assert.equal(result.items[0].fields.find(({ field }) => field === 'maxTokens').state, 'conflict');
  assert.equal(result.items[0].fields.find(({ field }) => field === 'contextWindow').reason, 'explicit-value');
  assert.deepEqual(models[0], { id: 'm', contextWindow: 4096, extra: { preserve: false } });
});

test('capacity safety refuses context below explicit output even if upstream output is smaller', () => {
  const catalog = normalizeCapacityRows([{ id: 'm', context: 32768, output: 8192, effort: { low: 'low' } }]);
  const models = [{ id: 'm', maxTokens: 65536, extra: { preserve: null } }];
  const result = capacityPlan(catalog, models, [{ id: 'm', fields: { contextWindow: capacityAbsent, reasoningEfforts: capacityAbsent } }]);
  assert.deepEqual(result.changes, [
    { type: 'set-field', scope: 'models', modelId: 'm', index: 0, field: 'reasoningEfforts', value: { low: 'low' } },
  ]);
  assert.equal(result.items[0].fields.find(({ field }) => field === 'contextWindow').state, 'conflict');
  assert.equal(result.items[0].fields.find(({ field }) => field === 'maxTokens').reason, 'explicit-value');
  assert.deepEqual(models[0], { id: 'm', maxTokens: 65536, extra: { preserve: null } });
});

test('protected and demonstrable effective capacities constrain the opposite write in either direction', async (t) => {
  const fallback = (value) => ({ status: 'system-fallback', value,
    evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'system-default' } });
  const cases = [
    { name: 'provider context', route: { models: [{ id: 'm' }], defaultContextWindow: 4096 },
      row: { id: 'm', context: 64000, output: 8192 }, fields: { maxTokens: capacityAbsent }, field: 'maxTokens' },
    { name: 'provider output', route: { models: [{ id: 'm' }], defaultMaxTokens: 65536 },
      row: { id: 'm', context: 32768, output: 8192 }, fields: { contextWindow: capacityAbsent }, field: 'contextWindow' },
    { name: 'catalog context', route: { models: [{ id: 'm' }] },
      row: { id: 'm', context: 64000, output: 8192 }, fields: { contextWindow: { status: 'catalog', value: 4096 }, maxTokens: capacityAbsent }, field: 'maxTokens' },
    { name: 'catalog output', route: { models: [{ id: 'm' }] },
      row: { id: 'm', context: 32768, output: 8192 }, fields: { contextWindow: capacityAbsent, maxTokens: { status: 'catalog', value: 65536 } }, field: 'contextWindow' },
    { name: 'effective provider context', route: { models: [{ id: 'm' }] },
      row: { id: 'm', output: 8192 }, fields: { contextWindow: { status: 'provider-default', value: 4096 }, maxTokens: capacityAbsent }, field: 'maxTokens' },
    { name: 'effective provider output', route: { models: [{ id: 'm' }] },
      row: { id: 'm', context: 32768 }, fields: { contextWindow: capacityAbsent, maxTokens: { status: 'provider-default', value: 65536 } }, field: 'contextWindow' },
    { name: 'fallback context remains without replacement', route: { models: [{ id: 'm' }] },
      row: { id: 'm', output: 8192 }, fields: { contextWindow: fallback(4096), maxTokens: capacityAbsent }, field: 'maxTokens' },
    { name: 'fallback output remains without replacement', route: { models: [{ id: 'm' }] },
      row: { id: 'm', context: 32768 }, fields: { contextWindow: capacityAbsent, maxTokens: fallback(65536) }, field: 'contextWindow' },
    { name: 'model override context on inherited route', route: { models: [], modelOverrides: { m: { contextWindow: 4096 } } },
      row: { id: 'm', context: 64000, output: 8192 }, fields: { maxTokens: capacityAbsent }, field: 'maxTokens', inherited: true },
  ];
  for (const item of cases) await t.test(item.name, () => {
    const result = reconcileHostMetadata({ provider: 'sample', endpoint: testEndpoint, protocol: testProtocol,
      route: item.route, catalog: normalizeCapacityRows([item.row]), selectedNewIds: [],
      effective: { status: 'known', inventoryComplete: item.inherited, models: [{ id: 'm', fields: item.fields }] },
    });
    assert.deepEqual(result.changes, []);
    const field = result.items[0].fields.find((entry) => entry.field === item.field);
    assert.equal(field.state, 'conflict');
    assert.equal(field.reason, 'capacity-conflict');
    assert.deepEqual(field.source, { kind: 'upstream', fetchedAt: '2026-11-25T03:00:00.000Z' });
  });
});

test('the final capacity pair, rather than fallback guesses or field order, controls safe replacement', () => {
  const fallback = (value) => ({ status: 'system-fallback', value,
    evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'system-default' } });
  const result = capacityPlan(normalizeCapacityRows([
    { id: 'both-replaced', context: 64000, output: 8192 },
    { id: 'equal', context: 8192, output: 8192 },
  ]), [{ id: 'both-replaced' }, { id: 'equal' }], [
    { id: 'both-replaced', fields: { contextWindow: fallback(4096), maxTokens: fallback(65536) } },
    { id: 'equal', fields: { contextWindow: capacityAbsent, maxTokens: capacityAbsent } },
  ]);
  assert.deepEqual(result.changes, [
    { type: 'set-field', scope: 'models', modelId: 'both-replaced', index: 0, field: 'contextWindow', value: 64000 },
    { type: 'set-field', scope: 'models', modelId: 'both-replaced', index: 0, field: 'maxTokens', value: 8192 },
    { type: 'set-field', scope: 'models', modelId: 'equal', index: 1, field: 'contextWindow', value: 8192 },
    { type: 'set-field', scope: 'models', modelId: 'equal', index: 1, field: 'maxTokens', value: 8192 },
  ]);
});

test('unknown capacity evidence is never invented or treated as an absent value', () => {
  const catalog = normalizeCapacityRows([{ id: 'm', context: 4096, output: 8192 }]);
  const safeCatalog = normalizeCapacityRows([{ id: 'n', output: 8192 }]);
  const unknown = capacityPlan(safeCatalog, [{ id: 'n' }], [{ id: 'n', fields: { contextWindow: { status: 'unknown' } } }]);
  assert.deepEqual(unknown.changes, []);
  assert.equal(unknown.items[0].fields.find(({ field }) => field === 'contextWindow').state, 'unknown');
  assert.equal(unknown.items[0].fields.find(({ field }) => field === 'maxTokens').state, 'unknown');
  const conflict = capacityPlan(catalog, [{ id: 'm' }], [{ id: 'm', fields: { contextWindow: capacityAbsent, maxTokens: capacityAbsent } }]);
  for (const field of conflict.items[0].fields.filter(({ field }) => ['contextWindow', 'maxTokens'].includes(field))) {
    assert.equal(field.state, 'conflict');
    assert.equal(field.reason, 'candidate-conflict');
    assert.deepEqual(field.source, { kind: 'upstream', fetchedAt: '2026-11-25T03:00:00.000Z' });
  }
});

test('only representable model identities survive normalization and can authorize additions', async (t) => {
  const ids = [
    ['C1 first', 'new\u0080model'], ['C1 last', 'new\u009fmodel'],
    ['lone high surrogate', 'new\ud800model'], ['lone low surrogate', 'new\udfffmodel'],
  ];
  for (const [name, id] of ids) await t.test(name, () => {
    const catalog = normalizeCapacityRows([{ id: 'existing' }, { id }]);
    const base = { provider: 'sample', endpoint: testEndpoint, protocol: testProtocol,
      route: { models: [{ id: 'existing' }] }, catalog, selectedNewIds: [id],
      effective: { status: 'known', models: [] } };
    const result = reconcileHostMetadata(base);
    assert.deepEqual(result.changes, []);
    assert.equal(result.status, 'refused');
    assert.equal(catalog.status, 'failed');
    assert.deepEqual(catalog.models, []);
  });
  const goodId = '新模型-😀';
  const result = reconcileHostMetadata({ provider: 'sample', endpoint: testEndpoint, protocol: testProtocol,
    route: { models: [{ id: 'existing' }] }, catalog: normalizeCapacityRows([{ id: 'existing' }, { id: goodId }]),
    selectedNewIds: [goodId], effective: { status: 'known', models: [] } });
  assert.deepEqual(result.changes, [{ type: 'add-model', modelId: goodId }]);
});

test('the Host also refuses malformed current, selected and effective identities', async (t) => {
  const catalog = normalizeCapacityRows([{ id: 'existing' }, { id: 'new' }]);
  for (const [name, id] of [
    ['C1 first', 'bad\u0080id'], ['C1 last', 'bad\u009fid'],
    ['lone high surrogate', 'bad\ud800id'], ['lone low surrogate', 'bad\udfffid'],
  ]) for (const scope of ['current', 'selected', 'effective']) await t.test(`${name}; ${scope}`, () => {
    const result = reconcileHostMetadata({ provider: 'sample', endpoint: testEndpoint, protocol: testProtocol, catalog,
      route: { models: [{ id: scope === 'current' ? id : 'existing' }] },
      selectedNewIds: scope === 'selected' ? [id] : ['new'],
      effective: { status: 'known', models: scope === 'effective' ? [{ id }] : [] } });
    assert.equal(result.status, 'refused');
    assert.equal(result.reason, scope === 'effective' ? 'invalid-effective-state' : 'invalid-or-duplicate-id');
    assert.deepEqual(result.changes, []);
  });
});

test('the actual upstream-to-Host path blocks unsafe effort maps and writes shared wires', async (t) => {
  const malformedWires = [
    ['empty', ''], ['whitespace only', ' '], ['leading space', ' low'], ['trailing space', 'low '],
    ['leading Unicode whitespace', '\u00a0low'], ['trailing Unicode whitespace', 'low\u00a0'],
    ['C0 control', 'a\u0001b'], ['DEL', 'a\u007fb'], ['C1 first', 'a\u0080b'], ['C1 last', 'a\u009fb'],
    ['lone high surrogate', 'a\ud800b'], ['lone low surrogate', 'a\udfffb'], ['too long', 'x'.repeat(513)],
  ];
  for (const [name, wire] of malformedWires) await t.test(name, () => {
    const catalog = normalizeCapacityRows([{ id: 'm', effort: { low: 'valid', high: wire } }]);
    const result = capacityPlan(catalog, [{ id: 'm' }], [{ id: 'm', fields: { reasoningEfforts: capacityAbsent } }]);
    assert.deepEqual(result.changes, []);
    assert.deepEqual(catalog.models[0].reasoningEfforts, { state: 'unrepresentable', value: null });
    const effort = result.items[0].fields.find(({ field }) => field === 'reasoningEfforts');
    assert.equal(effort.state, 'unknown');
    assert.equal(effort.reason, 'candidate-unknown');
    assert.equal(Object.hasOwn(effort, 'candidate'), false);
  });
  const unrelated = capacityPlan(normalizeCapacityRows([
    { id: 'bad', effort: { low: 'valid', high: 'bad\u0080wire' } },
    { id: 'good', effort: { low: 'quick' } },
  ]), [{ id: 'bad' }, { id: 'good' }], [
    { id: 'bad', fields: { reasoningEfforts: capacityAbsent } },
    { id: 'good', fields: { reasoningEfforts: capacityAbsent } },
  ]);
  assert.deepEqual(unrelated.changes, [
    { type: 'set-field', scope: 'models', modelId: 'good', index: 1, field: 'reasoningEfforts', value: { low: 'quick' } },
  ]);
  for (const [name, value] of [
    ['shared wire', { off: null, low: 'same', high: 'same' }],
    ['maximum length', { low: 'x'.repeat(512) }],
    ['well-formed Unicode', { low: '深 度😀' }],
  ]) await t.test(name, () => {
    const catalog = normalizeCapacityRows([{ id: 'm', effort: value }]);
    const result = capacityPlan(catalog, [{ id: 'm' }], [{ id: 'm', fields: { reasoningEfforts: capacityAbsent } }]);
    assert.deepEqual(result.changes, [{ type: 'set-field', scope: 'models', modelId: 'm', index: 0, field: 'reasoningEfforts', value }]);
    assert.equal(catalog.models[0].reasoningEfforts.state, 'known');
    assert.doesNotMatch(JSON.stringify(result), /gateway\.example|v1\/models/);
  });
});

test('malformed or non-UTC source timestamps cannot authorize new model additions', async (t) => {
  const source = { kind: 'upstream', origin: 'https://gateway.example' };
  const times = ['2026-02-29T03:00:00Z', '2026-04-31T03:00:00.000Z', '2026-11-25T24:00:00Z',
    '2026-11-25 03:00:00Z', '2026-11-25T03:00Z', '2026-11-25T03:00:00.0Z',
    '2026-11-25T03:00:00.0000Z', '2026-11-25T03:00:00+00:00', '2026-11-25T03:00:00',
    '+010000-01-01T00:00:00.000Z', '-000001-01-01T00:00:00.000Z'];
  function catalogAt(fetchedAt) {
    return normalizeUpstreamCatalog({ provider: 'sample', endpoint: testEndpoint, protocol: testProtocol,
      source: { ...source, fetchedAt }, responseComplete: true, payload: { data: [{ id: 'new' }] } });
  }
  function plan(catalog) {
    return reconcileHostMetadata({ provider: 'sample', endpoint: testEndpoint, protocol: testProtocol, catalog,
      route: { models: [{ id: 'existing' }] }, selectedNewIds: ['new'], effective: { status: 'known', models: [] } });
  }
  for (const fetchedAt of times) await t.test(fetchedAt, () => {
    const catalog = catalogAt(fetchedAt);
    const result = plan(catalog);
    assert.deepEqual(result.changes, []);
    assert.equal(result.status, 'refused');
    assert.equal(catalog.status, 'failed');
    assert.deepEqual(catalog.models, []);
  });
  for (const fetchedAt of ['2024-02-29T03:00:00Z', '2024-02-29T03:00:00.123Z']) {
    assert.deepEqual(plan(catalogAt(fetchedAt)).changes, [{ type: 'add-model', modelId: 'new' }]);
  }
});

test('a matching protected value visibly conflicts with the other effective protected value', () => {
  const result = capacityPlan(normalizeCapacityRows([{ id: 'm', context: 4096 }]),
    [{ id: 'm', contextWindow: 4096, maxTokens: 8192 }], []);
  assert.deepEqual(result.changes, []);
  assert.equal(result.items[0].fields.find(({ field }) => field === 'contextWindow').state, 'conflict');
  assert.equal(result.items[0].fields.find(({ field }) => field === 'contextWindow').reason, 'capacity-conflict');
  assert.equal(result.items[0].fields.find(({ field }) => field === 'maxTokens').state, 'unknown');
});
