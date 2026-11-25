import test from 'node:test'
import assert from 'node:assert/strict'
import { createHostRuntime } from '../lib/host-runtime.js'
import { catalogMatchesTarget } from '../lib/metadata-source.js'

// All paths, credentials, Host services, and transport data are synthetic.
const SECRET = 'synthetic-bearer-0123456789'
const REF = 'SYNTHETIC_TOKEN'
const BASE = 'https://relay.example.invalid/private-tenant/v1'
const ENDPOINT = `${BASE}/models`
const protocol = 'openai-completions'
const target = { provider: 'sample', endpoint: ENDPOINT, protocol }
const entry = () => ({ provider: 'sample', displayName: 'Sample', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'sample'] })
const profile = () => ({ api: protocol, baseURL: BASE, apiKeyEnv: REF, models: [{ id: 'old', custom: { preserve: false } }] })
const json = rows => new Response(JSON.stringify({ data: rows }), { headers: { 'content-type': 'application/json' } })

function fakeHost() {
  const state = {
    directory: [entry()], revision: 8, section: { providers: { sample: profile() } }, secrets: [],
    credential: SECRET, requests: [], resolves: [], describes: [], writes: 0,
    respond: () => json([{ id: 'old' }, { id: 'new' }]),
  }
  const ctx = {
    get(name) { return this[name] },
    llm: { listConfigurableProviders: () => state.directory, listProviders: () => [{ id: 'sample', name: 'Sample' }], stream: () => { state.writes++ } },
    settings: {
      describe: options => { state.describes.push(options); return [{ ns: 'llm-pi-ai', value: state.section, revision: state.revision, secrets: state.secrets }] },
      mutate: () => { state.writes++ }, update: () => { state.writes++ }, replace: () => { state.writes++ },
    },
    credentials: { resolve: async ref => { state.resolves.push(ref); return { value: state.credential, source: 'fake' } } },
  }
  const runtime = createHostRuntime(ctx, { fetchImpl: async (url, options) => {
    state.requests.push({ url: String(url), options })
    return state.respond(url, options)
  } })
  return { runtime, state, ctx }
}

const code = result => result?.error?.code

test('status reads optional services without touching uninjected Cordis properties', async () => {
  const f = fakeHost()
  let directAccesses = 0
  const ctx = {
    get(name) { return f.ctx[name] },
    get llm() { directAccesses++; throw Error('llm is not injected') },
    get settings() { directAccesses++; throw Error('settings is not injected') },
  }
  const status = await createHostRuntime(ctx).status()
  assert.deepEqual(status, { status: 'available', providers: [{ id: 'sample', status: 'unknown', lastAttemptAt: null }] })
  assert.equal(directAccesses, 0)
})

test('discovery reads all optional services without touching uninjected Cordis properties', async () => {
  const f = fakeHost()
  let directAccesses = 0
  const ctx = {
    get(name) { return f.ctx[name] },
    get llm() { directAccesses++; throw Error('llm is not injected') },
    get settings() { directAccesses++; throw Error('settings is not injected') },
    get credentials() { directAccesses++; throw Error('credentials is not injected') },
  }
  const result = await createHostRuntime(ctx, { fetchImpl: async () => json([{ id: 'old' }]) }).discover('sample')
  assert.equal(result.status, 'complete')
  assert.equal(directAccesses, 0)
})

test('read-only discovery uses the exact configured source and credential, retaining Host catalog identity', async () => {
  const { runtime, state } = fakeHost()
  const catalogResult = await runtime.discover('sample')
  assert.equal(catalogResult.status, 'complete')
  assert.equal(catalogResult.revision, 8)
  assert.equal(catalogResult.inventory, 'unknown', 'missing user layer cannot prove an explicit list')
  assert.deepEqual(catalogResult.effective, { status: 'unknown', inventoryComplete: false })
  assert.deepEqual(catalogResult.catalog.models.map(m => [m.id, m.existing]), [['old', true], ['new', false]])
  assert.equal(catalogMatchesTarget(catalogResult.catalog, target), true)
  assert.equal(catalogMatchesTarget(structuredClone(catalogResult.catalog), target), false)
  assert.deepEqual(state.requests.map(r => r.url), [ENDPOINT])
  assert.equal(new Headers(state.requests[0].options.headers).get('authorization'), `Bearer ${SECRET}`)
  assert.ok(state.resolves.length >= 1 && state.resolves.every(ref => ref === REF))
  assert.ok(state.describes.every(options => options?.redactSecrets === true))
  assert.equal(state.writes, 0)
})

test('status is a safe projection of a configured, registered provider, not a descriptor or catalog', async () => {
  const { runtime, state } = fakeHost()
  state.directory[0].private = { authorization: SECRET, endpoint: BASE }
  const status = await runtime.status()
  assert.deepEqual(status, { status: 'available', providers: [{ id: 'sample', status: 'unknown', lastAttemptAt: null }] })
  assert.doesNotMatch(JSON.stringify(status), /relay|synthetic|authorization|baseURL|credential/i)
  assert.deepEqual(state.requests, [])
  assert.deepEqual(state.resolves, [])
  assert.equal(state.writes, 0)
})

