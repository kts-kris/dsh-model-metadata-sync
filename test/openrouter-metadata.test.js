import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOpenRouterCatalog } from '../lib/openrouter-metadata.js';

const endpoint = 'https://openrouter.ai/api/v1/models';
const source = { kind: 'upstream', origin: 'https://openrouter.ai', fetchedAt: '2026-11-25T03:00:00.000Z' };

function normalize(rows, options = {}) {
  return normalizeOpenRouterCatalog({
    provider: 'My Gateway', protocol: 'openai-completions', endpoint, source,
    payload: { data: rows }, responseComplete: true, existingModelIds: [], ...options,
  });
}

test('official OpenRouter model total context is known', () => {
  const result = normalize([{ id: 'vendor/model', context_length: 128000 }]);
  assert.equal(result.status, 'complete');
  assert.equal(result.models[0].contextWindow.state, 'known');
  assert.equal(result.models[0].contextWindow.value, 128000);
});

test('missing context length stays unknown without invoking inherited getters', () => {
  const input = JSON.parse(`{
    "provider":"My Gateway", "protocol":"openai-completions",
    "endpoint":"https://openrouter.ai/api/v1/models",
    "source":{"kind":"upstream", "origin":"https://openrouter.ai", "fetchedAt":"2026-11-25T03:00:00.000Z"},
    "payload":{"data":[{"id":"missing"},{"id":"present", "context_length":1024}]},
    "responseComplete":true, "existingModelIds":[]
  }`);
  assert.equal(Object.getOwnPropertyDescriptor(Object.prototype, 'context_length'), undefined);
  let effects = 0;
  let result;
  Object.defineProperty(Object.prototype, 'context_length', {
    configurable: true, get() { effects++; return 128000; },
  });
  try {
    result = normalizeOpenRouterCatalog(input);
  } finally {
    delete Object.prototype.context_length;
  }
  assert.equal(effects, 0);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.models[0].contextWindow, { state: 'unknown', value: null });
  assert.equal(result.models[1].contextWindow.value, 1024);
});

test('only own JSON fields affect catalog validation and model capabilities', () => {
  const scenarios = [
    ['error', () => {}, 'complete'], ['errors', () => {}, 'complete'],
    ['has_more', () => {}, 'complete'], ['next', () => {}, 'complete'],
    ['links', () => {}, 'complete'], ['total_count', () => {}, 'complete'],
    ['id', input => { delete input.payload.data[0].id; }, 'failed'],
    ['reasoning', () => {}, 'complete'],
    ['supported_efforts', input => { input.payload.data[0].reasoning = { mandatory: false }; }, 'complete'],
    ['mandatory', input => { input.payload.data[0].reasoning = { supported_efforts: ['high'] }; }, 'complete'],
    ['top_provider', () => {}, 'complete'],
    ['max_completion_tokens', input => { input.payload.data[0].top_provider = {}; }, 'complete'],
    ['alias_target', () => {}, 'complete'],
    ['provider', input => { delete input.provider; }, 'failed'],
    ['endpoint', input => { delete input.endpoint; }, 'failed'],
    ['protocol', input => { delete input.protocol; }, 'failed'],
    ['existingModelIds', () => {}, 'complete'],
    ['source', input => { delete input.source; }, 'failed'],
    ['kind', input => { delete input.source.kind; }, 'failed'],
    ['origin', input => { delete input.source.origin; }, 'failed'],
    ['fetchedAt', input => { delete input.source.fetchedAt; }, 'failed'],
    ['responseComplete', input => { delete input.responseComplete; }, 'failed'],
    ['data', input => { delete input.payload.data; }, 'failed'],
    ['payload', input => { delete input.payload; }, 'failed'],
  ];
  for (const [key, change, status] of scenarios) {
    const input = JSON.parse(`{"provider":"My Gateway","protocol":"openai-completions",
      "endpoint":"https://openrouter.ai/api/v1/models",
      "source":{"kind":"upstream","origin":"https://openrouter.ai","fetchedAt":"2026-11-25T03:00:00.000Z"},
      "payload":{"data":[{"id":"model","context_length":1024}]},"responseComplete":true}`);
    change(input);
    assert.equal(Object.getOwnPropertyDescriptor(Object.prototype, key), undefined, key);
    let effects = 0;
    let result;
    Object.defineProperty(Object.prototype, key, { configurable: true, get() { effects++; throw new Error('private inherited error'); } });
    try {
      result = normalizeOpenRouterCatalog(input);
    } finally {
      delete Object.prototype[key];
    }
    assert.equal(effects, 0, key);
    assert.equal(result.status, status, key);
    assert.equal(JSON.stringify(result).includes('private inherited error'), false, key);
    if (status === 'failed') {
      assert.equal(result.applicable, false, key);
      assert.deepEqual(result.models, [], key);
    } else {
      assert.equal(result.models[0].contextWindow.value, 1024, key);
      assert.equal(result.models[0].maxTokens.state, 'unknown', key);
      assert.equal(result.models[0].topProviderMaxTokens.state, 'unknown', key);
      assert.equal(result.models[0].reasoningEfforts.state, 'unknown', key);
    }
  }
});

