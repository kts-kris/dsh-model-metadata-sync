import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { encodeReferenceRecords, fetchReferenceWorker } from '../lib/reference-worker.js';
import { isValidModelId } from '../lib/metadata-source.js';

const TIME = '2026-11-25T03:00:00.000Z';
const URL = 'https://models.dev/api.json';
const synthetic = { acme: { id: 'acme', models: {
  good: { id: 'good', limit: { context: 128000, output: 8192 } },
  bad: { id: 'bad', limit: { context: 0 } },
} } };

const call = (catalog, extra = {}) => fetchReferenceWorker({
  transport: async () => new Response(JSON.stringify(catalog)), clock: () => TIME, ...extra,
});

test('one complete anonymous request preserves valid models and explicit invalid-model tombstones', async () => {
  const requests = [];
  const result = await call(synthetic, {
    endpoint: 'https://private.example', headers: { authorization: 'synthetic-secret' },
    transport: async (url, options) => {
      requests.push([url, options]);
      return new Response(JSON.stringify(synthetic));
    },
  });
  assert.equal(result.status, 'complete');
  assert.equal(requests.length, 1);
  const [[url, options]] = requests;
  assert.equal(url, URL);
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'manual');
  assert.equal(options.credentials, 'omit');
  assert.deepEqual([...new Headers(options.headers)], [['accept-encoding', 'identity']]);
  assert.doesNotMatch(JSON.stringify(requests), /private\.example|synthetic-secret/);
  const [good, bad] = result.records;
  assert.deepEqual({ provider: good.provider, modelId: good.modelId, protocol: good.protocol,
    contextWindow: good.contextWindow, maxTokens: good.maxTokens, reasoningEfforts: good.reasoningEfforts,
    observedLimitContext: good.observedLimitContext, observedLimitOutput: good.observedLimitOutput, source: good.source },
  { provider: 'acme', modelId: 'good', protocol: null, contextWindow: null, maxTokens: null,
    reasoningEfforts: null, observedLimitContext: 128000, observedLimitOutput: 8192,
    source: { kind: 'reference', origin: URL, fetchedAt: TIME } });
  assert.equal(bad.provider, 'acme');
  assert.equal(bad.modelId, 'bad');
  assert.equal(bad.status, 'unknown');
  assert.equal(bad.identityAmbiguous, true);
  assert.equal(bad.contextWindow, null);
  assert.equal(bad.maxTokens, null);
});

test('importing from another worker does not fetch or close its message port', { timeout: 5000 }, async () => {
  const entry = new globalThis.URL('../lib/reference-worker.js', import.meta.url).href;
  const code = `
    import { parentPort } from 'node:worker_threads';
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; return new Response(${JSON.stringify(JSON.stringify(synthetic))}); };
    await import(${JSON.stringify(entry)});
    parentPort.on('message', message => {
      if (message === 'ping') { parentPort.postMessage({ event: 'pong', fetches }); parentPort.close(); }
    });
    parentPort.postMessage({ event: 'imported', fetches, argv1: process.argv[1] ?? null });
  `;
  const worker = new Worker(new globalThis.URL(`data:text/javascript,${encodeURIComponent(code)}`), {
    type: 'module', env: {}, execArgv: [], workerData: { entry: true },
  });
  const messages = [];
  worker.on('message', message => { messages.push(message); if (message?.event === 'imported') worker.postMessage('ping'); });
  const exit = await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', resolve); });
  assert.equal(exit, 0);
  assert.deepEqual(messages, [{ event: 'imported', fetches: 0, argv1: null }, { event: 'pong', fetches: 0 }]);
});