test('provider IDs are exact strings, including names that are not model IDs', async () => {
  const { runtime, state } = fakeHost()
  const provider = 'constructor'
  state.directory[0].provider = provider
  assert.equal((await runtime.discover(provider)).status, 'complete')
})

test('unknown, non-string, duplicate and case-mismatched provider identity fail closed', async () => {
  const { runtime, state } = fakeHost()
  for (const request of ['Sample', '', null, { provider: 'sample', baseURL: 'https://attacker.invalid' }]) {
    assert.equal(code(await runtime.discover(request)), 'UNKNOWN_SOURCE')
  }
  state.directory.push(entry())
  assert.equal(code(await runtime.discover('sample')), 'AMBIGUOUS_IDENTITY')
  assert.equal(state.requests.length, 0)
  assert.equal(state.resolves.length, 0)
})

test('configured directory address, never defaults or caller-added source arguments, selects the profile', async () => {
  const { runtime, state } = fakeHost()
  state.directory[0].defaultBaseURL = 'https://attacker.invalid/v1'
  delete state.section.providers.sample.baseURL
  assert.equal(code(await runtime.discover('sample', { baseURL: 'https://attacker.invalid', apiKey: 'attacker' })), 'UNKNOWN_SOURCE')
  assert.equal(state.requests.length, 0)
  state.section.providers.sample.baseURL = BASE
  assert.equal((await runtime.discover('sample', { baseURL: 'https://attacker.invalid', apiKey: 'attacker' })).status, 'complete')
  assert.equal(state.requests[0].url, ENDPOINT)
  assert.equal(new Headers(state.requests[0].options.headers).get('authorization'), `Bearer ${SECRET}`)
})

test('missing settings, duplicate namespaces, or service failures remain actionable errors', async t => {
  for (const mode of ['directory-throw', 'settings-throw', 'no-descriptor', 'duplicate-descriptor', 'missing-secret-sidecar']) {
    await t.test(mode, async () => {
      const { runtime, ctx, state } = fakeHost()
      if (mode === 'directory-throw') ctx.llm.listConfigurableProviders = () => { throw new Error(`secret ${SECRET}`) }
      if (mode === 'settings-throw') ctx.settings.describe = () => { throw new Error(`secret ${SECRET}`) }
      if (mode === 'no-descriptor') ctx.settings.describe = () => []
      if (mode === 'duplicate-descriptor') ctx.settings.describe = () => [
        { ns: 'llm-pi-ai', revision: 8, value: state.section, secrets: [] },
        { ns: 'llm-pi-ai', revision: 8, value: state.section, secrets: [] },
      ]
      if (mode === 'missing-secret-sidecar') ctx.settings.describe = () => [{ ns: 'llm-pi-ai', revision: 8, value: state.section }]
      const result = await runtime.discover('sample')
      assert.equal(code(result), 'SETTINGS_UNAVAILABLE')
      assert.equal(JSON.stringify(result).includes(SECRET), false)
      assert.equal(state.requests.length, 0)
    })
  }
})

test('unsafe directory paths, redacted target secrets, custom headers and unsupported protocols refuse before credential use', async t => {
  const cases = [
    ['unsafe path', f => { f.state.directory[0].settingsPath = ['providers', '__proto__'] }, 'UNKNOWN_SOURCE'],
    ['unsafe namespace', f => { f.state.directory[0].settingsNs = '__proto__' }, 'UNKNOWN_SOURCE'],
    ['redacted route', f => { f.state.secrets = [{ path: ['providers', 'sample', 'headers'], set: true }] }, 'UNKNOWN_SOURCE'],
    ['headers', f => { f.state.section.providers.sample.headers = { 'x-private': SECRET } }, 'UNKNOWN_SOURCE'],
    ['headers proxy', f => { f.state.section.providers.sample.headers = new Proxy({}, {}) }, 'SETTINGS_UNAVAILABLE'],
    ['disguised Headers', f => { const h = new Headers({ 'x-private': SECRET }); Object.setPrototypeOf(h, Object.prototype); f.state.section.providers.sample.headers = h }, 'SETTINGS_UNAVAILABLE'],
    ['disguised Map', f => { const h = new Map([['x-private', SECRET]]); Object.setPrototypeOf(h, Object.prototype); f.state.section.providers.sample.headers = h }, 'SETTINGS_UNAVAILABLE'],
    ['protocol', f => { f.state.section.providers.sample.api = 'openai-responses' }, 'UNSUPPORTED_PROTOCOL'],
    ['conflicting references', f => { f.state.section.providers.sample.credentialRef = 'OTHER_KEY' }, 'UNKNOWN_SOURCE'],
    ['invalid reference', f => { f.state.section.providers.sample.apiKeyEnv = 'not a ref' }, 'UNKNOWN_SOURCE'],
  ]
  for (const [name, alter, expected] of cases) await t.test(name, async () => {
    const f = fakeHost(); alter(f)
    const result = await f.runtime.discover('sample')
    assert.equal(code(result), expected)
    assert.equal(JSON.stringify(result).includes(SECRET), false)
    assert.equal(f.state.requests.length, 0)
    assert.equal(f.state.resolves.length, 0)
  })
})