test('array prototype method pollution cannot execute or forge model capabilities', () => {
  for (const key of ['map', 'every', 'some', 'includes']) {
    const original = Object.getOwnPropertyDescriptor(Array.prototype, key);
    assert.ok(original && typeof original.value === 'function', key);
    const input = JSON.parse(`{"provider":"My Gateway","protocol":"openai-completions",
      "endpoint":"https://openrouter.ai/api/v1/models",
      "source":{"kind":"upstream","origin":"https://openrouter.ai","fetchedAt":"2026-11-25T03:00:00.000Z"},
      "payload":{"data":[{"id":"model","context_length":1024,
        "reasoning":{"mandatory":false,"supported_efforts":["high"]}}]},
      "responseComplete":true,"existingModelIds":["model"]}`);
    let effects = 0;
    let result;
    try {
      Object.defineProperty(Array.prototype, key, {
        configurable: true, get() { effects++; return original.value; },
      });
      result = normalizeOpenRouterCatalog(input);
    } finally {
      Object.defineProperty(Array.prototype, key, original);
    }
    assert.equal(effects, 0, key);
    assert.equal(result.status, 'complete', key);
    assert.equal(result.models[0].contextWindow.value, 1024, key);
    assert.equal(result.models[0].existing, true, key);
    assert.equal(result.models[0].reasoningEfforts.candidateStatus, 'recognized', key);
  }
});

test('array iterator pollution cannot hide an alias or weaken output freezing', () => {
  const input = JSON.parse(`{"provider":"My Gateway","protocol":"openai-completions",
    "endpoint":"https://openrouter.ai/api/v1/models",
    "source":{"kind":"upstream","origin":"https://openrouter.ai","fetchedAt":"2026-11-25T03:00:00.000Z"},
    "payload":{"data":[{"id":"model","alias_target":"vendor/model","context_length":1024},
      {"id":"concrete","context_length":2048}]},"responseComplete":true,"existingModelIds":[]}`);
  const original = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
  assert.ok(original && typeof original.value === 'function');
  let effects = 0;
  let result;
  try {
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      configurable: true,
      get() {
        effects++;
        return function* () {
          for (let i = 0; i < this.length; i++) if (this[i] !== 'alias_target') yield this[i];
        };
      },
    });
    result = normalizeOpenRouterCatalog(input);
  } finally {
    Object.defineProperty(Array.prototype, Symbol.iterator, original);
  }
  assert.equal(result.status, 'complete');
  assert.equal(result.models[0].contextWindow.state, 'unknown');
  assert.equal(result.models[0].contextWindow.value, null);
  assert.equal(result.models[1].contextWindow.value, 2048);
  assert.equal(effects, 0);
  assert.equal(Object.isFrozen(result.models), true);
  assert.equal(Object.isFrozen(result.models[0].contextWindow), true);
});