test('a data worker cannot trigger network or close its port by forging parser argv', { timeout: 5000 }, async () => {
  const parser = new globalThis.URL('../lib/reference-worker.js', import.meta.url);
  const code = `
    import { parentPort } from 'node:worker_threads';
    let fetches = 0;
    // A fake transport makes accidental fetch observable without any network.
    globalThis.fetch = async () => { fetches++; return new Response(${JSON.stringify(JSON.stringify(synthetic))}); };
    await import(${JSON.stringify(parser.href)});
    parentPort.on('message', message => {
      if (message === 'ping') { parentPort.postMessage({ event: 'pong', fetches }); parentPort.close(); }
    });
    parentPort.postMessage({ event: 'imported', fetches, argv1: process.argv[1] });
  `;
  const worker = new Worker(new globalThis.URL(`data:text/javascript,${encodeURIComponent(code)}`), {
    type: 'module', argv: [fileURLToPath(parser)], workerData: { entry: true }, env: {}, execArgv: [],
  });
  const messages = [];
  worker.on('message', message => {
    messages.push(message);
    if (message?.event === 'imported') worker.postMessage('ping');
  });
  const exit = await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', resolve); });
  assert.equal(exit, 0);
  assert.deepEqual(messages, [
    { event: 'imported', fetches: 0, argv1: fileURLToPath(parser) },
    { event: 'pong', fetches: 0 },
  ]);
});

test('a non-object provider makes the entire source unknown even with an unrelated valid provider', async () => {
  const good = { id: 'good', models: { ok: { id: 'ok' } } };
  for (const damaged of [null, false, 'bad', 7, []]) {
    const result = await call({ damaged, good });
    assert.deepEqual(result, { status: 'unknown', records: [] }, `damaged=${JSON.stringify(damaged)}`);
  }
});

test('a present but empty Content-Encoding header fails closed', async () => {
  for (const encoding of ['', '  ', '\t']) {
    const result = await fetchReferenceWorker({
      transport: async () => new Response(JSON.stringify(synthetic), { headers: { 'content-encoding': encoding } }),
      clock: () => TIME,
    });
    assert.deepEqual(result, { status: 'unknown', records: [] }, `encoding=${JSON.stringify(encoding)}`);
  }
});

test('real worker entry emits one JSON string with a fake preloaded transport and exits normally', { timeout: 5000 }, async () => {
  const entry = new globalThis.URL('../lib/reference-worker-entry.js', import.meta.url);
  const fake = JSON.stringify(synthetic);
  // --import executes before the actual file entry and never falls back to network.
  const preload = `
    globalThis.fetch = async (url, options) => {
      if (url !== ${JSON.stringify(URL)} || options.method !== 'GET' || options.redirect !== 'manual' ||
          options.credentials !== 'omit' || options.referrerPolicy !== 'no-referrer' ||
          JSON.stringify(Object.keys(options).sort()) !== JSON.stringify(['credentials', 'headers', 'method', 'redirect', 'referrerPolicy']) ||
          new Headers(options.headers).get('accept-encoding') !== 'identity' || Object.keys(options.headers).length !== 1 ||
          Object.keys(process.env).length !== 0) throw new Error('not fixed');
      return new Response(${JSON.stringify(fake)});
    };
  `;
  const worker = new Worker(entry, {
    type: 'module',
    argv: ['https://argv-private.invalid', 'synthetic-argv-secret'],
    workerData: { url: 'https://private.invalid', headers: { authorization: 'synthetic-secret' } },
    env: {}, execArgv: ['--import', `data:text/javascript,${encodeURIComponent(preload)}`],
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  });
  const messages = [];
  worker.on('message', message => messages.push(message));
  const exit = await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', resolve); });
  assert.equal(exit, 0);
  assert.equal(messages.length, 1);
  assert.equal(typeof messages[0], 'string');
  assert.doesNotMatch(messages[0], /private\.invalid|synthetic-secret|synthetic-argv-secret/);
  const records = JSON.parse(messages[0]);
  assert.equal(records.length, 2);
  assert.equal(records[0].modelId, 'good');
  assert.equal(records[1].status, 'unknown');
});

