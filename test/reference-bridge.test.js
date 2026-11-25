import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUpstreamCatalog } from '../lib/metadata-source.js';
import { fetchReferenceWorker } from '../lib/reference-worker.js';
import { createReferenceWorkerControllerForTest, isProductionReferenceSnapshot,
  referenceSnapshotMatchesController } from '../lib/reference-worker-client.js';
import { EventEmitter } from 'node:events';
import * as reference from '../lib/reference-catalog.js';
import { reconcileMetadata, reconcileMetadataForTest } from '../lib/safe-reconcile.js';

// Every hostname, record and proof here is synthetic. No network, real route,
// source documentation, user profile or current Host wiring is asserted.
const provider = 'synthetic-provider';
const modelId = 'synthetic-model';
const endpoint = 'https://synthetic-gateway.example/v1/models';
const protocol = 'openai-completions';
const time = '2026-11-25T03:00:00.000Z';
const upstreamSource = { kind: 'upstream', origin: 'https://synthetic-gateway.example', fetchedAt: time };
const binding = { provider, modelId, endpoint, protocol, applicability: 'exact-endpoint-model-protocol',
  documentationUrl: 'https://synthetic-gateway-docs.example/model' };
const semantics = { source: 'https://models.dev/api.json', documentationUrl: 'https://synthetic-source-docs.example/schema',
  fields: { contextWindow: { name: 'limit.context', meaning: 'total-context-tokens' },
    maxTokens: { name: 'limit.output', meaning: 'max-output-tokens' } } };
const absent = { status: 'absent', evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'absent' } };
const upstreamProof = { provider, endpoint, protocol, documentationUrl: 'https://synthetic-gateway-docs.example/catalog',
  fields: { contextWindow: { name: 'context', meaning: 'total-context-tokens' },
    maxTokens: { name: 'output', meaning: 'max-output-tokens' } } };
const normalize = (rows = [{ id: modelId }]) => normalizeUpstreamCatalog({ provider, endpoint, protocol,
  source: upstreamSource, payload: { data: rows }, responseComplete: true }, [upstreamProof]);
const workerFixture = { [provider]: { id: provider, models: {
  [modelId]: { id: modelId, limit: { context: 64000, output: 8192 } },
} } };
const fixture = async (snapshot = workerFixture) => fetchReferenceWorker({
  transport: async () => new Response(JSON.stringify(snapshot)), clock: () => time,
});
// The fake controller mints a separate, test-only brand after its own IPC and
// exit checks. It is never a production trust domain or a real HTTP authority.
const syntheticController = async (snapshot = workerFixture) => {
  const projected = await fixture(snapshot);
  // createWorker emits only after the controller has installed its listeners.
  // Use a fresh auto-emitting controller for this exact synthetic fixture.
  const emittingController = createReferenceWorkerControllerForTest({ receiptClock: () => time, createWorker() {
    const emitter = new EventEmitter();
    queueMicrotask(() => { emitter.emit('message', JSON.stringify(projected.records)); emitter.emit('exit', 0); });
    return emitter;
  } });
  return emittingController;
};
const makeBridge = async (options = {}) => {
  const controller = await syntheticController();
  return reference.createReferenceBridgeForTest({ controller, clock: () => time, bindings: [binding], semantics: [semantics], ...options });
};
const inputs = (catalog, capability, extra = {}) => ({ provider, endpoint, protocol, catalog,
  route: { models: [{ id: modelId }] }, selectedNewIds: [],
  effective: { status: 'known', models: [{ id: modelId, fields: { contextWindow: absent, maxTokens: absent } }] },
  reference: capability, ...extra });
// This seam explicitly uses the isolated synthetic resolver, never a Host path.
const plan = (catalog, capability, extra = {}) => reconcileMetadataForTest(inputs(catalog, capability, extra));

