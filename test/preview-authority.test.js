import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPreviewAuthority } from '../lib/preview-authority.js';
import { normalizeUpstreamCatalog } from '../lib/metadata-source.js';

const endpoint = 'https://gateway.example/v1/models';
const protocol = 'openai-completions';
const now = Date.parse('2026-11-25T03:00:00.000Z');
const absent = () => ({ status: 'absent', evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'absent' } });
const fieldsAbsent = () => ({ contextWindow: absent(), maxTokens: absent(), reasoningEfforts: absent() });
const docs = [{ provider: 'sample', endpoint, protocol, documentationUrl: 'https://docs.example/models', fields: {
  contextWindow: { name: 'context', meaning: 'total-context-tokens' },
  maxTokens: { name: 'output', meaning: 'max-output-tokens' },
  reasoningEfforts: { name: 'effort', meaning: 'complete-level-wire-map' },
} }];

function fixture(options = {}) {
  let time = now;
  let revision = 17;
  let secretGeneration = 3;
  let counter = 0;
  const calls = [];
  // Synthetic only: the trusted Host must protect both the actual bearer and
  // independent configured credentials, not just values sent over the wire.
  const secrets = ['sk-synthetic-bearer', 'sk-synthetic-independent'];
  const protection = () => ({ revision, secretGeneration, complete: true,
    checkText: text => !secrets.some(secret => text.includes(secret)) });
  const sourceEndpoint = options.endpoint ?? endpoint;
  const route = { provider: 'sample', api: protocol, baseURL: options.baseURL ?? 'https://gateway.example/v1',
    credentialRef: 'credential-reference-secret', headers: { Authorization: 'top-secret-header' },
    models: [{ id: 'old', contextWindow: 65536, opaque: { password: 'nested-model-secret' } }] };
  const effective = { status: 'known', models: [
    { id: 'old', fields: { ...fieldsAbsent(), contextWindow: { status: 'catalog', value: 65536 } }, private: 'effective-secret' },
    { id: 'new-first', fields: fieldsAbsent() }, { id: 'new-last', fields: fieldsAbsent() },
  ] };
  const rows = options.rows ?? [
    { id: 'new-first', context: 131072, output: 8192, effort: { off: null, low: 'quick', medium: 'normal', high: 'deep', xhigh: 'deepest' } },
    { id: 'old', context: 32768 },
    { id: 'new-last', effort: { low: 'low', extra: 'unrepresentable' } },
  ];
  const snapshot = () => ({ revision, secretGeneration,
    route: { revision, value: route }, effective: { revision, value: effective },
    protection: options.protection === undefined ? protection() : options.protection,
    referenceEnabled: options.referenceEnabled ?? true });
  const authority = createPreviewAuthority({
    readSnapshot: options.readSnapshot ?? (async (provider) => { calls.push(['snapshot', provider]); return snapshot(); }),
    readRevision: options.readRevision ?? (async () => revision),
    readProtectionState: Object.hasOwn(options, 'readProtectionState')
      ? options.readProtectionState : (async () => ({ revision, secretGeneration })),
    fetchCatalog: options.fetchCatalog ?? (async ({ route: actualRoute, revision: actualRevision }) => {
      calls.push(['fetch', actualRoute, actualRevision]);
      return normalizeUpstreamCatalog({ provider: actualRoute.provider, protocol: actualRoute.api, endpoint: sourceEndpoint,
        source: { kind: 'upstream', origin: new URL(sourceEndpoint).origin, fetchedAt: '2026-11-25T03:00:00.000Z' },
        payload: { data: rows }, responseComplete: true }, docs.map(doc => ({ ...doc, endpoint: sourceEndpoint })));
    }),
    clock: () => time,
    randomBytes: options.randomBytes ?? ((size) => Buffer.alloc(size, ++counter)),
  });
  return { authority, calls, route, effective, setTime: value => { time = value; },
    setRevision: value => { revision = value; }, setSecretGeneration: value => { secretGeneration = value; } };
}

function field(result, modelId, name) {
  return result.items.find(item => item.modelId === modelId).fields.find(entry => entry.field === name);
}

