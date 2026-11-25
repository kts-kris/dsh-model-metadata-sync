import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'

// Install the worker fake before loading the real HTTP/worker client. This test
// process must never start a real worker or make an anonymous public request.
let workerState
class FakeReferenceWorker extends EventEmitter {
  constructor(entry, options) {
    super()
    const state = workerState
    if (!state) throw Error('missing isolated worker state')
    state.referenceCalls.push({ entry: entry.href, options, worker: this })
    queueMicrotask(async () => {
      try {
        await state.beforeReference()
        this.emit('message', JSON.stringify(state.referenceResult.records))
        if (!this.terminated) this.emit('exit', 0)
      } catch {
        if (!this.terminated) { this.emit('error', Error('synthetic worker error')); this.emit('exit', 1) }
      }
    })
  }
  terminate() {
    this.terminated = true
    queueMicrotask(() => this.emit('exit', 1))
    return Promise.resolve(1)
  }
}
const workerThreads = (await import('node:worker_threads')).default
workerThreads.Worker = FakeReferenceWorker

// This is a synthetic Host/post-admission integration seam, not a live DSH
// carrier, real provider, publication check, or access to a user profile.
// A fake transport is the only permitted network boundary in this process.
for (const [name, methods] of [
  ['node:http', ['request', 'get']], ['node:https', ['request', 'get']],
  ['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']],
  ['node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6']],
]) {
  const module = (await import(name)).default
  for (const method of methods) module[method] = () => { throw new Error('real network forbidden by test') }
}
syncBuiltinESMExports()
const { registerHttpApi } = await import('../lib/http.js')

const BASE = 'https://gateway.example.invalid/tenant-private/v1'
const SECRET = 'synthetic-bearer-unique-1234'
const PROVIDER = 'provider-a'
const FORK = '/dsh-model-metadata-sync'

function fakeHost() {
  const state = {
    revision: 17,
    route: { api: 'openai-completions', baseURL: BASE, apiKeyEnv: 'FAKE_SECRET',
      models: [{ id: 'existing', contextWindow: 4096, maxTokens: null, custom: { private: 'do-not-expose' } }] },
    rows: [{ id: 'existing', context_window: 65536 }, { id: 'new-a' }, { id: 'new-b' }],
    referenceEnabled: false, baseRoute: {},
    network: [], referenceCalls: [], writes: [], referenceResult: { status: 'complete', records: [{ provider: PROVIDER, modelId: 'new-a', observedLimitContext: 65536 }] },
    beforeReply: () => {}, beforeReference: () => {}, descriptor: value => value,
    expectedURL: `${BASE}/models`, payload: null, rawPayload: null,
  }
  const services = {
    llm: {
      listConfigurableProviders: () => [{ provider: PROVIDER, settingsNs: 'llm-fixture', settingsPath: ['providers', PROVIDER] }],
      listProviders: () => [{ id: PROVIDER }],
    },
    settings: {
      describe: () => [state.descriptor({ ns: 'llm-fixture', revision: state.revision, secrets: [], value: { providers: { [PROVIDER]: state.route } },
        user: { providers: { [PROVIDER]: state.userRoute ?? state.route } }, base: { providers: { [PROVIDER]: state.baseRoute } } })],
      mutate: () => state.writes.push('mutate'), update: () => state.writes.push('update'), replace: () => state.writes.push('replace'),
    },
    credentials: { resolve: async ref => { assert.equal(ref, 'FAKE_SECRET'); return { value: SECRET } } },
    modelSync: { sentinel: 'original-untouched' },
  }
  const routes = []
  const ctx = {
    get: key => services[key],
    webServer: { register(route) { routes.push(route); return () => {} } },
    webApp: { getAdvertisedUrl: () => 'http://127.0.0.1:3000' },
    logger: { error() { throw new Error('unexpected logger output') } },
  }
  const referenceSettings = { getReferenceEnabled: () => state.referenceEnabled }
  const fetchImpl = async (url, options) => {
    state.network.push({ url: String(url), options })
    assert.equal(String(url), state.expectedURL, 'transport rejects any other network target')
    await state.beforeReply()
    return new Response(state.rawPayload ?? JSON.stringify(state.payload ?? { data: state.rows }), { headers: { 'content-type': 'application/json' } })
  }
  workerState = state
  const disposers = registerHttpApi(ctx, {}, { referenceSettings, fetchImpl })
  return { state, services, routes, disposers }
}