test('synthetic public normalizer → bounded worker → Host bridge → reconcile fills only proven absences', async () => {
  const catalog = normalize();
  assert.equal(catalog.status, 'complete');
  const snapshot = await fixture();
  assert.equal(snapshot.status, 'complete');
  assert.equal(snapshot.records[0].observedLimitContext, 64000);
  assert.equal(typeof reference.createTrustedReferenceBridge, 'function', 'a private Host bridge must consume the worker');
  const bridge = await makeBridge();
  const capability = await bridge.fetch({ catalog, provider, endpoint, protocol });
  const result = plan(catalog, capability);
  assert.deepEqual(result.changes, [
    { type: 'set-field', scope: 'models', modelId, index: 0, field: 'contextWindow', value: 64000 },
    { type: 'set-field', scope: 'models', modelId, index: 0, field: 'maxTokens', value: 8192 },
  ]);
  assert.deepEqual(result.items[0].fields.filter(field => field.state === 'applicable').map(field => field.source), [
    { kind: 'reference', origin: 'https://models.dev/api.json', fetchedAt: time },
    { kind: 'reference', origin: 'https://models.dev/api.json', fetchedAt: time },
  ]);
  assert.deepEqual(result.warnings, ['Setting maxTokens changes the DSH per-request default output limit.']);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-gateway\.example|synthetic-gateway-docs\.example/);
});

test('an already-aborted Host signal prevents a synthetic reference capability', async () => {
  const catalog = normalize();
  const bridge = await makeBridge();
  const owner = new AbortController();
  owner.abort();
  assert.equal(await bridge.fetch({ catalog, provider, endpoint, protocol }, owner.signal), null);
});

test('cancelling a Host-owned bridge request terminates its worker and rejects late results', async () => {
  const catalog = normalize();
  const owner = new AbortController();
  let worker, workerOptions;
  const controller = createReferenceWorkerControllerForTest({ receiptClock: () => time, createWorker(entry, options) {
    workerOptions = options;
    worker = new EventEmitter();
    worker.terminate = () => { worker.terminated = true; return Promise.resolve(1); };
    return worker;
  } });
  const bridge = reference.createReferenceBridgeForTest({ controller, clock: () => time, bindings: [binding], semantics: [semantics] });
  const pending = bridge.fetch({ catalog, provider, endpoint, protocol }, owner.signal);
  worker.emit('message', JSON.stringify((await fixture()).records));
  owner.abort();
  assert.equal(worker.terminated, true);
  worker.emit('exit', 1);
  assert.equal(await pending, null);
  assert.equal(Object.hasOwn(workerOptions, 'workerData'), false);
  assert.doesNotMatch(JSON.stringify(workerOptions), /synthetic-provider|synthetic-model|synthetic-gateway|openai-completions/);
});

test('the capability cannot be forged, cloned, retargeted or transferred to another catalog', async () => {
  const catalog = normalize();
  const bridge = await makeBridge();
  const capability = await bridge.fetch({ catalog, provider, endpoint, protocol });
  assert.equal(Object.isFrozen(capability), true);
  assert.equal(plan(catalog, capability).changes.length, 2);
  const extracted = reference.selectReferenceFieldsForReconcile({ provider, modelId, endpoint, protocol,
    records: (await fixture()).records, now: time }, [binding]);
  for (const forged of [null, {}, { ...capability }, structuredClone(capability), JSON.parse(JSON.stringify(capability)),
    extracted, extracted.fields, { source: { kind: 'reference', origin: 'https://models.dev/api.json', fetchedAt: time },
      contextWindow: { state: 'known', value: 99999 }, referenceIdentity: { exact: true, unique: true } }]) {
    assert.deepEqual(plan(catalog, forged).changes, []);
  }
  assert.deepEqual(plan(normalize(), capability).changes, []);
  assert.deepEqual(plan(catalog, capability, { endpoint: 'https://other.example/v1/models' }).changes, []);
  assert.deepEqual(plan(catalog, capability, { provider: 'other' }).changes, []);
  assert.deepEqual(plan(catalog, capability, { protocol: 'openai-responses' }).changes, []);
  assert.equal(plan(JSON.parse(JSON.stringify(catalog)), capability).status, 'refused');
});