test('host-owned same-revision preview shows exact ordered diff, provenance, unknowns and maxTokens warning without writes', async () => {
  const f = fixture();
  const result = await f.authority.preview({ provider: 'sample', selectedNewIds: ['new-last', 'new-first'] });
  assert.equal(result.provider, 'sample');
  assert.equal(result.revision, 17);
  assert.equal(result.expiresAt, '2026-11-25T03:05:00.000Z');
  assert.match(result.previewId, /^[A-Za-z0-9_-]{40,}$/);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.selectedNewIds, ['new-first', 'new-last']);
  assert.deepEqual(result.items.map(({ modelId, existing }) => [modelId, existing]), [
    ['new-first', false], ['old', true], ['new-last', false],
  ]);
  assert.deepEqual(field(result, 'new-first', 'reasoningEfforts').candidate,
    { off: null, low: 'quick', medium: 'normal', high: 'deep', xhigh: 'deepest' });
  assert.equal(field(result, 'new-first', 'reasoningEfforts').state, 'applicable');
  assert.deepEqual(field(result, 'new-first', 'reasoningEfforts').source, { kind: 'upstream', fetchedAt: '2026-11-25T03:00:00.000Z' });
  assert.deepEqual([field(result, 'old', 'contextWindow').before, field(result, 'old', 'contextWindow').candidate,
    field(result, 'old', 'contextWindow').state], [65536, 32768, 'conflict']);
  assert.equal(field(result, 'new-last', 'reasoningEfforts').state, 'unknown');
  assert.equal(result.changes.some(change => change.field === 'reasoningEfforts' && change.modelId === 'new-last'), false);
  assert.ok(result.warnings.some(warning => /maxTokens.*request.*default/i.test(warning)));
  assert.deepEqual(result.sources.upstream, { kind: 'upstream', status: 'success', lastAttemptAt: '2026-11-25T03:00:00.000Z' });
  assert.equal(result.sources.reference.status, 'unknown');
  assert.equal(result.sources.reference.reason, 'reference-bridge-unavailable');
  assert.deepEqual(result.sources.reference.lookupIdentifiers, ['provider', 'modelId', 'protocol']);
  assert.deepEqual(f.calls.map(call => call[0]), ['snapshot', 'fetch']);
  assert.strictEqual(f.calls[1][1], f.route);
  assert.equal(f.calls[1][2], 17);
  assert.deepEqual(f.route.models[0], { id: 'old', contextWindow: 65536, opaque: { password: 'nested-model-secret' } });
});

test('preview output and retained record never contain raw descriptor, endpoint, secret or arbitrary model fields', async () => {
  const f = fixture();
  const result = await f.authority.preview({ provider: 'sample', selectedNewIds: ['new-first'] });
  const stored = await f.authority.getPreview(result.previewId);
  for (const value of [result, stored]) {
    const text = JSON.stringify(value);
    for (const forbidden of ['top-secret-header', 'credential-reference-secret', 'nested-model-secret',
      'effective-secret', 'gateway.example', 'Authorization', 'headers', 'credentialRef', 'opaque', 'baseURL']) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
  }
  result.items[0].fields[0].candidate = 1;
  assert.notEqual((await f.authority.getPreview(result.previewId)).items[0].fields[0].candidate, 1);
});

test('rejects reflected endpoints and synthetic credentials rather than returning or caching altered diffs', async () => {
  const attacks = [
    { id: endpoint },
    { id: 'https://gateway.example' },
    { id: '/v1/models' },
    { id: 'sk-synthetic-bearer' },
    { id: 'sk-synthetic-independent' },
    { id: 'new-first', effort: { low: 'sk-synthetic-independent' } },
  ];
  for (const row of attacks) {
    const f = fixture({ rows: [row] });
    const result = await f.authority.preview({ provider: 'sample', selectedNewIds: [row.id] });
    assert.deepEqual(result, { error: { code: 'INVALID_RESPONSE', message: 'Invalid preview request or model catalog.' } });
    for (const secret of [row.id, endpoint, 'sk-synthetic-bearer', 'sk-synthetic-independent']) {
      if (secret !== 'new-first') assert.equal(JSON.stringify(result).includes(secret), false);
    }
    assert.equal('previewId' in result, false);
    assert.equal('changes' in result, false);
    assert.equal(await f.authority.getPreview(result.previewId), null);
  }
});