test('identity conflicts contaminate their whole affected scope, not unrelated providers', async () => {
  const catalog = {
    good: { id: 'good', models: { one: { id: 'one', limit: { context: 32000 } } } },
    wrong: { id: 'victim', models: { m: { id: 'm' } } },
    victim: { id: 'victim', models: { m: { id: 'm' } } },
    conflictingModels: { id: 'conflictingModels', models: {
      poisoned: { id: 'victim' }, victim: { id: 'victim' }, safe: { id: 'safe' },
    } },
  };
  const result = await call(catalog);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.records.map(({ provider, modelId, status }) => `${provider}/${modelId}/${status ?? 'valid'}`), [
    'good/one/valid', 'conflictingModels/poisoned/unknown',
    'conflictingModels/victim/unknown', 'conflictingModels/safe/valid',
  ]);
});

test('rejects unpaired surrogate identities but preserves valid Unicode scalar identities', async () => {
  for (const bad of ['\ud800', '\udfff']) {
    const provider = await call({ [bad]: { id: bad, models: { ok: { id: 'ok' } } } });
    assert.deepEqual(provider, { status: 'unknown', records: [] });
    const model = await call({ acme: { id: 'acme', models: { [bad]: { id: bad } } } });
    assert.deepEqual(model, { status: 'unknown', records: [] });
  }
  const valid = await call({ '🧪': { id: '🧪', models: { '模型😀': { id: '模型😀' } } } });
  assert.equal(valid.status, 'complete');
  assert.equal(valid.records[0].modelId, '模型😀');
});

test('model IDs follow the shared metadata boundary, including unsafe object-property names', async () => {
  for (const id of ['__proto__', 'prototype', 'constructor']) {
    assert.equal(isValidModelId(id), false, id);
    const models = JSON.parse(`{${JSON.stringify(id)}:{"id":${JSON.stringify(id)}}}`);
    const result = await call({
      acme: { id: 'acme', models },
      good: { id: 'good', models: { ok: { id: 'ok' } } },
    });
    assert.equal(result.status, 'complete', id);
    assert.deepEqual(result.records.map(({ provider, modelId }) => [provider, modelId]), [['good', 'ok']], id);
  }
  assert.equal(isValidModelId('constructor-safe'), true);
  const valid = await call({ acme: { id: 'acme', models: { 'constructor-safe': { id: 'constructor-safe' } } } });
  assert.equal(valid.records[0].modelId, 'constructor-safe');
});

test('worker output limits count exact records and serialized UTF-8 bytes', () => {
  assert.equal(JSON.parse(encodeReferenceRecords(Array(20_000).fill({}))).length, 20_000);
  assert.throws(() => encodeReferenceRecords(Array(20_001).fill({})), /result limit/);
  const record = { x: 'a'.repeat(8_184) };
  assert.equal(Buffer.byteLength(JSON.stringify(record)), 8_192);
  assert.doesNotThrow(() => encodeReferenceRecords([record]));
  assert.throws(() => encodeReferenceRecords([{ x: 'a'.repeat(8_185) }]), /result limit/);
  assert.throws(() => encodeReferenceRecords([{ x: '界'.repeat(2_729) }]), /result limit/);
  const boundary = [...Array(1023).fill(record), { x: 'a'.repeat(7_159) }];
  assert.equal(Buffer.byteLength(encodeReferenceRecords(boundary)), 8 * 1024 * 1024);
  boundary[1023].x += 'a';
  assert.throws(() => encodeReferenceRecords(boundary), /result limit/);
});