test('special JSON keys are copied safely without affecting projection or prototypes', () => {
  const payload = JSON.parse('{"data":[{"id":"model","context_length":42,"__proto__":{"context_length":123},"constructor":{"prototype":{"ignored":true}}}],"__proto__":{"error":"secret"},"prototype":true}');
  const result = normalize([], { payload });
  assert.equal(result.status, 'complete');
  assert.equal(result.models[0].contextWindow.value, 42);
  assert.equal(Object.hasOwn(Object.prototype, 'ignored'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('depth and node budgets reject the entire catalog without partial results', () => {
  const nested = depth => {
    let value = null;
    for (let i = 0; i < depth; i++) value = [value];
    return value;
  };
  const allowed = normalize([{ id: 'model', context_length: 42 }], {
    payload: { data: [{ id: 'model', context_length: 42 }], unused: nested(126) },
  });
  assert.equal(allowed.status, 'complete');
  const tooDeep = normalize([{ id: 'model' }], {
    payload: { data: [{ id: 'model' }], unused: nested(127) },
  });
  const tooMany = normalize([{ id: 'model' }], {
    payload: { data: [{ id: 'model' }], unused: new Array(4_200_001).fill(null) },
  });
  for (const result of [tooDeep, tooMany]) {
    assert.deepEqual(result, { status: 'failed', applicable: false, models: [], reason: 'invalid-or-incomplete-catalog' });
  }
});

test('gateway effort declarations remain visible but are not DSH wire proof', () => {
  const efforts = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const row = { id: 'vendor/model', reasoning: { mandatory: false, supported_efforts: efforts } };
  const field = normalize([row]).models[0].reasoningEfforts;
  assert.deepEqual(field, {
    state: 'unknown', value: null, candidates: efforts, candidateStatus: 'recognized',
    scope: 'gateway-declared', applicable: false, source: { ...source, provider: 'My Gateway', url: endpoint },
  });
  assert.equal(Object.hasOwn(field, 'complete'), false);
  const off = normalize([{ id: 'm', reasoning: { mandatory: false, supported_efforts: ['none', 'high'] } }]).models[0].reasoningEfforts;
  assert.deepEqual(off.candidates, ['none', 'high']);
  assert.equal(off.state, 'unknown');
  assert.equal(off.applicable, false);
  assert.equal(off.candidateStatus, 'invalid-or-unmapped');
  for (const efforts of [['low', 'extreme'], ['high', 'high'], [], ['off', 'high']]) {
    const field = normalize([{ id: 'm', reasoning: { mandatory: false, supported_efforts: efforts } }]).models[0].reasoningEfforts;
    assert.deepEqual(field.candidates, efforts);
    assert.equal(field.candidateStatus, 'invalid-or-unmapped');
    assert.equal(field.applicable, false);
  }
});

test('unknown aliases and missing allowlists do not establish a complete mapping', () => {
  for (const reasoning of [null, {}, { mandatory: false, supported_efforts: null },
    { mandatory: false, supported_efforts: ['low', 'extreme'] },
    { mandatory: false, supported_efforts: ['high', 'high'] },
    { mandatory: true, supported_efforts: ['none', 'high'] }]) {
    const field = normalize([{ id: 'm', reasoning }]).models[0].reasoningEfforts;
    assert.notEqual(field.state, 'known', JSON.stringify(reasoning));
    assert.equal(field.value, null);
  }
});

test('untrusted and changed source identities are never interpreted as OpenRouter', () => {
  for (const options of [
    { endpoint: 'https://other.example/api/v1/models' },
    { endpoint: 'http://openrouter.ai/api/v1/models' },
    { endpoint: 'https://openrouter.ai/api/v1/models?x=1' },
    { endpoint: 'https://openrouter.ai/api/v1/models/' },
    { endpoint: 'https://user:secret@openrouter.ai/api/v1/models' },
    { protocol: 'openai-responses' },
    { source: { ...source, origin: 'https://other.example' } },
    { source: { ...source, fetchedAt: 'invalid' } },
    { provider: '' },
  ]) {
    const result = normalize([{ id: 'm', context_length: 100 }], options);
    assert.equal(result.status, 'failed');
    assert.equal(result.applicable, false);
    assert.deepEqual(result.models, []);
  }
});

test('incomplete, unsafe, ambiguous or duplicate identities refuse the entire catalog', () => {
  for (const [rows, options] of [
    [[], {}], [null, {}], [[{ id: 'x' }, { id: 'x' }], {}], [[{ id: 'x' }, { id: ' constructor' }], {}],
    [[{ id: 'constructor' }], {}], [[{ id: 42 }], {}], [new Array(1), {}],
    [[{ id: 'x' }], { responseComplete: false }], [[{ id: 'x' }], { responseComplete: undefined }],
    [[{ id: 'x' }], { payload: { data: [{ id: 'x' }], error: { message: 'secret' } } }],
    [[{ id: 'x' }], { payload: { data: [{ id: 'x' }], links: { next: '/api/v1/models?offset=1' } } }],
    [[{ id: 'x' }], { payload: { data: [{ id: 'x' }], total_count: 2, links: { next: null } } }],
    [[{ id: 'x' }], { existingModelIds: ['x', 'x'] }],
  ]) {
    const result = normalize(rows, options);
    assert.equal(result.status, 'failed');
    assert.equal(result.applicable, false);
    assert.deepEqual(result.models, []);
  }
});

test('synthetic getters and proxies are rejected atomically without invoking them', () => {
  let effects = 0;
  const getter = () => { effects++; throw new Error('private getter detail'); };
  const proxy = target => new Proxy(target, {
    get() { effects++; throw new Error('private get detail'); },
    ownKeys() { effects++; throw new Error('private keys detail'); },
    getOwnPropertyDescriptor() { effects++; throw new Error('private descriptor detail'); },
    getPrototypeOf() { effects++; throw new Error('private prototype detail'); },
  });
  const base = () => ({ provider: 'My Gateway', protocol: 'openai-completions', endpoint, source,
    payload: { data: [{ id: 'good', context_length: 10 }, { id: 'other', context_length: 20 }] },
    responseComplete: true, existingModelIds: [] });
  const inputs = [];
  inputs.push(proxy(base()));
  const badPayload = base(); badPayload.payload = proxy(badPayload.payload); inputs.push(badPayload);
  const badRows = base(); badRows.payload.data = proxy(badRows.payload.data); inputs.push(badRows);
  const badRow = base(); badRow.payload.data[1] = proxy(badRow.payload.data[1]); inputs.push(badRow);
  const badSource = base(); badSource.source = proxy(source); inputs.push(badSource);
  const badOptions = base(); Object.defineProperty(badOptions, 'provider', { get: getter, enumerable: true }); inputs.push(badOptions);
  const badNested = base(); Object.defineProperty(badNested.payload.data[1], 'context_length', { get: getter, enumerable: true }); inputs.push(badNested);
  const badUnused = base(); Object.defineProperty(badUnused.payload, 'unrelated', { get: getter, enumerable: true }); inputs.push(badUnused);
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const badRevoked = base(); badRevoked.payload.data[1] = revoked.proxy; inputs.push(badRevoked);
  for (const input of inputs) {
    const result = normalizeOpenRouterCatalog(input);
    assert.equal(result.status, 'failed');
    assert.equal(result.applicable, false);
    assert.deepEqual(result.models, []);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
  assert.equal(effects, 0);
});

test('capacities, provenance and exact identities are conservatively projected', () => {
  for (const invalid of [null, 0, -1, 2.5, '128000', Number.MAX_SAFE_INTEGER + 1]) {
    const row = { id: 'vendor/model', context_length: invalid, top_provider: { max_completion_tokens: invalid } };
    const model = normalize([row]).models[0];
    assert.equal(model.contextWindow.state, 'unknown');
    assert.equal(model.topProviderMaxTokens.state, 'unknown');
    assert.equal(model.maxTokens.state, 'unknown');
  }
  const model = normalize([{ id: 'vendor/model', context_length: 8192, top_provider: { max_completion_tokens: 16384 } }]).models[0];
  assert.equal(model.contextWindow.state, 'conflicting');
  assert.equal(model.topProviderMaxTokens.state, 'conflicting');
  assert.equal(model.maxTokens.state, 'unknown');
  const exact = normalize([{ id: 'vendor/model:free', canonical_slug: 'vendor/model' }], {
    existingModelIds: ['vendor/model'], source: { ...source, apiKey: 'secret-credential', version: 'private-token' },
    apiKey: 'secret-credential',
  });
  assert.equal(exact.models[0].existing, false);
  assert.equal(JSON.stringify(exact).includes('secret-credential'), false);
  assert.equal(JSON.stringify(exact).includes('private-token'), false);
});

test('reasoning signals and invalid declarations never fabricate supported levels', () => {
  for (const reasoning of [
    { mandatory: false }, { mandatory: 'false', supported_efforts: ['high'] },
    { mandatory: false, supported_efforts: [] }, { mandatory: false, supported_efforts: ['none'] },
    { mandatory: false, supported_efforts: ['off', 'high'] }, { mandatory: true, supported_efforts: ['none'] },
  ]) {
    const row = { id: 'model', reasoning, supported_parameters: ['reasoning', 'reasoning_effort'] };
    const field = normalize([row]).models[0].reasoningEfforts;
    assert.notEqual(field.state, 'known');
    assert.equal(field.value, null);
  }
  const valid = normalize([{ id: 'model', reasoning: { mandatory: true, supported_efforts: ['high'] } }]);
  assert.deepEqual(valid.models[0].reasoningEfforts.candidates, ['high']);
  assert.equal(valid.models[0].reasoningEfforts.state, 'unknown');
});

test('dynamic alias targets are never inferred or merged with the concrete model', () => {
  const result = normalize([
    { id: 'vendor/model~latest', alias_target: { slug: 'vendor/model', name: 'Model' }, context_length: 128000 },
    { id: 'vendor/model', context_length: 64000 },
  ], { existingModelIds: ['vendor/model~latest'] });
  assert.deepEqual(result.models.map(model => [model.id, model.existing]), [['vendor/model~latest', true], ['vendor/model', false]]);
  assert.equal(result.models[0].contextWindow.state, 'unknown');
  assert.equal(result.models[1].contextWindow.value, 64000);
});

test('latest IDs are conservatively treated as dynamic even without a target declaration', () => {
  const result = normalize([
    { id: 'vendor/model~latest', context_length: 128000, top_provider: { max_completion_tokens: 8192 },
      reasoning: { mandatory: false, supported_efforts: ['high'] } },
  ], { existingModelIds: ['vendor/model~latest'] });
  const model = result.models[0];
  assert.equal(model.id, 'vendor/model~latest');
  assert.equal(model.existing, true);
  assert.equal(model.contextWindow.state, 'unknown');
  assert.equal(model.maxTokens.state, 'unknown');
  assert.equal(model.topProviderMaxTokens.state, 'unknown');
  assert.equal(model.reasoningEfforts.state, 'unknown');
  assert.equal(Object.hasOwn(model.reasoningEfforts, 'candidates'), false);
  const explicitNull = normalize([{ id: 'vendor/model~latest', alias_target: null, context_length: 42 }]);
  assert.equal(explicitNull.models[0].contextWindow.state, 'unknown');
});

test('the value of the preferred provider is displayed but not applicable to arbitrary routing', () => {
  const model = normalize([{ id: 'model', context_length: 128000, top_provider: { max_completion_tokens: 8192 } }]).models[0];
  assert.deepEqual(model.maxTokens, { state: 'unknown', value: null });
  assert.deepEqual(model.topProviderMaxTokens, {
    state: 'known', value: 8192, scope: 'top-provider', applicable: false,
    source: { ...source, provider: 'My Gateway', url: endpoint },
  });
});