test('rejects equivalent private hostname, encoded paths and individual private path segments', async () => {
  const baseURL = 'https://Internal-Relay.Example/private-tenant/route-key';
  const endpoint = 'https://internal-relay.example/private-tenant/route-key/models';
  const normal = fixture({ baseURL, endpoint, rows: [{ id: 'ordinary-model' }] });
  const accepted = await normal.authority.preview({ provider: 'sample', selectedNewIds: ['ordinary-model'] });
  assert.equal(accepted.items[0].modelId, 'ordinary-model');
  assert.deepEqual(accepted.changes, [{ type: 'add-model', modelId: 'ordinary-model' }]);
  const attacks = [
    { id: 'model-Internal-Relay.Example' },
    { id: 'model-INTERNAL-RELAY.EXAMPLE' },
    { id: 'model-/private%2Dtenant/route-key' },
    { id: 'model-%252Fprivate-tenant%252Froute-key' },
    { id: 'model-private-tenant' },
    { id: 'ordinary-model', effort: { low: 'route-key' } },
    { id: 'ordinary-model', effort: { low: '%2572oute-key' } },
  ];
  for (const row of attacks) {
    const f = fixture({ baseURL, endpoint, rows: [row] });
    const result = await f.authority.preview({ provider: 'sample', selectedNewIds: [row.id] });
    assert.deepEqual(result, { error: { code: 'INVALID_RESPONSE', message: 'Invalid preview request or model catalog.' } }, JSON.stringify(row));
    assert.equal('previewId' in result, false);
    assert.equal('changes' in result, false);
    assert.equal(await f.authority.getPreview(result.previewId), null);
  }
  // Fixed output keys are checked too: a private segment can collide with one.
  const keyCollision = fixture({ baseURL: 'https://private-relay.example/private-scope/low',
    endpoint: 'https://private-relay.example/private-scope/low/models', rows: [{ id: 'ordinary-model', effort: { low: 'quick' } }] });
  assert.equal((await keyCollision.authority.preview({ provider: 'sample', selectedNewIds: [] })).error?.code, 'INVALID_RESPONSE');
});

test('independent credential rotation during discovery or while cached invalidates the preview', async () => {
  let unblock, started;
  const pending = new Promise(resolve => { unblock = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture({ fetchCatalog: async ({ route }) => {
    started();
    await pending;
    return normalizeUpstreamCatalog({ provider: route.provider, protocol, endpoint,
      source: { kind: 'upstream', origin: 'https://gateway.example', fetchedAt: '2026-11-25T03:00:00.000Z' },
      payload: { data: [{ id: 'old' }] }, responseComplete: true }, []);
  } });
  const pendingPreview = f.authority.preview({ provider: 'sample', selectedNewIds: [] });
  await ready;
  f.setSecretGeneration(4);
  unblock();
  assert.equal((await pendingPreview).error.code, 'REVISION_CONFLICT');
  const g = fixture();
  const preview = await g.authority.preview({ provider: 'sample', selectedNewIds: ['new-first'] });
  assert.ok(await g.authority.getPreview(preview.previewId));
  g.setSecretGeneration(4);
  assert.equal(await g.authority.getPreview(preview.previewId), null);
});

test('final revision read cannot hide credential rotation during that read', async () => {
  let f;
  let reads = 0;
  f = fixture({ readRevision: async () => {
    if (++reads === 2) f.setSecretGeneration(4);
    return 17;
  } });
  const result = await f.authority.preview({ provider: 'sample', selectedNewIds: ['new-first'] });
  assert.equal(result.error?.code, 'REVISION_CONFLICT');
  assert.equal('previewId' in result, false);
});

test('a later-generated output secret is rejected before returning or retaining a token', async () => {
  // The generated opaque token (and not the planned metadata) is deliberately
  // synthetic secret material. The rejected preview must not enter the cache.
  let calls = 0;
  const f = fixture({ randomBytes: size => Buffer.alloc(size, ++calls),
    protection: { revision: 17, secretGeneration: 3, complete: true,
      checkText: text => !text.includes('AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI') } });
  const result = await f.authority.preview({ provider: 'sample', selectedNewIds: [] });
  assert.equal(result.error?.code, 'INVALID_RESPONSE');
  assert.equal(await f.authority.getPreview('AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI'), null);
});

test('Host checker examines the exact preview keys and values, including generated values', async () => {
  for (const forbidden of ['provider', 'low', 'quick', 'changes', 'selectedNewIds', 'previewId', 'digest']) {
    const seen = [];
    const checkText = text => { seen.push(text); return text !== forbidden; };
    const f = fixture({ protection: { revision: 17, secretGeneration: 3, complete: true, checkText } });
    const result = await f.authority.preview({ provider: 'sample', selectedNewIds: ['new-first'] });
    assert.ok(seen.includes(forbidden), `checker did not inspect ${forbidden}`);
    assert.ok(result.error);
    assert.equal('previewId' in result, false);
  }
  const seen = new Set();
  const f = fixture({ protection: { revision: 17, secretGeneration: 3, complete: true,
    checkText: text => { seen.add(text); return true; } } });
  const result = await f.authority.preview({ provider: 'sample', selectedNewIds: ['new-first'] });
  const pending = [result];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') assert.ok(seen.has(value), 'unchecked response string');
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) pending.push(key, child);
  }
});