test('an unassignable model cannot suppress an unrelated independent provider', async () => {
  const result = await call({
    damaged: { id: 'damaged', models: { missing: { limit: { context: 10 } } } },
    good: { id: 'good', models: { ok: { id: 'ok' } } },
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.records.map(({ provider, modelId }) => `${provider}/${modelId}`), ['good/ok']);
});

test('unassignable identities invalidate the whole snapshot; exact invalid limits become tombstones', async (t) => {
  const malformed = [
    null, {}, { error: null, acme: synthetic.acme },
    { acme: { models: { one: { id: 'one' } } }, good: synthetic.acme },
    { acme: { id: 7, models: { one: { id: 'one' } } } },
    { acme: { id: 'acme', models: { missing: { limit: { context: 100 } } } } },
    { acme: { id: 'acme', models: { missing: 'not an object' } } },
  ];
  for (let i = 0; i < malformed.length; i++) await t.test(String(i), async () => {
    const result = await call(malformed[i]);
    assert.deepEqual(result, { status: 'unknown', records: [] });
  });
  const limits = [null, [], false, { context: null }, { context: 0 }, { context: 10, input: 11 },
    { context: 10, output: 11 }];
  for (const limit of limits) {
    const result = await call({ acme: { id: 'acme', models: { one: { id: 'one', limit } } } });
    assert.equal(result.status, 'complete');
    assert.equal(result.records[0].status, 'unknown', JSON.stringify(limit));
    assert.equal(result.records[0].identityAmbiguous, true);
  }
});

test('error markers inside limit tombstone only the affected exact model', async (t) => {
  for (const field of ['error', 'errors']) for (const marker of [null, false, {}, 'synthetic-private-token']) {
    await t.test(`${field}=${JSON.stringify(marker)}`, async () => {
      const result = await call({ acme: { id: 'acme', models: {
        poisoned: { id: 'poisoned', limit: { context: 100, output: 10, [field]: marker } },
        safe: { id: 'safe', limit: { context: 200, output: 20 } },
      } } });
      assert.equal(result.status, 'complete');
      const [poisoned, safe] = result.records;
      assert.equal(poisoned.modelId, 'poisoned');
      assert.equal(poisoned.status, 'unknown');
      assert.equal(poisoned.identityAmbiguous, true);
      assert.equal(Object.hasOwn(poisoned, 'observedLimitContext'), false);
      assert.equal(Object.hasOwn(poisoned, 'observedLimitOutput'), false);
      assert.equal(safe.modelId, 'safe');
      assert.equal(safe.observedLimitContext, 200);
      assert.equal(safe.observedLimitOutput, 20);
      assert.doesNotMatch(JSON.stringify(result), /synthetic-private-token/);
    });
  }
});

test('any provider or model alias fails the whole snapshot when cross-provider scope is unknown', async (t) => {
  for (const scope of ['provider', 'model']) for (const field of ['alias', 'aliases']) {
    for (const value of ['independent/ok', null, [], {}]) {
      await t.test(`${scope}.${field}=${JSON.stringify(value)}`, async () => {
        const acme = { id: 'acme', models: {
          one: { id: 'one', arbitrary: 'synthetic-private-token', limit: { context: 10 } },
          other: { id: 'other', limit: { context: 10 } },
        } };
        (scope === 'provider' ? acme : acme.models.one)[field] = value;
        const result = await call({ acme, independent: { id: 'independent', models: { ok: { id: 'ok' } } } });
        assert.deepEqual(result, { status: 'unknown', records: [] });
        assert.doesNotMatch(JSON.stringify(result), /synthetic-private-token/);
      });
    }
  }
  for (const damaged of [
    { id: 'damaged', error: {}, models: { m: { id: 'm', alias: 'independent/ok' } } },
    { id: 'damaged', models: { bad: {}, m: { id: 'm', alias: 'independent/ok' } } },
  ]) await t.test('alias cannot hide inside an unavailable or previously damaged provider', async () => {
    const result = await call({ damaged, independent: { id: 'independent', models: { ok: { id: 'ok' } } } });
    assert.deepEqual(result, { status: 'unknown', records: [] });
  });
});

test('non-object model collections or entries cannot hide cross-provider identity ambiguity', async (t) => {
  const independent = { id: 'independent', models: { ok: { id: 'ok' } } };
  const cases = [
    ['collection array hides alias', { id: 'damaged', models: [{ id: 'm', alias: 'independent/ok' }] }],
    ['model array hides aliases', { id: 'damaged', models: { m: [{ id: 'm', aliases: ['independent/ok'] }] } }],
    ...[null, false, 0, 'invalid', []].flatMap(value => [
      [`collection ${JSON.stringify(value)}`, { id: 'damaged', models: value }],
      [`model ${JSON.stringify(value)}`, { id: 'damaged', models: { m: value } }],
    ]),
    ['missing collection', { id: 'damaged' }],
    ['skipped provider collection', { id: 'different', error: {}, models: [{ alias: 'independent/ok' }] }],
    ['skipped provider model', { id: 'damaged', error: {}, models: { m: [{ alias: 'independent/ok' }] } }],
  ];
  for (const [name, damaged] of cases) await t.test(name, async () => {
    for (const catalog of [{ damaged, independent }, { independent, damaged }]) {
      const result = await call(catalog);
      assert.deepEqual(result, { status: 'unknown', records: [] });
    }
  });
});

test('absent optional model fields remain valid beside an exact tombstone', async () => {
  const result = await call({ acme: { id: 'acme', models: {
    noLimit: { id: 'noLimit' },
    inputOnly: { id: 'inputOnly', limit: { input: 10 } },
    invalid: { id: 'invalid', limit: { context: 0 } },
    good: { id: 'good', limit: { context: 100, output: 20 } },
  } } });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.records.map(({ modelId, status, identityAmbiguous, observedLimitContext, observedLimitOutput }) =>
    ({ modelId, status, identityAmbiguous, observedLimitContext, observedLimitOutput })), [
    { modelId: 'noLimit', status: undefined, identityAmbiguous: undefined, observedLimitContext: null, observedLimitOutput: null },
    { modelId: 'inputOnly', status: undefined, identityAmbiguous: undefined, observedLimitContext: null, observedLimitOutput: null },
    { modelId: 'invalid', status: 'unknown', identityAmbiguous: true, observedLimitContext: undefined, observedLimitOutput: undefined },
    { modelId: 'good', status: undefined, identityAmbiguous: undefined, observedLimitContext: 100, observedLimitOutput: 20 },
  ]);
});

