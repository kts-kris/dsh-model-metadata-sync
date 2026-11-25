import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredModelsEndpoint, createGenericAdapter } from '../lib/generic-adapter.js';
import { createProviderAdapterRegistry } from '../lib/adapter-registry.js';
import { catalogMatchesTarget } from '../lib/metadata-source.js';
import { reconcileMetadata } from '../lib/safe-reconcile.js';

const SECRET = 'synthetic-secret-never-real';
const ORIGIN = 'https://synthetic-gateway.example';
const ENDPOINT = `${ORIGIN}/v1/models`;
const profile = () => ({
  provider: 'openai', api: 'openai-completions', baseURL: ENDPOINT,
  apiKeyEnv: 'SYNTHETIC_KEY', models: [{ id: 'existing' }],
});
// Synthetic documentation proof for this test only. It asserts nothing about
// real vendors, models, endpoints, or their capabilities.
const syntheticProof = {
  provider: 'openai', endpoint: ENDPOINT, protocol: 'openai-completions',
  documentationUrl: 'https://synthetic-docs.example/models',
  fields: {
    contextWindow: { name: 'context_window', meaning: 'total-context-tokens' },
    maxTokens: { name: 'max_output_tokens', meaning: 'max-output-tokens' },
    reasoningEfforts: { name: 'reasoning_level_map', meaning: 'complete-level-wire-map' },
  },
};
const json = (payload) => new Response(JSON.stringify(payload));
const redirection = (location) => new Response(null, { status: 302, headers: { location } });
const rawModel = { id: 'existing', context_window: 128000, max_output_tokens: 8192,
  reasoning_level_map: { off: null, low: 'low-wire', high: 'high-wire' } };

// Explicitly model a transport that follows redirects by default, as fetch
// does. The test observes all network calls, including a forwarded credential.
function transport(responses) {
  const calls = [];
  async function fetchImpl(url, options = {}) {
    calls.push({ url: String(url), options });
    const response = responses.shift();
    if (!response) throw new Error('unexpected synthetic network call');
    if (response.status === 302 && options.redirect !== 'manual') {
      return fetchImpl(new URL(response.headers.get('location'), url), options);
    }
    return response;
  }
  return { calls, fetchImpl };
}
function factory(fake, registry = [syntheticProof]) {
  return createGenericAdapter({
    resolveCredential: async (ref) => ref === 'SYNTHETIC_KEY' ? SECRET : '',
    fetchImpl: fake.fetchImpl,
    trustedRegistry: registry,
  });
}
function target() { return { provider: 'openai', endpoint: ENDPOINT, protocol: 'openai-completions' }; }

test('models endpoint canonicalization is stable for root, base and explicit paths', () => {
  for (const [baseURL, expected] of [
    ['https://synthetic-gateway.example', `${ORIGIN}/models`],
    ['https://synthetic-gateway.example/', `${ORIGIN}/models`],
    [`${ORIGIN}/v1/`, ENDPOINT], [ENDPOINT, ENDPOINT],
  ]) assert.equal(configuredModelsEndpoint({ baseURL }), expected);
});

// All tests use the actual public adapter entry with fake transport only.
test('configured exact gateway wins over the known provider hardcoded endpoint', async () => {
  const fake = transport([json({ data: [rawModel] })]);
  const registry = createProviderAdapterRegistry({
    resolveCredential: async () => SECRET, fetchImpl: fake.fetchImpl, trustedRegistry: [syntheticProof],
  });
  const catalog = await registry.select(profile()).discover(profile());
  assert.deepEqual(fake.calls.map(({ url }) => url), [ENDPOINT]);
  assert.equal(catalog.status, 'complete');
  assert.equal(catalogMatchesTarget(catalog, target()), true);
});