test('synthetic numeric secrets cannot escape through a normalized preview or its cache', async t => {
  // The baseline establishes that each value really reaches the indicated public
  // response location through the real normalizer and reconciliation path. A new
  // Host instance then protects that same synthetic number at the same revision
  // and secret generation, without changing the metadata before planning it.
  const cases = [
    { name: 'candidate and change value', secret: '131072', rows: [{ id: 'new-first', context: 131072, output: 8192 }],
      selected: ['new-first'], inspect(result) {
        assert.equal(field(result, 'new-first', 'contextWindow').candidate, 131072);
        assert.equal(result.changes.find(change => change.field === 'contextWindow').value, 131072);
      } },
    { name: 'configured before', secret: '131072', rows: [{ id: 'old', context: 32768 }], selected: [],
      setup(f) { f.route.models[0].contextWindow = 131072; },
      inspect(result) { assert.equal(field(result, 'old', 'contextWindow').before, 131072); } },
    { name: 'maxTokens candidate and change value', secret: '131072',
      rows: [{ id: 'new-first', context: 262144, output: 131072 }], selected: ['new-first'],
      inspect(result) {
        assert.equal(field(result, 'new-first', 'maxTokens').candidate, 131072);
        assert.equal(result.changes.find(change => change.field === 'maxTokens').value, 131072);
      } },
    { name: 'revision', secret: '131072', revision: 131072, rows: [{ id: 'old' }], selected: [],
      inspect(result) { assert.equal(result.revision, 131072); } },
    { name: 'index', secret: '42', rows: [{ id: 'old', output: 8192 }], selected: [],
      setup(f) {
        f.route.models.unshift(...Array.from({ length: 42 }, (_, i) => ({ id: `preceding-model-${i}` })));
      },
      inspect(result) { assert.equal(result.changes.find(change => change.field === 'maxTokens').index, 42); } },
    { name: 'zero index', secret: '0', rows: [{ id: 'old', output: 8192 }], selected: [],
      inspect(result) { assert.equal(result.changes.find(change => change.field === 'maxTokens').index, 0); } },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    function host(checkText) {
      const revision = scenario.revision ?? 17;
      const f = fixture({ rows: scenario.rows, protection: { revision, secretGeneration: 3, complete: true, checkText } });
      f.setRevision(revision);
      scenario.setup?.(f);
      return f;
    }
    const request = { provider: 'sample', selectedNewIds: scenario.selected };
    const baseline = await host(() => true).authority.preview(request);
    scenario.inspect(baseline);

    const guarded = host(text => !text.includes(scenario.secret));
    const result = await guarded.authority.preview(request);
    assert.equal(result.error?.code, 'INVALID_RESPONSE');
    assert.equal(JSON.stringify(result).includes(scenario.secret), false);
    assert.equal('previewId' in result, false);
    assert.equal('changes' in result, false);
    // The synthetic entropy is deterministic; no generated ID may have been cached.
    assert.equal(await guarded.authority.getPreview('AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI'), null);
  });
});

