import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { syncBuiltinESMExports } from 'node:module'

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
    assert.equal(String(url), `${BASE}/models`, 'transport rejects any other network target')
    await state.beforeReply()
    return new Response(JSON.stringify({ data: state.rows }), { headers: { 'content-type': 'application/json' } })
  }
  const fetchReferenceSnapshot = async (...args) => {
    state.referenceCalls.push(args)
    await state.beforeReference()
    return state.referenceResult
  }
  const disposers = registerHttpApi(ctx, {}, { referenceSettings, fetchImpl, fetchReferenceSnapshot })
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

test('enabled reference remains unavailable without starting a worker or inventing data', async () => {
  const f = fakeHost()
  f.state.referenceEnabled = true
  const result = await call(f, '/preview')
  assert.equal(result.status, 200, result.text)
  assert.deepEqual(f.state.referenceCalls, [])
  assert.equal(result.body.sources.reference.status, 'unknown')
  assert.equal(result.body.sources.reference.reason, 'temporarily-unavailable')
  assert.equal(result.text.includes('65536'), false)
  assert.equal(result.text.includes(SECRET), false)
  assert.equal(result.text.includes(BASE), false)
  assert.deepEqual(f.state.writes, [])
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