test('raw synthetic documented values survive as the immutable, target-bound catalog', async () => {
  const fake = transport([json({ data: [rawModel, { id: 'new', max_input_tokens: 9999 }] })]);
  const catalog = await factory(fake).discover(profile());
  assert.equal(catalog.status, 'complete');
  assert.equal(Array.isArray(catalog), false);
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(Object.isFrozen(catalog.models[0].reasoningEfforts.value), true);
  assert.equal(catalogMatchesTarget(catalog, target()), true);
  assert.equal(catalog.models[0].existing, true);
  assert.equal(catalog.models[1].existing, false);
  assert.equal(catalog.models[0].contextWindow.value, 128000);
  assert.equal(catalog.models[0].maxTokens.value, 8192);
  assert.deepEqual(catalog.models[0].reasoningEfforts.value, { off: null, low: 'low-wire', high: 'high-wire' });
  assert.equal(catalog.models[1].contextWindow.state, 'unknown');
  const plan = reconcileMetadata({ ...target(), route: { models: [{ id: 'existing' }] }, catalog,
    selectedNewIds: ['new'], effective: { status: 'known', models: [] } });
  assert.equal(plan.status, 'ready');
  assert.deepEqual(plan.changes.filter(change => change.type === 'add-model'), [{ type: 'add-model', modelId: 'new' }]);
  assert.equal(catalogMatchesTarget(structuredClone(catalog), target()), false);
  assert.equal(catalogMatchesTarget(JSON.parse(JSON.stringify(catalog)), target()), false);
});

test('cross-origin redirect is never followed with the synthetic credential', async () => {
  const fake = transport([redirection('https://attacker.example/collect'), json({ data: [rawModel] })]);
  const catalog = await factory(fake).discover(profile());
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].options.redirect, 'manual');
  assert.equal(new Headers(fake.calls[0].options.headers).get('authorization'), `Bearer ${SECRET}`);
  assert.equal(catalog.applicable, false);
  assert.equal(JSON.stringify(catalog).includes(SECRET), false);
});

test('escaped duplicate keys fail closed before ordinary JSON parsing can discard them', async () => {
  const fake = transport([new Response('{"data":[{"id":"existing","\\u0069d":"other"}]}')]);
  const catalog = await factory(fake).discover(profile());
  assert.equal(catalog.status, 'failed');
  assert.equal(catalog.applicable, false);
  assert.deepEqual(catalog.models, []);
  assert.equal(catalogMatchesTarget(catalog, target()), false);
});

test('incomplete pagination and duplicate model IDs cannot yield a partial catalog', async (t) => {
  for (const [name, response] of [
    ['missing next page', json({ data: [rawModel], has_more: true })],
    ['duplicate IDs', json({ data: [rawModel, { id: 'existing' }] })],
    ['304 cached fallback', new Response(null, { status: 304 })],
  ]) await t.test(name, async () => {
    const fake = transport([response]);
    const catalog = await factory(fake).discover(profile(), { etag: 'synthetic-stale-etag' });
    assert.equal(catalog.status, 'failed');
    assert.equal(catalog.applicable, false);
    assert.deepEqual(catalog.models, []);
    assert.equal(catalogMatchesTarget(catalog, target()), false);
    assert.equal(new Headers(fake.calls[0].options.headers).has('if-none-match'), false);
  });
});

test('unsupported protocols never make a network request or resolve a credential', async () => {
  const fake = transport([]);
  let credentialsResolved = 0;
  const adapter = createGenericAdapter({
    fetchImpl: fake.fetchImpl,
    resolveCredential: async () => { credentialsResolved++; return SECRET; },
  });
  const catalog = await adapter.discover({ ...profile(), api: 'openai-responses' });
  assert.equal(catalog.status, 'failed');
  assert.equal(catalog.applicable, false);
  assert.equal(credentialsResolved, 0);
  assert.equal(fake.calls.length, 0);
});

test('response and per-request options cannot forge trusted documentation proof or source', async () => {
  const malicious = { ...rawModel, provenance: syntheticProof, source: { kind: 'upstream', origin: ORIGIN,
    fetchedAt: '2026-11-25T03:00:00.000Z' } };
  const fake = transport([json({ data: [malicious] })]);
  const catalog = await factory(fake, []).discover(profile(), {
    trustedRegistry: [syntheticProof], source: malicious.source, responseComplete: true,
  });
  assert.equal(catalog.status, 'complete');
  assert.equal(catalog.models[0].contextWindow.state, 'unknown');
  assert.equal(catalog.models[0].maxTokens.state, 'unknown');
  assert.equal(catalog.models[0].reasoningEfforts.state, 'unknown');
});