test('enforces exact 16 MiB actual bytes independently of Content-Length', { timeout: 30_000 }, async () => {
  const cap = 16 * 1024 * 1024;
  const base = JSON.stringify({ acme: { id: 'acme', models: { ok: { id: 'ok' } } } });
  for (const size of [cap, cap + 1]) for (const declared of [false, true]) {
    const text = `${base}${' '.repeat(size - base.length)}`;
    const result = await fetchReferenceWorker({
      transport: async () => new Response(text, { headers: declared ? { 'content-length': String(size) } : {} }),
      clock: () => TIME,
    });
    assert.equal(result.status, size === cap ? 'complete' : 'unknown', `${size} declared=${declared}`);
  }
});

test('exact 128 containers accepted and depth 129 rejected', async () => {
  const prefix = '{"acme":{"id":"acme","models":{"ok":{"id":"ok","extra":';
  const suffix = '}}}}';
  for (const depth of [128, 129]) {
    const json = prefix + '['.repeat(depth - 4) + '0' + ']'.repeat(depth - 4) + suffix;
    const result = await fetchReferenceWorker({ transport: async () => new Response(json), clock: () => TIME });
    assert.equal(result.status, depth === 128 ? 'complete' : 'unknown', `depth=${depth}`);
  }
});

test('exact JSON key and value-count boundaries are checked before object construction', { timeout: 30_000 }, async () => {
  // Root + provider + models + model + extra = 5 containers and six
  // keys (acme,id,models,ok,id,extra). Allocate the bulk inside one array.
  const prefix = '{"acme":{"id":"acme","models":{"ok":{"id":"ok","extra":';
  const suffix = '}}}}';
  for (const count of [1_000_000, 1_000_001]) {
    // Distinct short keys are required: each counts once, including schema keys.
    const pairs = [];
    for (let i = 0; i < count - 6; i++) pairs.push(`"${i}":0`);
    const body = `${prefix}{${pairs.join(',')}}${suffix}`;
    const result = await fetchReferenceWorker({ transport: async () => new Response(body), clock: () => TIME });
    assert.equal(result.status, count === 1_000_000 ? 'complete' : 'unknown', `keys=${count}`);
  }
  for (const count of [2_000_000, 2_000_001]) {
    // Five schema/container values precede items: root, provider, provider id,
    // models, model, model id, and the array itself = seven.
    const array = Array(count - 7).fill('0').join(',');
    const body = `${prefix}[${array}]${suffix}`;
    const result = await fetchReferenceWorker({ transport: async () => new Response(body), clock: () => TIME });
    assert.equal(result.status, count === 2_000_000 ? 'complete' : 'unknown', `values=${count}`);
  }
});