test('a fake-controller capability cannot influence production reconciliation', async () => {
  const catalog = normalize();
  const bridge = await makeBridge();
  const capability = await bridge.fetch({ catalog, provider, endpoint, protocol });
  assert.ok(capability, 'synthetic controller must actually mint a test capability');
  const result = reconcileMetadata(inputs(catalog, capability));
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.changes, [], 'test brand must not authorize production writes');
  assert.equal(result.items[0].fields.every(field => field.state === 'unknown'), true);
});

test('controller-issued snapshots are immutable and test and production brands are separate', async () => {
  const controller = await syntheticController();
  const snapshot = await controller.fetch();
  const other = await syntheticController();
  assert.equal(referenceSnapshotMatchesController(snapshot, controller), true);
  assert.equal(referenceSnapshotMatchesController(snapshot, other), false);
  assert.equal(isProductionReferenceSnapshot(snapshot), false);
  assert.equal(isProductionReferenceSnapshot(structuredClone(snapshot)), false);
  assert.equal(Object.isFrozen(snapshot.records[0]), true);
  assert.throws(() => { snapshot.records[0].observedLimitContext = 1; }, TypeError);
});

test('production bridge refuses synthetic fetch injection instead of contacting the network', async () => {
  let calls = 0;
  assert.throws(() => reference.createTrustedReferenceBridge({ fetchSnapshot: async () => { calls++; },
    clock: () => time, bindings: [binding], semantics: [semantics] }), TypeError);
  assert.equal(calls, 0);
});

test('an untrusted record cannot establish its own source time or semantic proof', async () => {
  const catalog = normalize();
  const snapshot = await fixture();
  const injected = structuredClone(snapshot);
  injected.records[0].source.fetchedAt = '2026-11-25T03:00:00.000Z';
  // A provider/response may claim an arbitrary fresh date. Only the host's
  // receipt time at completion of the worker is authoritative for age.
  const bridge = reference.createReferenceBridgeForTest({ controller: { fetch: async () => injected },
    clock: () => time, bindings: [binding], semantics: [semantics] });
  const capability = await bridge.fetch({ catalog, provider, endpoint, protocol });
  assert.deepEqual(plan(catalog, capability).changes, []);
});

test('host receipt time, not worker record time, governs reference provenance', async () => {
  const snapshot = await fixture();
  snapshot.records[0].source.fetchedAt = '2099-01-01T00:00:00.000Z';
  const controller = createReferenceWorkerControllerForTest({ receiptClock: () => time, createWorker() {
    const worker = new EventEmitter();
    queueMicrotask(() => { worker.emit('message', JSON.stringify(snapshot.records)); worker.emit('exit', 0); });
    return worker;
  } });
  const bridge = reference.createReferenceBridgeForTest({ controller, clock: () => time, bindings: [binding], semantics: [semantics] });
  const catalog = normalize();
  const capability = await bridge.fetch({ catalog, provider, endpoint, protocol });
  const result = plan(catalog, capability);
  assert.equal(result.changes.length, 2);
  assert.equal(result.items[0].fields[0].source.fetchedAt, time);
});

test('freshness is rechecked by the Host clock when a capability is used', async () => {
  let now = time;
  const catalog = normalize();
  const bridge = await makeBridge({ clock: () => now });
  const capability = await bridge.fetch({ catalog, provider, endpoint, protocol });
  for (const valid of [time, '2026-11-26T03:00:00.000Z']) {
    now = valid;
    assert.equal(plan(catalog, capability).changes.length, 2, valid);
  }
  for (const invalid of ['2026-11-26T03:00:00.001Z', '2026-11-25T02:59:59.999Z', 'bad', null]) {
    now = invalid;
    assert.deepEqual(plan(catalog, capability).changes, [], String(invalid));
  }
});