test('credential resolution cannot race an in-place change of the Host target snapshot', async () => {
  const fake = transport([json({ data: [rawModel] })]);
  let release;
  const pendingCredential = new Promise(resolve => { release = resolve; });
  const adapter = createGenericAdapter({
    fetchImpl: fake.fetchImpl, resolveCredential: () => pendingCredential, trustedRegistry: [syntheticProof],
  });
  const current = profile();
  const pending = adapter.discover(current);
  current.baseURL = 'https://attacker.example/v1/models';
  current.provider = 'attacker';
  current.api = 'openai-responses';
  release(SECRET);
  const catalog = await pending;
  assert.deepEqual(fake.calls.map(({ url }) => url), [ENDPOINT]);
  assert.equal(catalogMatchesTarget(catalog, target()), true);
});

test('unproven pagination cannot reuse exact-endpoint documentation proof', async (t) => {
  // Even a cursor that looks benign has no documented semantics in this proof.
  // A second query parameter can change a gateway's provider/routing entirely.
  for (const next of ['/v1/models?page=2', '/v1/models?cursor=2&provider=other']) {
    await t.test(next, async () => {
      const fake = transport([
        json({ data: [rawModel], has_more: true, next }),
        json({ data: [{ ...rawModel, id: 'unproven-provider-model' }], has_more: false }),
      ]);
      const catalog = await factory(fake).discover(profile());
      assert.equal(catalog.status, 'failed');
      assert.equal(catalog.applicable, false);
      assert.deepEqual(catalog.models, []);
      assert.deepEqual(fake.calls.map(({ url }) => url), [ENDPOINT]);
      assert.equal(catalogMatchesTarget(catalog, target()), false);
      assert.equal(JSON.stringify(catalog).includes(SECRET), false);
    });
  }
});

test('registry selection never activates a legacy injected or declarative network adapter', async () => {
  const fake = transport([json({ data: [rawModel] })]);
  let explicitCalls = 0;
  const legacy = { discover() { explicitCalls++; }, health() { explicitCalls++; } };
  const registry = createProviderAdapterRegistry({
    fetchImpl: fake.fetchImpl, resolveCredential: async () => SECRET, adapters: { legacy },
  });
  const selected = registry.select({ ...profile(), adapterId: 'legacy' }, {
    endpoint: 'https://attacker.example/models', enabled: true,
  });
  assert.equal((await selected.discover(profile())).status, 'complete');
  assert.deepEqual(fake.calls.map(({ url }) => url), [ENDPOINT]);
  assert.equal(explicitCalls, 0);
  assert.throws(() => registry.register('legacy', legacy), { code: 'UNSUPPORTED_OPERATION' });
  await assert.rejects(selected.health(profile()), { code: 'UNSUPPORTED_OPERATION' });
  assert.equal(fake.calls.length, 1);
});

test('documentation proof is snapshotted before caller mutation', async () => {
  const fake = transport([json({ data: [rawModel] })]);
  const mutableProof = structuredClone(syntheticProof);
  const adapter = factory(fake, [mutableProof]);
  mutableProof.fields.contextWindow.meaning = 'input-only-tokens';
  assert.equal((await adapter.discover(profile())).models[0].contextWindow.value, 128000);
});

test('exact-endpoint proof cannot authorize redirected or different-path catalogs', async (t) => {
  for (const [name, first] of [
    ['same-origin redirect to another path', redirection('/v2/models')],
    ['same-path redirect', redirection('/v1/models?page=2')],
    ['pagination to another path', json({ data: [rawModel], has_more: true, next: '/v2/models' })],
  ]) await t.test(name, async () => {
    const fake = transport([first, json({ data: [{ ...rawModel, id: 'late-model' }] })]);
    const catalog = await factory(fake).discover(profile());
    assert.equal(catalog.status, 'failed');
    assert.equal(catalog.applicable, false);
    assert.deepEqual(catalog.models, []);
    assert.equal(catalogMatchesTarget(catalog, target()), false);
    assert.equal(fake.calls.length, 1);
    assert.equal(JSON.stringify(catalog).includes(SECRET), false);
  });
});

test('unproven protocol, custom headers and unresolved credential refs fail before transport', async (t) => {
  for (const [name, overrides] of [
    ['missing protocol', { api: undefined }],
    ['custom secret header', { headers: { 'x-custom-key': SECRET } }],
    ['unresolved credential', { apiKeyEnv: 'MISSING_KEY' }],
  ]) await t.test(name, async () => {
    const fake = transport([json({ data: [{ ...rawModel, id: SECRET }] })]);
    const catalog = await factory(fake).discover({ ...profile(), ...overrides });
    assert.equal(catalog.status, 'failed');
    assert.equal(catalog.applicable, false);
    assert.deepEqual(catalog.models, []);
    assert.equal(fake.calls.length, 0);
    assert.equal(JSON.stringify(catalog).includes(SECRET), false);
  });
});