test('exact 65536 chunks accepted and overflow cancels the reader', { timeout: 30_000 }, async () => {
  const body = new TextEncoder().encode(JSON.stringify({ acme: { id: 'acme', models: { ok: { id: 'ok' } } } }));
  for (const chunks of [65_536, 65_537]) {
    let reads = 0, cancels = 0;
    const reader = {
      async read() { return reads++ < chunks ? { done: false, value: reads === 1 ? body : new Uint8Array() } : { done: true }; },
      cancel() { cancels++; }, releaseLock() {},
    };
    const response = { status: 200, ok: true, headers: new Headers(), body: { getReader: () => reader } };
    const result = await fetchReferenceWorker({ transport: async () => response, clock: () => TIME });
    assert.equal(result.status, chunks === 65_536 ? 'complete' : 'unknown', `chunks=${chunks}`);
    assert.equal(cancels, chunks === 65_536 ? 0 : 1);
  }
});

test('rejects redirects, partial or encoded responses and invalid declared lengths', async (t) => {
  const body = JSON.stringify(synthetic);
  for (const [name, response] of [
    ['redirect', new Response(null, { status: 302, headers: { location: URL } })],
    ['not found', new Response(body, { status: 404 })],
    ['compressed', new Response(body, { headers: { 'content-encoding': 'gzip' } })],
    ['truncated', new Response(body, { headers: { 'content-length': String(Buffer.byteLength(body) + 1) } })],
    ['malformed length', new Response(body, { headers: { 'content-length': '1, 1' } })],
    ['pagination', new Response(body, { headers: { link: '<https://example.test/>; rel="next"' } })],
    ['partial content', new Response(body, { headers: { 'content-range': 'bytes 0-10/99' } })],
  ]) await t.test(name, async () => {
    assert.deepEqual(await fetchReferenceWorker({ transport: async () => response, clock: () => TIME }),
      { status: 'unknown', records: [] });
  });
});

test('rejects escaped-equivalent duplicate keys and invalid UTF-8 before projection', async (t) => {
  const payloads = [
    '{"acme":{"id":"acme","models":{"good":{"id":"good"}}},"\\u0061cme":{"id":"acme","models":{}}}',
    '{"acme":{"id":"acme","models":{"good":{"id":"good","limit":{"context":10,"cont\\u0065xt":11}}}}}',
    '{"acme":{"id":"acme","models":{"good":{"id":"good"},"good":{"id":"good"}}}}',
    new Uint8Array([0x7b, 0x22, 0xc0, 0xaf, 0x22, 0x3a, 0x31, 0x7d]),
    new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(JSON.stringify(synthetic))]),
  ];
  for (let i = 0; i < payloads.length; i++) await t.test(String(i), async () => {
    const result = await fetchReferenceWorker({ transport: async () => new Response(payloads[i]), clock: () => TIME });
    assert.deepEqual(result, { status: 'unknown', records: [] });
  });
});