async function call(fixture, suffix, { method = 'POST', text = JSON.stringify({ provider: PROVIDER, selectedNewIds: [] }), headers = {}, peer } = {}) {
  const route = fixture.routes.find(row => row.path === FORK + suffix)
  assert.ok(route)
  const req = Readable.from([Buffer.from(text)])
  Object.assign(req, { method, headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000',
    'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers } })
  const response = { text: '' }
  const res = { writeHead(status, responseHeaders) { response.status = status; response.headers = responseHeaders; return this },
    end(value = '') { response.text += value; return this } }
  await route.handler(req, res, peer ?? { principal: { kind: 'owner' }, signal: new AbortController().signal })
  response.body = JSON.parse(response.text)
  return response
}

test('authenticated route previews the real Host discovery of multiple models without writes', async () => {
  const f = fakeHost()
  const status = await call(f, '/status', { method: 'GET' })
  assert.deepEqual(status.body, { providers: [{ id: PROVIDER, status: 'unknown', lastAttemptAt: null }], referenceEnabled: false })
  const response = await call(f, '/preview')
  assert.equal(response.status, 200, response.text)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.body.provider, PROVIDER)
  assert.equal(response.body.revision, 17)
  assert.deepEqual(response.body.items.map(row => [row.modelId, row.existing]), [['existing', true], ['new-a', false], ['new-b', false]])
  assert.equal(response.body.items[0].fields.find(field => field.field === 'contextWindow').before, 4096)
  assert.equal(response.body.items[0].fields.find(field => field.field === 'contextWindow').state, 'unknown')
  assert.equal(response.body.sources.upstream.status, 'success')
  assert.equal(response.body.sources.reference.status, 'disabled')
  assert.equal(response.body.writeEnabled, false)
  assert.deepEqual(response.body.changes, [])
  assert.ok(response.body.previewId && response.body.digest && response.body.expiresAt)
  assert.deepEqual(f.state.network.map(row => row.url), [`${BASE}/models`])
  assert.equal(new Headers(f.state.network[0].options.headers).get('authorization'), `Bearer ${SECRET}`)
  assert.deepEqual(f.state.referenceCalls, [])
  assert.deepEqual(f.state.writes, [])
  assert.deepEqual(f.services.modelSync, { sentinel: 'original-untouched' })
  for (const secret of [BASE, SECRET, 'FAKE_SECRET', 'do-not-expose', 'baseURL', 'custom']) assert.equal(response.text.includes(secret), false)
})

test('OpenRouter official listing reaches the read-only HTTP preview with scoped evidence', async () => {
  const f = fakeHost()
  f.state.route.baseURL = 'https://openrouter.ai/api/v1'
  f.state.expectedURL = 'https://openrouter.ai/api/v1/models'
  f.state.route.models = [{ id: 'vendor/model' }]
  f.state.payload = { data: [
    { id: 'vendor/model', context_length: 128000, top_provider: { max_completion_tokens: 8192 },
      reasoning: { mandatory: false, supported_efforts: ['low', 'high'] } },
    { id: 'vendor/model~latest', context_length: 999999 },
  ], links: { next: null }, total_count: 2 }
  const response = await call(f, '/preview')
  assert.equal(response.status, 200, response.text)
  const [model, alias] = response.body.items
  assert.equal(model.modelId, 'vendor/model')
  assert.equal(model.existing, true)
  const context = model.fields.find(field => field.field === 'contextWindow')
  const output = model.fields.find(field => field.field === 'maxTokens')
  const effort = model.fields.find(field => field.field === 'reasoningEfforts')
  assert.equal(context.candidate, 128000)
  assert.equal(context.state, 'unknown')
  assert.deepEqual(output.candidate, { value: 8192, scope: 'top-provider', applicable: false })
  assert.equal(output.state, 'unknown')
  assert.deepEqual(effort.candidate, { values: ['low', 'high'], scope: 'gateway-declared', applicable: false })
  assert.equal(effort.state, 'unknown')
  for (const field of [context, output, effort]) {
    assert.equal(field.source.kind, 'upstream')
    assert.equal(field.source.origin, 'https://openrouter.ai')
    assert.equal(field.source.url, f.state.expectedURL)
    assert.ok(/^\d{4}-\d\d-\d\dT.*Z$/.test(field.source.fetchedAt))
  }
  assert.equal(alias.fields.find(field => field.field === 'contextWindow').candidate, undefined)
  assert.equal(response.body.writeEnabled, false)
  assert.equal(response.body.authority, 'unavailable')
  assert.deepEqual(response.body.changes, [])
  assert.deepEqual(f.state.referenceCalls, [])
  assert.deepEqual(f.state.writes, [])
  for (const secret of [SECRET, 'FAKE_SECRET']) assert.equal(response.text.includes(secret), false)
})

test('OpenRouter incomplete listings and reflected secrets never reach preview', async t => {
  const row = { id: 'vendor/model', context_length: 1024 }
  for (const [name, rawPayload] of [
    ['pagination', JSON.stringify({ data: [row], links: { next: '?offset=1' }, total_count: 1 })],
    ['wrong count', JSON.stringify({ data: [row], links: { next: null }, total_count: 2 })],
    ['unknown pagination', JSON.stringify({ data: [row], links: { next: null }, total_count: 1, offset: 1 })],
    ['error', JSON.stringify({ data: [row], links: { next: null }, total_count: 1, errors: ['failure'] })],
    ['duplicate keys', '{"data":[{"id":"vendor/model","\\u0069d":"other"}],"links":{"next":null},"total_count":1}'],
    ['duplicate ids', JSON.stringify({ data: [row, row], links: { next: null }, total_count: 2 })],
    ['reflected endpoint', JSON.stringify({ data: [{ id: 'https://openrouter.ai/api/v1/models' }], links: { next: null }, total_count: 1 })],
    ['reflected bearer', JSON.stringify({ data: [{ id: SECRET }], links: { next: null }, total_count: 1 })],
    ['reflected candidate', JSON.stringify({ data: [{ id: 'vendor/model', reasoning: { mandatory: false, supported_efforts: ['openrouter.ai'] } }], links: { next: null }, total_count: 1 })],
  ]) await t.test(name, async () => {
    const f = fakeHost()
    f.state.route.baseURL = 'https://openrouter.ai/api/v1'
    f.state.expectedURL = 'https://openrouter.ai/api/v1/models'
    f.state.rawPayload = rawPayload
    const response = await call(f, '/preview')
    assert.notEqual(response.status, 200, response.text)
    assert.equal('items' in response.body, false)
    assert.equal(response.text.includes(SECRET), false)
    assert.deepEqual(f.state.writes, [])
    assert.deepEqual(f.state.referenceCalls, [])
  })
})

test('fixed official provenance cannot reflect a short bearer', async () => {
  const f = fakeHost()
  f.state.route.baseURL = 'https://openrouter.ai/api/v1'
  f.state.expectedURL = 'https://openrouter.ai/api/v1/models'
  f.services.credentials.resolve = async () => ({ value: 'openrouter.ai' })
  f.state.payload = { data: [{ id: 'model', context_length: 1024 }], links: { next: null }, total_count: 1 }
  const response = await call(f, '/preview')
  assert.notEqual(response.status, 200)
  assert.equal(response.text.includes('openrouter.ai'), false)
  assert.deepEqual(f.state.writes, [])
})

test('selection is explicitly previewed in upstream order but never authorizes apply', async () => {
  const f = fakeHost()
  const first = await call(f, '/preview')
  const second = await call(f, '/preview', { text: JSON.stringify({ provider: PROVIDER, selectedNewIds: ['new-b', 'new-a'] }) })
  assert.equal(second.status, 200, second.text)
  assert.deepEqual(second.body.selectedNewIds, ['new-a', 'new-b'])
  assert.deepEqual(second.body.changes, [{ type: 'add-model', modelId: 'new-a' }, { type: 'add-model', modelId: 'new-b' }])
  assert.notEqual(first.body.previewId, second.body.previewId)
  assert.notEqual(first.body.digest, second.body.digest)
  assert.equal(second.body.writeEnabled, false)
  assert.equal(second.body.authority, 'unavailable')
  assert.ok(Date.parse(second.body.expiresAt) > Date.now())
  assert.ok(Date.parse(second.body.expiresAt) <= Date.now() + 300000)
  const apply = await call(f, '/apply', { text: JSON.stringify({ previewId: second.body.previewId, digest: second.body.digest }) })
  assert.equal(apply.status, 503)
  assert.equal(apply.body.error.code, 'AUTHORITY_UNAVAILABLE')
  assert.deepEqual(f.state.writes, [])
})

test('schema-derived models are not proof of an explicit user list', async () => {
  const f = fakeHost()
  f.state.userRoute = { api: 'openai-completions' }
  const result = await call(f, '/preview')
  assert.equal(result.status, 200, result.text)
  assert.deepEqual(result.body.items.map(row => [row.modelId, row.existing, row.reason]), [
    ['existing', null, 'inventory-unknown'], ['new-a', null, 'inventory-unknown'], ['new-b', null, 'inventory-unknown'],
  ])
  const selected = await call(f, '/preview', { text: JSON.stringify({ provider: PROVIDER, selectedNewIds: ['new-a'] }) })
  assert.equal(selected.status, 422)
  assert.equal(selected.body.error.code, 'INVALID_RESPONSE')
  assert.deepEqual(f.state.writes, [])
})

test('a user-only route has known inventory only when inheritance is provably absent', async t => {
  for (const [name, change, known] of [
    ['empty provider map', d => { d.base = { providers: {} } }, true],
    ['empty base root', d => { d.base = {} }, true],
    ['missing base descriptor', d => { delete d.base }, false],
    ['invalid base root', d => { d.base = [] }, false],
    ['invalid intermediate path', d => { d.base = { providers: null } }, false],
    ['base route getter is unreadable', d => {
      Object.defineProperty(d.base.providers, PROVIDER, { enumerable: true, get() { throw Error('must not run') } })
    }, false],
    ['base proxy is unreadable', d => { d.base = new Proxy({}, { ownKeys() { throw Error('must not run') } }) }, false],
    ['non-enumerable base route is unreadable', d => {
      Object.defineProperty(d.base.providers, PROVIDER, { enumerable: false, value: {} })
    }, false],
    ['user and value identities disagree', d => { d.user.providers[PROVIDER] = { models: ['different'] } }, false],
    ['base route has overrides', d => { d.base = { providers: { [PROVIDER]: { modelOverrides: {} } } } }, false],
    ['user route has overrides', d => { d.user.providers[PROVIDER] = { ...d.user.providers[PROVIDER], modelOverrides: {} } }, false],
  ]) await t.test(name, async () => {
    const f = fakeHost()
    f.state.descriptor = d => { change(d); return d }
    const response = await call(f, '/preview')
    assert.equal(response.status, 200, response.text)
    assert.deepEqual(response.body.items.map(row => row.existing), known ? [true, false, false] : [null, null, null])
    const selected = await call(f, '/preview', { text: JSON.stringify({ provider: PROVIDER, selectedNewIds: ['new-a'] }) })
    assert.equal(selected.status, known ? 200 : 422, selected.text)
    if (known) assert.deepEqual(selected.body.changes, [{ type: 'add-model', modelId: 'new-a' }])
    assert.deepEqual(f.state.writes, [])
  })
})

test('disposing the registered preview aborts every in-flight upstream request and blocks late results', async () => {
  const f = fakeHost()
  f.state.referenceEnabled = true
  let release, entered
  const pendingTransport = new Promise(resolve => { release = resolve })
  const bothStarted = new Promise(resolve => { entered = resolve })
  f.state.beforeReply = () => { if (f.state.network.length === 2) entered(); return pendingTransport }
  const pending = [call(f, '/preview'), call(f, '/preview')]
  try {
    await bothStarted
    const signals = f.state.network.map(row => row.options.signal)
    assert.deepEqual(signals.map(signal => signal.aborted), [false, false])
    f.disposers[0]()
    assert.deepEqual(signals.map(signal => signal.aborted), [true, true], 'unmount must synchronously abort transport')
    const responses = await Promise.all(pending)
    assert.deepEqual(responses.map(result => result.status), [502, 502])
    assert.ok(responses.every(result => !('previewId' in result.body)))
    assert.deepEqual(f.state.referenceCalls, [])
    assert.deepEqual(f.state.writes, [])
  } finally {
    release()
    await Promise.all(pending)
  }
})

test('owner cancellation aborts transport and no late discovery becomes a preview', async () => {
  const f = fakeHost()
  let release, entered
  const waiting = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  f.state.beforeReply = () => { entered(); return waiting }
  const owner = new AbortController()
  const pending = call(f, '/preview', { peer: { principal: { kind: 'owner' }, signal: owner.signal } })
  try {
    await started
    owner.abort()
    assert.equal(f.state.network[0].options.signal.aborted, true)
    const result = await pending
    assert.equal(result.status, 401)
    assert.equal(result.body.error.code, 'AUTH_REQUIRED')
    assert.equal('previewId' in result.body, false)
  } finally {
    release()
    await pending
    f.disposers[0]()
  }
  assert.deepEqual(f.state.writes, [])
  assert.deepEqual(f.state.referenceCalls, [])
})

test('enabled reference starts only the anonymous fixed worker but cannot invent values', async () => {
  const f = fakeHost()
  f.state.referenceEnabled = true
  const result = await call(f, '/preview')
  assert.equal(result.status, 200, result.text)
  assert.equal(f.state.referenceCalls.length, 1)
  const [{ entry, options }] = f.state.referenceCalls
  assert.equal(entry.endsWith('/lib/reference-worker-entry.js'), true)
  assert.deepEqual(options.env, {})
  assert.equal(Object.hasOwn(options, 'workerData'), false)
  assert.doesNotMatch(JSON.stringify(options), /provider-a|new-a|completions|gateway|synthetic-bearer/)
  assert.equal(result.body.sources.reference.status, 'unknown')
  assert.equal(result.text.includes('65536'), false)
  assert.equal(result.text.includes(SECRET), false)
  assert.equal(result.text.includes(BASE), false)
  assert.deepEqual(f.state.writes, [])
})

test('peer abort terminates the active anonymous worker and forbids a late preview', async () => {
  const f = fakeHost(); f.state.referenceEnabled = true
  let release, entered
  const waiting = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  f.state.beforeReference = () => { entered(); return waiting }
  const owner = new AbortController()
  const pending = call(f, '/preview', { peer: { principal: { kind: 'owner' }, signal: owner.signal } })
  try {
    await started
    const worker = f.state.referenceCalls[0].worker
    owner.abort()
    assert.equal(worker.terminated, true)
    const result = await pending
    assert.equal(result.status, 401)
    assert.equal('previewId' in result.body, false)
    assert.deepEqual(f.state.writes, [])
  } finally { release(); await pending; f.disposers[0]() }
})

test('disposing cancels the active worker; a parallel busy request cannot cancel its owner', async () => {
  const f = fakeHost(); f.state.referenceEnabled = true
  let release, entered
  const waiting = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  f.state.beforeReference = () => { entered(); return waiting }
  const first = call(f, '/preview')
  try {
    await started
    const second = await call(f, '/preview')
    assert.equal(second.status, 200)
    assert.equal(second.body.sources.reference.status, 'unknown')
    assert.equal(f.state.referenceCalls.length, 1)
    const worker = f.state.referenceCalls[0].worker
    assert.notEqual(worker.terminated, true)
    f.disposers[0]()
    assert.equal(worker.terminated, true)
    const result = await first
    assert.equal(result.status, 502)
    assert.equal('previewId' in result.body, false)
    assert.deepEqual(f.state.writes, [])
  } finally { release(); await first }
})

test('disabling reference during lookup refuses publication and prevents future workers', async () => {
  const f = fakeHost(); f.state.referenceEnabled = true
  let release, entered
  const waiting = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  f.state.beforeReference = () => { entered(); return waiting }
  const pending = call(f, '/preview')
  try {
    await started
    f.state.referenceEnabled = false
    release()
    const result = await pending
    assert.equal(result.status, 409)
    assert.equal(result.body.error.code, 'REVISION_CONFLICT')
    assert.equal('previewId' in result.body, false)
    const next = await call(f, '/preview')
    assert.equal(next.status, 200)
    assert.equal(next.body.sources.reference.status, 'disabled')
    assert.equal(f.state.referenceCalls.length, 1)
    assert.deepEqual(f.state.writes, [])
  } finally { release(); await pending; f.disposers[0]() }
})

test('strict bodies reject forged fields, duplicates, encoding and invalid selections', async () => {
  const f = fakeHost()
  for (const text of [
    '{"provider":"provider-a","selectedNewIds":[],"proof":true}',
    '{"provider":"provider-a","provider":"provider-a","selectedNewIds":[]}',
    '{"provider":"provider-a","\\u0070rovider":"provider-a","selectedNewIds":[]}',
    '{"provider":"provider-a","selectedNewIds":["new-a","new-a"]}',
    '{"provider":"provider-a","selectedNewIds":[],"endpoint":"https://attacker.invalid"}',
    '{"provider":"provider-a","selectedNewIds":[]} trailing',
    JSON.stringify({ provider: PROVIDER, selectedNewIds: [] }) + ' '.repeat(256 * 1024),
  ]) {
    const response = await call(f, '/preview', { text })
    assert.equal(response.status, 422, text.slice(0, 100))
    assert.equal(response.body.error.code, 'INVALID_RESPONSE')
  }
  for (const id of ['existing', 'not-advertised']) {
    const response = await call(f, '/preview', { text: JSON.stringify({ provider: PROVIDER, selectedNewIds: [id] }) })
    assert.equal(response.status, 422)
  }
  const badHeader = await call(f, '/preview', { headers: { 'content-type': 'text/plain' } })
  assert.equal(badHeader.status, 422)
  assert.deepEqual(f.state.writes, [])
})

test('known bearer, private target, and raw descriptors are never reflected', async () => {
  for (const id of [`model-${SECRET}`, 'tenant-private', 'gateway.example.invalid']) {
    const f = fakeHost(); f.state.rows = [{ id }]
    const response = await call(f, '/preview')
    assert.equal(response.status, 422)
    assert.equal(response.body.error.code, 'INVALID_RESPONSE')
    for (const value of [SECRET, BASE, id]) assert.equal(response.text.includes(value), false)
  }
})

test('unsupported protocols and revisions changed during discovery fail safely', async () => {
  const f = fakeHost()
  f.state.route.api = 'openai-responses'
  assert.equal((await call(f, '/preview')).body.error.code, 'UNSUPPORTED_PROTOCOL')
  assert.equal(f.state.network.length, 0)
  f.state.route.api = 'openai-completions'
  f.state.beforeReply = () => { f.state.revision++ }
  assert.equal((await call(f, '/preview')).body.error.code, 'REVISION_CONFLICT')
  f.state.beforeReply = () => {}
  assert.deepEqual(f.state.writes, [])
})