test('disguised custom header containers cannot leak synthetic secrets into a catalog', async (t) => {
  const headerSecret = 'synthetic-independent-header-secret';
  const disguisedArray = [];
  Object.setPrototypeOf(disguisedArray, { 'x-token': headerSecret });
  const disguisedHeaders = new Headers({ 'x-token': headerSecret });
  disguisedHeaders.entries = () => ({ next: () => ({ done: true }) });
  const prototypeResetHeaders = Object.setPrototypeOf(new Headers({ 'x-token': headerSecret }), Object.prototype);
  const frozenResetHeaders = Object.freeze(Object.setPrototypeOf(new Headers({ 'x-token': headerSecret }), Object.prototype));
  for (const [name, headers] of [
    ['empty array with inherited secret', disguisedArray],
    ['Headers with lying entries', disguisedHeaders],
    ['Headers reset to plain-object prototype', prototypeResetHeaders],
    ['frozen Headers reset to plain-object prototype', frozenResetHeaders],
  ]) await t.test(name, async () => {
    // This secret is distinct from the resolved API key. If the unsupported
    // container is accepted, the transport echo becomes a trusted model ID.
    const fake = transport([json({ data: [{ id: headerSecret }] })]);
    let credentialCalls = 0;
    const adapter = createGenericAdapter({
      fetchImpl: fake.fetchImpl, trustedRegistry: [syntheticProof],
      resolveCredential: async () => { credentialCalls++; return SECRET; },
    });
    const catalog = await adapter.discover({ ...profile(), headers });
    assert.equal(JSON.stringify(catalog).includes(headerSecret), false);
    assert.equal(catalog.status, 'failed');
    assert.equal(catalog.applicable, false);
    assert.deepEqual(catalog.models, []);
    assert.equal(catalogMatchesTarget(catalog, target()), false);
    assert.equal(credentialCalls, 0);
    assert.equal(fake.calls.length, 0);
  });
});

test('non-plain, hidden, and proxy header containers cannot pass as empty', async (t) => {
  const headerSecret = 'synthetic-independent-header-secret';
  const inherited = Object.create({ 'x-token': headerSecret });
  const symbol = Object.assign({}, { [Symbol('x-token')]: headerSecret });
  const nonenumerable = Object.defineProperty({}, 'x-token', { value: headerSecret });
  const disguisedMap = Object.setPrototypeOf(new Map([['x-token', headerSecret]]), Object.prototype);
  const disguisedSet = Object.setPrototypeOf(new Set([headerSecret]), Object.prototype);
  const disguisedBuffer = Object.setPrototypeOf(new Uint8Array(), Object.prototype);
  const disguisedUrl = Object.setPrototypeOf(new URL('https://synthetic.example'), Object.prototype);
  const disguisedParams = Object.setPrototypeOf(new URLSearchParams('x-token=synthetic-independent-header-secret'), Object.prototype);
  const hiddenByProxy = new Proxy({ 'x-token': headerSecret }, {
    ownKeys: () => [],
    getPrototypeOf: () => Object.prototype,
  });
  const pretendPlainArray = new Proxy([], { getPrototypeOf: () => Object.prototype });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const cases = [
    ['inherited secret', inherited],
    ['symbol property', symbol],
    ['non-enumerable property', nonenumerable],
    ['Map', new Map([['x-token', headerSecret]])],
    ['Map with plain-object prototype', disguisedMap],
    ['Set with plain-object prototype', disguisedSet],
    ['typed array with plain-object prototype', disguisedBuffer],
    ['URL with plain-object prototype', disguisedUrl],
    ['URLSearchParams with plain-object prototype', disguisedParams],
    ['empty proxy', new Proxy({}, {})],
    ['proxy hiding secret', hiddenByProxy],
    ['proxy disguising array', pretendPlainArray],
    ['throwing getPrototypeOf trap', new Proxy({}, { getPrototypeOf() { throw new Error(headerSecret); } })],
    ['throwing ownKeys trap', new Proxy({}, { ownKeys() { throw new Error(headerSecret); } })],
    ['invariant-violating ownKeys trap', new Proxy(Object.preventExtensions({ 'x-token': headerSecret }), { ownKeys: () => [] })],
    ['revoked proxy', revoked.proxy],
  ];
  for (const [name, headers] of cases) await t.test(name, async () => {
    const fake = transport([json({ data: [{ id: headerSecret }] })]);
    let credentialCalls = 0;
    const adapter = createGenericAdapter({
      fetchImpl: fake.fetchImpl, trustedRegistry: [syntheticProof],
      resolveCredential: async () => { credentialCalls++; return SECRET; },
    });
    const catalog = await adapter.discover({ ...profile(), headers });
    assert.equal(catalog.status, 'failed');
    assert.equal(catalog.applicable, false);
    assert.deepEqual(catalog.models, []);
    assert.equal(catalogMatchesTarget(catalog, target()), false);
    assert.equal(credentialCalls, 0);
    assert.equal(fake.calls.length, 0);
    assert.equal(JSON.stringify(catalog).includes(headerSecret), false);
    assert.equal(JSON.stringify(catalog).includes(SECRET), false);
  });
});