test('missing identity or independent field semantics cannot establish a value', async () => {
  const catalog = normalize();
  const cases = [
    { bindings: [] }, { bindings: [binding, binding] },
    { bindings: [{ ...binding, provider: 'other' }] }, { bindings: [{ ...binding, endpoint: 'https://other.example/v1/models' }] },
    { bindings: [{ ...binding, protocol: 'openai-responses' }] }, { bindings: [{ ...binding, modelId: 'other' }] },
    { semantics: [] }, { semantics: [semantics, semantics] },
    { semantics: [{ ...semantics, documentationUrl: 'https://u:secret@bad.example/' }] },
    { semantics: [{ ...semantics, fields: { contextWindow: { name: 'limit.context', meaning: 'input-only-tokens' } } }] },
  ];
  for (const options of cases) {
    const bridge = await makeBridge(options);
    const capability = await bridge.fetch({ catalog, provider, endpoint, protocol });
    assert.deepEqual(plan(catalog, capability).changes, [], JSON.stringify(options));
  }
});

test('reference never replaces present-invalid or undocumented upstream fields', async () => {
  const snapshot = await syntheticController();
  const bridge = reference.createReferenceBridgeForTest({ controller: snapshot, clock: () => time,
    bindings: [binding], semantics: [semantics] });
  for (const catalog of [
    normalize([{ id: modelId, context: null, output: 0 }]),
    normalizeUpstreamCatalog({ provider, endpoint, protocol, source: upstreamSource,
      payload: { data: [{ id: modelId }] }, responseComplete: true }),
  ]) {
    const capability = await bridge.fetch({ catalog, provider, endpoint, protocol });
    assert.deepEqual(plan(catalog, capability).changes, []);
  }
});

test('unknown settings and configured, inherited or default metadata remain protected', async () => {
  const catalog = normalize();
  const bridge = await makeBridge();
  const capability = await bridge.fetch({ catalog, provider, endpoint, protocol });
  for (const route of [
    { models: [{ id: modelId, contextWindow: null, maxTokens: false }] },
    { models: [{ id: modelId }], defaultContextWindow: 32000, defaultMaxTokens: 4096 },
  ]) assert.deepEqual(plan(catalog, capability, { route }).changes, []);
  for (const fields of [
    { contextWindow: { status: 'unknown' }, maxTokens: { status: 'unknown' } },
    { contextWindow: { status: 'catalog', value: 32000 }, maxTokens: { status: 'catalog', value: 4096 } },
    { contextWindow: { status: 'system-fallback', value: 32000 }, maxTokens: { status: 'system-fallback', value: 4096 } },
  ]) assert.deepEqual(plan(catalog, capability, { effective: { status: 'known', models: [{ id: modelId, fields }] } }).changes, []);
  const fallback = value => ({ status: 'system-fallback', value,
    evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'system-default' } });
  const result = plan(catalog, capability, { effective: { status: 'known', models: [{ id: modelId,
    fields: { contextWindow: fallback(32000), maxTokens: fallback(4096) } }] } });
  assert.equal(result.changes.length, 2);
});

test('conflicting synthetic source declarations remain visible and cannot be written', async () => {
  const catalog = normalize([{ id: modelId, context: 32000, output: 8192 }]);
  const bridge = await makeBridge();
  const capability = await bridge.fetch({ catalog, provider, endpoint, protocol });
  const result = plan(catalog, capability);
  assert.deepEqual(result.changes, [{ type: 'set-field', scope: 'models', modelId, index: 0, field: 'maxTokens', value: 8192 }]);
  const context = result.items[0].fields.find(field => field.field === 'contextWindow');
  assert.deepEqual(context, { field: 'contextWindow', state: 'conflict', reason: 'source-conflict',
    candidate: 32000, source: { kind: 'upstream', fetchedAt: time },
    referenceCandidate: 64000, referenceSource: { kind: 'reference', origin: 'https://models.dev/api.json', fetchedAt: time } });
});