test('Host checker sees every response number as JSON scalar text, including zero', async () => {
  const seen = new Map();
  const f = fixture({ rows: [{ id: 'old', output: 8192 }], protection: { revision: 17, secretGeneration: 3, complete: true,
    checkText: text => { seen.set(text, (seen.get(text) ?? 0) + 1); return true; } } });
  const result = await f.authority.preview({ provider: 'sample', selectedNewIds: [] });
  assert.equal(result.changes.find(change => change.field === 'maxTokens').index, 0);
  const candidate = Object.fromEntries(['provider', 'selectedNewIds', 'items', 'changes', 'warnings', 'sources']
    .map(key => [key, result[key]]));
  const minimum = new Map();
  const numeric = new Set();
  function count(value) {
    if (typeof value === 'string') minimum.set(value, (minimum.get(value) ?? 0) + 1);
    else if (typeof value === 'number') {
      const literal = JSON.stringify(value);
      numeric.add(literal);
      minimum.set(literal, (minimum.get(literal) ?? 0) + 1);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) { count(key); count(child); }
    }
  }
  // Both the preliminary projection and the final response are checked. Count
  // keys too, so an array key "0" cannot masquerade as inspection of index 0.
  count(candidate);
  count(result);
  assert.ok(numeric.has('0'));
  assert.ok(numeric.has('8192'));
  for (const literal of numeric) assert.ok((seen.get(literal) ?? 0) >= minimum.get(literal), 'unchecked numeric occurrence');
});

test('a numeric-only refusal, asynchronous verdict or exception never authorizes output', async () => {
  for (const verdict of [false, undefined, 1, 'true', Promise.resolve(true), Promise.reject(new Error('synthetic-checker-error')),
    () => { throw new Error('synthetic-checker-error'); }]) {
    const seen = [];
    const f = fixture({ rows: [{ id: 'new-first', context: 131072 }],
      protection: { revision: 17, secretGeneration: 3, complete: true, checkText: text => {
        seen.push(text);
        if (text !== '131072') return true;
        return typeof verdict === 'function' ? verdict() : verdict;
      } } });
    const result = await f.authority.preview({ provider: 'sample', selectedNewIds: ['new-first'] });
    assert.ok(seen.includes('131072'));
    assert.ok(result.error);
    assert.equal(JSON.stringify(result).includes('131072'), false);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-checker-error/);
    assert.equal('previewId' in result, false);
    assert.equal(await f.authority.getPreview('AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI'), null);
  }
});

test('Host checker can reject a secret assembled only in serialized response JSON', async () => {
  const f = fixture({ protection: { revision: 17, secretGeneration: 3, complete: true,
    checkText: text => !text.includes('"provider":"sample"') } });
  const result = await f.authority.preview({ provider: 'sample', selectedNewIds: [] });
  assert.equal(result.error?.code, 'INVALID_RESPONSE');
  assert.equal('previewId' in result, false);
  assert.equal(await f.authority.getPreview('AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI'), null);
});

test('a rejected async checker is refused without an unhandled secret in a strict subprocess', () => {
  const script = `
    import { createPreviewAuthority } from './lib/preview-authority.js';
    import { normalizeUpstreamCatalog } from './lib/metadata-source.js';
    const endpoint = 'https://private-gateway.example/private-scope/models';
    const protocol = 'openai-completions';
    const route = { provider: 'sample', api: protocol, baseURL: 'https://private-gateway.example/private-scope', models: [{ id: 'old' }] };
    const authority = createPreviewAuthority({
      readSnapshot: async () => ({ revision: 1, secretGeneration: 1,
        route: { revision: 1, value: route }, effective: { revision: 1, value: { status: 'known', models: [] } },
        protection: { revision: 1, secretGeneration: 1, complete: true,
          checkText: () => Promise.reject(new Error('FAKE_ASYNC_CHECKER_SECRET')) } }),
      fetchCatalog: async () => normalizeUpstreamCatalog({ provider: 'sample', protocol, endpoint,
        source: { kind: 'upstream', origin: 'https://private-gateway.example', fetchedAt: '2026-11-25T03:00:00.000Z' },
        payload: { data: [{ id: 'ordinary-model' }] }, responseComplete: true }),
      readRevision: async () => 1, readProtectionState: async () => ({ revision: 1, secretGeneration: 1 }),
    });
    const result = await authority.preview({ provider: 'sample', selectedNewIds: [] });
    console.log(JSON.stringify(result));
  `;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, `subprocess exited ${child.status}: ${child.stderr}`);
  assert.equal(child.stderr, '');
  assert.deepEqual(JSON.parse(child.stdout), { error: { code: 'INVALID_RESPONSE', message: 'Invalid preview request or model catalog.' } });
  assert.doesNotMatch(child.stdout + child.stderr, /FAKE_ASYNC_CHECKER_SECRET/);
});