test('headers and credential references require unambiguous explicit support', async (t) => {
  const cases = [
    ['plain header', { headers: { 'x-token': SECRET } }],
    ['Headers object', { headers: new Headers({ 'x-token': SECRET }) }],
    ['empty Headers object', { headers: new Headers() }],
    ['empty array', { headers: [] }],
    ['header pairs', { headers: [['x-token', SECRET]] }],
    ['malformed headers', { headers: 'opaque' }],
    ['multiple credential refs', { credentialRef: 'OTHER_KEY' }],
    ['invalid credential ref', { apiKeyEnv: 0 }],
    ['empty resolver value', { apiKeyEnv: 'MISSING_KEY' }],
  ];
  for (const [name, overrides] of cases) await t.test(name, async () => {
    const fake = transport([json({ data: [{ id: SECRET }] })]);
    const catalog = await factory(fake).discover({ ...profile(), ...overrides });
    assert.equal(catalog.status, 'failed');
    assert.equal(fake.calls.length, 0);
    assert.equal(JSON.stringify(catalog).includes(SECRET), false);
  });
  for (const [name, headers] of [
    ['undefined', undefined], ['null', null], ['empty plain object', {}], ['empty null-prototype object', Object.create(null)],
  ]) await t.test(`${name} headers with genuinely anonymous route`, async () => {
    const fake = transport([json({ data: [rawModel] })]);
    let resolved = false;
    const adapter = createGenericAdapter({
      fetchImpl: fake.fetchImpl,
      resolveCredential: async () => { resolved = true; return SECRET; },
      trustedRegistry: [syntheticProof],
    });
    const anonymous = { ...profile(), apiKeyEnv: '', headers };
    const catalog = await adapter.discover(anonymous);
    assert.equal(catalog.status, 'complete');
    assert.equal(catalogMatchesTarget(catalog, target()), true);
    assert.equal(fake.calls.length, 1);
    assert.equal(new Headers(fake.calls[0].options.headers).has('authorization'), false);
    assert.equal(resolved, false);
  });
});

test('absent protocol is unsupported even with a matching documentation proof', async () => {
  const fake = transport([json({ data: [rawModel] })]);
  const adapter = factory(fake);
  const missing = { ...profile(), api: undefined };
  assert.equal(adapter.canHandle(missing), false);
  const catalog = await adapter.discover(missing);
  assert.equal(catalog.status, 'failed');
  assert.equal(catalog.error.code, 'UNSUPPORTED_PROTOCOL');
  assert.equal(fake.calls.length, 0);
  assert.equal(catalogMatchesTarget(catalog, target()), false);
});

test('unproven first pagination link stops the chain before any later page', async () => {
  const fake = transport([
    json({ data: [rawModel], has_more: true, next: '/v1/models?cursor=2' }),
    json({ data: [{ id: 'new' }], has_more: true, next: '/v2/models?cursor=3' }),
    json({ data: [{ id: 'unreachable' }] }),
  ]);
  const catalog = await factory(fake).discover(profile());
  assert.equal(catalog.status, 'failed');
  assert.equal(catalog.applicable, false);
  assert.deepEqual(catalog.models, []);
  assert.equal(catalogMatchesTarget(catalog, target()), false);
  assert.deepEqual(fake.calls.map(({ url }) => url), [ENDPOINT]);
  assert.equal(JSON.stringify(catalog).includes(SECRET), false);
});