test('a malicious getter or proxy cannot run while copying Host snapshot data', async t => {
  for (const kind of ['route-getter', 'nested-getter', 'route-proxy', 'array-proxy']) await t.test(kind, async () => {
    const f = fakeHost(); let invoked = 0
    const route = f.state.section.providers.sample
    if (kind === 'route-getter') Object.defineProperty(route, 'baseURL', { enumerable: true, get() { invoked++; return BASE } })
    if (kind === 'nested-getter') Object.defineProperty(route.models[0].custom, 'hidden', { enumerable: true, get() { invoked++; return SECRET } })
    if (kind === 'route-proxy') f.state.section.providers.sample = new Proxy(route, { get() { invoked++; throw Error('trap') } })
    if (kind === 'array-proxy') route.models = new Proxy(route.models, { get() { invoked++; throw Error('trap') } })
    assert.notEqual((await f.runtime.discover('sample')).status, 'complete')
    assert.equal(invoked, 0)
    assert.equal(f.state.requests.length, 0)
    assert.equal(f.state.resolves.length, 0)
  })
})

test('changes in revision, directory target, or route during network discovery reject the result', async t => {
  for (const mode of ['revision', 'route-same-revision', 'directory']) await t.test(mode, async () => {
    const f = fakeHost(); let release, started
    const waiting = new Promise(resolve => { release = resolve })
    const entered = new Promise(resolve => { started = resolve })
    f.state.respond = async () => { started(); await waiting; return json([{ id: 'old' }]) }
    const pending = f.runtime.discover('sample')
    await entered
    if (mode === 'revision') f.state.revision++
    if (mode === 'route-same-revision') f.state.section.providers.sample.models[0].custom.preserve = true
    if (mode === 'directory') f.state.directory[0].settingsPath = ['providers', 'other']
    release()
    const result = await pending
    assert.equal(code(result), 'REVISION_CONFLICT')
    assert.equal('catalog' in result, false)
    assert.equal(f.state.writes, 0)
  })
})

test('a changed route during credential resolution is rejected before transport', async () => {
  const f = fakeHost(); let release, started
  const waiting = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { started = resolve })
  f.ctx.credentials.resolve = async () => { started(); await waiting; return { value: SECRET, source: 'fake' } }
  const pending = f.runtime.discover('sample')
  await entered
  f.state.section.providers.sample.baseURL = 'https://attacker.invalid/v1'
  f.state.revision++
  release()
  assert.equal(code(await pending), 'REVISION_CONFLICT')
  assert.equal(f.state.requests.length, 0)
})

test('credential and endpoint reflection, invalid responses, and transport failures never become empty success', async t => {
  for (const [name, response, expected] of [
    ['credential reflection', () => json([{ id: `model-${SECRET}` }]), 'INVALID_RESPONSE'],
    ['endpoint reflection', () => json([{ id: 'model-private-tenant' }]), 'INVALID_RESPONSE'],
    ['empty', () => json([]), 'INVALID_RESPONSE'],
    ['invalid-json', () => new Response('{'), 'INVALID_RESPONSE'],
    ['transport', () => { throw Error(`transport ${SECRET} ${BASE}`) }, 'INCOMPLETE_RESPONSE'],
  ]) await t.test(name, async () => {
    const f = fakeHost(); f.state.respond = response
    const result = await f.runtime.discover('sample')
    assert.equal(result.status, 'failed')
    assert.equal(code(result), expected)
    assert.equal('catalog' in result, false)
    for (const forbidden of [SECRET, BASE, REF]) assert.equal(JSON.stringify(result).includes(forbidden), false)
  })
})

test('implicit model inventory stays unknown and no writable or client-facing catalog API is exposed', async () => {
  const f = fakeHost()
  delete f.state.section.providers.sample.models
  const result = await f.runtime.discover('sample')
  assert.equal(result.status, 'complete')
  assert.equal(result.inventory, 'unknown')
  assert.deepEqual(result.effective, { status: 'unknown', inventoryComplete: false })
  assert.deepEqual(Object.keys(f.runtime).sort(), ['discover', 'status'])
  assert.equal(f.runtime.preview, undefined)
  assert.equal(f.runtime.apply, undefined)
  assert.equal(f.state.writes, 0)
})