test('only literal true authorizes output and thenables are not inspected or executed', async () => {
  let touches = 0;
  const thenable = Object.defineProperty({}, 'then', { get() { touches++; throw new Error('FAKE_THENABLE_SECRET'); } });
  const proxyThenable = new Proxy({}, { get() { touches++; throw new Error('FAKE_THENABLE_SECRET'); } });
  for (const verdict of [false, null, 1, 'true', thenable, proxyThenable, Promise.resolve(true)]) {
    const f = fixture({ protection: { revision: 17, secretGeneration: 3, complete: true, checkText: () => verdict } });
    const result = await f.authority.preview({ provider: 'sample', selectedNewIds: [] });
    assert.equal(result.error?.code, 'INVALID_RESPONSE');
    assert.doesNotMatch(JSON.stringify(result), /FAKE_THENABLE_SECRET/);
    assert.equal('previewId' in result, false);
  }
  assert.equal(touches, 0);
});

test('Host protection is mandatory, complete, revision-bound and generation-bound', async () => {
  const good = text => !text.includes('sk-synthetic-independent');
  for (const protection of [null, {}, { revision: 17, secretGeneration: 3, checkText: good },
    { revision: 16, secretGeneration: 3, complete: true, checkText: good },
    { revision: 17, secretGeneration: 4, complete: true, checkText: good },
    { revision: 17, secretGeneration: 3, complete: true },
  ]) {
    const f = fixture({ protection });
    assert.equal((await f.authority.preview({ provider: 'sample', selectedNewIds: [] })).error.code, 'SETTINGS_UNAVAILABLE');
    assert.deepEqual(f.calls.map(call => call[0]), ['snapshot']);
  }
  const missingState = fixture({ readProtectionState: undefined });
  assert.equal((await missingState.authority.preview({ provider: 'sample', selectedNewIds: [] })).error.code, 'SETTINGS_UNAVAILABLE');
  assert.deepEqual(missingState.calls.map(call => call[0]), ['snapshot']);
  for (const checkText of [() => undefined, () => Promise.resolve(true), () => { throw new Error('sk-synthetic-independent'); }]) {
    const f = fixture({ protection: { revision: 17, secretGeneration: 3, complete: true, checkText } });
    const result = await f.authority.preview({ provider: 'sample', selectedNewIds: [] });
    assert.ok(result.error);
    assert.doesNotMatch(JSON.stringify(result), /sk-synthetic-independent/);
    assert.equal('previewId' in result, false);
  }
});

test('rejects untrusted request overrides, duplicate identities and unverifiable revision before source fetch', async () => {
  const f = fixture();
  for (const input of [
    { provider: 'sample', selectedNewIds: [], endpoint },
    { provider: 'sample', selectedNewIds: [], route: f.route },
    { provider: 'sample', selectedNewIds: [], proof: docs },
    { provider: 'sample', selectedNewIds: [], clock: 0 },
    { provider: 'sample', selectedNewIds: ['new-first', 'new-first'] },
    { provider: 'sample', selectedNewIds: [''] },
    { provider: '__proto__', selectedNewIds: [] },
  ]) assert.ok((await f.authority.preview(input)).error, JSON.stringify(input));
  assert.deepEqual(f.calls, []);
  const mismatch = fixture({ readSnapshot: async () => ({ revision: 17,
    route: { revision: 16, value: f.route }, effective: { revision: 17, value: f.effective } }) });
  assert.equal((await mismatch.authority.preview({ provider: 'sample', selectedNewIds: [] })).error.code, 'SETTINGS_UNAVAILABLE');
  assert.deepEqual(mismatch.calls, []);
});