test('redirect rejection stays sticky even if a later transport response would be successful', async () => {
  const fake = transport([
    redirection('/v2/models'), json({ data: [rawModel] }), json({ data: [rawModel] }),
  ]);
  const catalog = await factory(fake).discover(profile());
  assert.equal(catalog.status, 'failed');
  assert.equal(catalog.error.code, 'ORIGIN_REFUSED');
  assert.equal(fake.calls.length, 1);
  assert.equal(catalogMatchesTarget(catalog, target()), false);
});

test('already cancelled discovery makes no credential or transport call', async () => {
  const controller = new AbortController();
  controller.abort();
  let credentialCalls = 0;
  const fake = transport([json({ data: [rawModel] })]);
  const adapter = createGenericAdapter({
    resolveCredential: async () => { credentialCalls++; return SECRET; },
    fetchImpl: fake.fetchImpl, trustedRegistry: [syntheticProof],
  });
  const catalog = await adapter.discover(profile(), { signal: controller.signal });
  assert.equal(catalog.status, 'failed');
  assert.equal(catalog.applicable, false);
  assert.deepEqual(catalog.models, []);
  assert.equal(credentialCalls, 0);
  assert.equal(fake.calls.length, 0);
});

test('cancellation during credential resolution cannot start a late request', async () => {
  const controller = new AbortController();
  let release, started;
  const resolving = new Promise(resolve => { started = resolve; });
  const credential = new Promise(resolve => { release = resolve; });
  const fake = transport([json({ data: [rawModel] })]);
  const adapter = createGenericAdapter({
    resolveCredential: () => { started(); return credential; },
    fetchImpl: fake.fetchImpl, trustedRegistry: [syntheticProof],
  });
  const pending = adapter.discover(profile(), { signal: controller.signal });
  await resolving;
  controller.abort();
  const catalog = await pending;
  assert.equal(catalog.status, 'failed');
  assert.equal(catalog.applicable, false);
  assert.equal(fake.calls.length, 0);
  release(SECRET);
  // Let the resolver continuation run; it must not start transport afterward.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fake.calls.length, 0);
});

test('cancellation during transport prevents a late response or pagination from becoming evidence', async () => {
  const controller = new AbortController();
  let release, started, bodyCancelled, requestSignal;
  const requestStarted = new Promise(resolve => { started = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  const bodyCancelObserved = new Promise(resolve => { bodyCancelled = resolve; });
  let calls = 0;
  const adapter = createGenericAdapter({
    resolveCredential: async () => SECRET, trustedRegistry: [syntheticProof],
    fetchImpl: async (_url, options) => { calls++; requestSignal = options.signal; started(); return response; },
  });
  const pending = adapter.discover(profile(), { signal: controller.signal });
  await requestStarted;
  controller.abort();
  // The transport ignores abort and never settles until explicitly released.
  // Discovery must return before release, not wait for a 15-second deadline.
  const catalog = await pending;
  assert.equal(catalog.status, 'failed');
  assert.equal(catalog.applicable, false);
  assert.deepEqual(catalog.models, []);
  assert.equal(requestSignal.aborted, true);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(catalog).includes(SECRET), false);
  const stream = new ReadableStream({ cancel() { bodyCancelled(); } });
  release(new Response(stream));
  await bodyCancelObserved;
  assert.equal(calls, 1);
});

test('cancellation while reading a page cancels the body and forbids its next page', async () => {
  const controller = new AbortController();
  let streamController, bodyReading, cancelled = false;
  const reading = new Promise(resolve => { bodyReading = resolve; });
  const body = new ReadableStream({
    start(value) { streamController = value; },
    pull() { bodyReading(); },
    cancel() { cancelled = true; },
  });
  const fake = transport([new Response(body), json({ data: [{ id: 'should-not-be-fetched' }] })]);
  const pending = factory(fake).discover(profile(), { signal: controller.signal });
  await reading;
  controller.abort();
  if (!cancelled) {
    streamController.enqueue(new TextEncoder().encode(JSON.stringify({ data: [rawModel], has_more: true, next: '?page=2' })));
    streamController.close();
  }
  const catalog = await pending;
  assert.equal(catalog.status, 'failed');
  assert.equal(catalog.applicable, false);
  assert.equal(fake.calls.length, 1);
  assert.equal(cancelled, true);
});