test('failed, incomplete, copied or foreign catalogs are refused, never presented as an empty success', async () => {
  for (const catalog of [
    { status: 'failed', applicable: false, models: [], error: { message: 'sensitive-response' } },
    { status: 'complete', applicable: true, models: [] },
    { status: 'complete', applicable: true, models: [{ id: 'new-first' }] },
  ]) {
    const f = fixture({ fetchCatalog: async () => catalog });
    const result = await f.authority.preview({ provider: 'sample', selectedNewIds: [] });
    assert.ok(result.error);
    assert.doesNotMatch(JSON.stringify(result), /sensitive-response|gateway\.example/);
  }
  const foreign = fixture({ fetchCatalog: async () => normalizeUpstreamCatalog({ provider: 'other', protocol, endpoint,
    source: { kind: 'upstream', origin: 'https://gateway.example', fetchedAt: '2026-11-25T03:00:00.000Z' },
    payload: { data: [{ id: 'old' }] }, responseComplete: true }, []) });
  assert.ok((await foreign.authority.preview({ provider: 'sample', selectedNewIds: [] })).error);
});

test('concurrent previews receive distinct opaque tokens and expire, cancel or invalidate by revision', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([
    f.authority.preview({ provider: 'sample', selectedNewIds: ['new-first'] }),
    f.authority.preview({ provider: 'sample', selectedNewIds: ['new-first'] }),
  ]);
  assert.notEqual(a.previewId, b.previewId);
  assert.equal(a.digest, b.digest);
  assert.ok(await f.authority.getPreview(a.previewId));
  assert.equal(await f.authority.cancel(b.previewId), true);
  assert.equal(await f.authority.getPreview(b.previewId), null);
  f.setTime(now + 300000);
  assert.equal(await f.authority.getPreview(a.previewId), null);
  f.setTime(now + 300001);
  const c = await f.authority.preview({ provider: 'sample', selectedNewIds: [] });
  assert.match(c.previewId, /^[A-Za-z0-9_-]{40,}$/);
  assert.ok(await f.authority.getPreview(c.previewId));
  f.setRevision(18);
  assert.equal(await f.authority.getPreview(c.previewId), null);
  assert.equal('apply' in f.authority, false);
});

test('a failed source is sanitized and a concurrent settings edit refuses stale preview', async () => {
  const failed = fixture({ fetchCatalog: async () => { throw new Error('transport-secret'); } });
  const failure = await failed.authority.preview({ provider: 'sample', selectedNewIds: [] });
  assert.equal(failure.error.code, 'INCOMPLETE_RESPONSE');
  assert.doesNotMatch(JSON.stringify(failure), /transport-secret/);

  let unblock;
  let started;
  const pending = new Promise(resolve => { unblock = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture({ fetchCatalog: async ({ route }) => {
    started();
    await pending;
    return normalizeUpstreamCatalog({ provider: route.provider, protocol, endpoint,
      source: { kind: 'upstream', origin: 'https://gateway.example', fetchedAt: '2026-11-25T03:00:00.000Z' },
      payload: { data: [{ id: 'old' }] }, responseComplete: true }, []);
  } });
  const preview = f.authority.preview({ provider: 'sample', selectedNewIds: [] });
  await ready;
  f.setRevision(18);
  unblock();
  assert.equal((await preview).error.code, 'REVISION_CONFLICT');
});

test('malformed absent evidence cannot turn an unknown configured value into permission', async () => {
  const f = fixture();
  f.effective.models[1].fields.contextWindow = {
    status: 'absent', value: 'not-absent',
    evidence: { explicit: 'absent', catalog: 'absent', routeDefault: 'absent' },
  };
  const result = await f.authority.preview({ provider: 'sample', selectedNewIds: ['new-first'] });
  assert.notEqual(field(result, 'new-first', 'contextWindow').state, 'applicable');
  assert.equal(result.changes.some(change => change.modelId === 'new-first' && change.field === 'contextWindow'), false);
});

test('digest ignores unrelated secret changes but changes with selection', async () => {
  const f = fixture();
  const first = await f.authority.preview({ provider: 'sample', selectedNewIds: ['new-first'] });
  f.route.headers.Authorization = 'another-secret';
  const second = await f.authority.preview({ provider: 'sample', selectedNewIds: ['new-first'] });
  const third = await f.authority.preview({ provider: 'sample', selectedNewIds: [] });
  assert.equal(first.digest, second.digest);
  assert.notEqual(first.digest, third.digest);
});

test('reference is disabled without requests and stays unknown without the trusted bridge', async () => {
  const f = fixture({ referenceEnabled: false });
  const result = await f.authority.preview({ provider: 'sample', selectedNewIds: [] });
  assert.equal(result.sources.reference.status, 'disabled');
  assert.deepEqual(f.calls.map(call => call[0]), ['snapshot', 'fetch']);
});
