import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { registerMetadataAuthority } from '../lib/routes/metadata-authority.js'

// Entirely synthetic Host services and transport: no profile, network or secrets.
const BASE = 'https://relay.example.invalid/private-tenant/v1'
const SECRET = 'synthetic-bearer-0123456789'
const REF = 'SYNTHETIC_TOKEN'
const FORK = '/dsh-model-metadata-sync'
const OWNER = Object.freeze({})
const OTHER = Object.freeze({})
const livePeer = (key = 'owner') => ({ principal: { kind: 'owner' }, signal: new AbortController().signal, key })

function fixture({ safety = () => true, ownerFromPeer = p => p.key === 'owner' ? OWNER : p.key === 'other' ? OTHER : null } = {}) {
  const state = {
    revision: 7,
    user: { providers: { sample: { api: 'openai-completions', baseURL: BASE, apiKeyEnv: REF,
      models: [{ id: 'old', input: null, reasoningEfforts: false, opaque: { keep: false } }] } }, unrelated: { keep: null } },
    base: { providers: { sample: {} } }, calls: [], requests: [], rows: [{ id: 'new-b' }, { id: 'old' }, { id: 'new-a' }], plugins: [],
  }
  const services = {
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', revision: state.revision, applies: 'live',
        user: structuredClone(state.user), value: structuredClone(state.user), base: structuredClone(state.base), secrets: [] }],
      async mutate(ns, ops, revision) {
        state.calls.push({ ns, ops: structuredClone(ops), revision })
        assert.equal(revision, state.revision)
        for (const op of ops) {
          let node = state.user
          for (const key of op.path.slice(0, -1)) node = node[key]
          node[op.path.at(-1)] = structuredClone(op.value)
        }
        state.revision++
      },
    },
    pluginManager: { listPlugins: async () => state.plugins },
    llm: { listConfigurableProviders: () => [{ provider: 'sample', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'sample'] }] },
    credentials: { resolve: async () => ({ value: SECRET }) },
    modelSync: { untouched: true },
  }
  const routes = new Map()
  const ctx = {
    get: name => services[name],
    webApp: { getAdvertisedUrl: () => 'http://127.0.0.1:3000' },
    webServer: { register(route) { assert.equal(routes.has(route.path), false); routes.set(route.path, route); return () => routes.delete(route.path) } },
  }
  const dispose = registerMetadataAuthority(ctx, {
    ownerFromPeer, previewSafety: safety,
    fetchImpl: async (url, options) => {
      assert.equal(String(url), `${BASE}/models`)
      state.requests.push({ url: String(url), authorization: new Headers(options.headers).get('authorization') })
      return new Response(JSON.stringify({ data: state.rows }), { headers: { 'content-type': 'application/json' } })
    },
  })
  return { state, services, routes, dispose }
}

async function call(f, suffix, { text, chunks, method = 'POST', headers = {}, peer = livePeer() } = {}) {
  const route = f.routes.get(FORK + suffix)
  assert.ok(route, suffix)
  const req = Readable.from(chunks ?? [Buffer.from(text ?? '{}')])
  Object.assign(req, { method, headers: { origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers } })
  const response = { text: '' }
  const res = { writeHead(status, headers) { response.status = status; response.headers = headers; return this },
    end(body = '') { response.text += body; return this } }
  await route.handler(req, res, peer)
  response.body = JSON.parse(response.text)
  return response
}
const preview = (f, extra) => call(f, '/preview', { text: JSON.stringify({ provider: 'sample', selectedNewIds: ['new-a', 'new-b'] }), ...extra })
const confirm = (f, p, extra) => call(f, '/apply', { text: JSON.stringify({ previewId: p.previewId, digest: p.digest }), ...extra })

test('registered owner preview and confirmation append exactly the selected IDs', async t => {
  const f = fixture(); t.after(() => f.dispose())
  for (const route of f.routes.values()) assert.equal(route.auth, 'required')
  const p = await preview(f)
  assert.equal(p.status, 200, p.text)
  assert.equal(p.headers['cache-control'], 'no-store')
  assert.deepEqual(p.body.changes, [{ type: 'add-model', modelId: 'new-b' }, { type: 'add-model', modelId: 'new-a' }])
  assert.deepEqual(f.state.calls, [])
  const result = await confirm(f, p.body)
  assert.equal(result.status, 200, result.text)
  assert.equal(result.body.status, 'applied')
  assert.deepEqual(f.state.user.providers.sample.models, [
    { id: 'old', input: null, reasoningEfforts: false, opaque: { keep: false } }, { id: 'new-b' }, { id: 'new-a' },
  ])
  assert.deepEqual(f.state.user.unrelated, { keep: null })
  assert.equal(f.state.calls.length, 1)
  assert.deepEqual(f.services.modelSync, { untouched: true })
  for (const forbidden of [SECRET, REF, BASE, 'private-tenant', 'relay.example.invalid']) assert.equal(p.text.includes(forbidden), false)
})

test('identity, admission and origin gates reject spoofing before any transport or write', async t => {
  const f = fixture(); t.after(() => f.dispose())
  for (const options of [
    { peer: null },
    { peer: { principal: { kind: 'owner' }, signal: AbortSignal.abort(), key: 'owner' } },
    { peer: { principal: { kind: 'guest' }, signal: new AbortController().signal, key: 'owner' } },
    { peer: livePeer('spoofed') },
    { headers: { origin: 'https://127.0.0.1:3000' } },
    { headers: { 'sec-fetch-site': undefined } },
    { headers: { 'x-forwarded-proto': 'https' } },
  ]) {
    const result = await preview(f, options)
    assert.ok([401, 403].includes(result.status), result.text)
  }
  assert.deepEqual(f.state.requests, [])
  assert.deepEqual(f.state.calls, [])
})

test('different host owners cannot apply or cancel one another’s preview', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const p = (await preview(f)).body
  const peer = livePeer('other')
  assert.equal((await confirm(f, p, { peer })).body.error.code, 'REPREVIEW_REQUIRED')
  assert.equal((await call(f, '/preview/cancel', { peer, text: JSON.stringify({ previewId: p.previewId }) })).body.status, 'not-found')
  assert.equal((await confirm(f, p)).body.status, 'applied')
  assert.equal(f.state.calls.length, 1)
})

test('cancel, expiry by invalid token, concurrent confirmations and unload do not duplicate writes', async () => {
  const f = fixture()
  const first = (await preview(f)).body
  assert.equal((await call(f, '/preview/cancel', { text: JSON.stringify({ previewId: first.previewId }) })).body.status, 'cancelled')
  assert.equal((await confirm(f, first)).body.error.code, 'REPREVIEW_REQUIRED')
  const second = (await preview(f)).body
  const [a, b] = await Promise.all([confirm(f, second), confirm(f, second)])
  assert.deepEqual([a.body.status, b.body.error?.code], ['applied', 'REPREVIEW_REQUIRED'])
  assert.equal(f.state.calls.length, 1)
  const retained = f.routes.get(FORK + '/apply')
  f.dispose()
  assert.equal(f.routes.size, 0)
  const req = Readable.from([Buffer.from('{}')]); req.method = 'POST'; req.headers = { origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
  let status
  await retained.handler(req, { writeHead(value) { status = value }, end() {} }, livePeer())
  assert.equal(status, 503)
  assert.equal(f.state.calls.length, 1)
})

test('source changes, active original plugin, and lost acknowledgement cannot report a false success', async t => {
  for (const mode of ['source', 'original', 'unknown-ack']) await t.test(mode, async () => {
    const f = fixture(); t.after(() => f.dispose())
    const p = (await preview(f)).body
    if (mode === 'source') f.state.user.providers.sample.apiKeyEnv = 'CHANGED_REFERENCE'
    if (mode === 'original') f.state.plugins = [{ moduleName: '@goodandready/dsh-model-sync', enabled: true, fiberPhase: 'active' }]
    if (mode === 'unknown-ack') {
      const mutate = f.services.settings.mutate
      f.services.settings.mutate = async (...args) => { await mutate(...args); throw Error(`lost ${SECRET} ${BASE}`) }
    }
    const result = await confirm(f, p)
    assert.equal(result.body.error.code, { source: 'REPREVIEW_REQUIRED', original: 'ORIGINAL_WRITER_ACTIVE', 'unknown-ack': 'OUTCOME_UNKNOWN' }[mode], result.text)
    assert.equal(f.state.calls.length, mode === 'unknown-ack' ? 1 : 0)
    assert.doesNotMatch(result.text, /synthetic-bearer|relay\.example|private-tenant/)
    assert.equal((await confirm(f, p)).body.error.code, 'REPREVIEW_REQUIRED')
  })
})

test('strict JSON rejects forged owner/target/proof, duplicate keys, invalid UTF-8 and content headers', async t => {
  const f = fixture(); t.after(() => f.dispose())
  for (const text of [
    '{"provider":"sample","selectedNewIds":[],"owner":"owner"}',
    '{"provider":"sample","selectedNewIds":[],"target":"attacker"}',
    '{"provider":"sample","selectedNewIds":[],"proof":true}',
    '{"provider":"sample","\\u0070rovider":"sample","selectedNewIds":[]}',
    '{"provider":"sample","selectedNewIds":["new-a","new-a"]}',
    '{"provider":"sample","selectedNewIds":[]} trailing',
  ]) assert.equal((await preview(f, { text })).body.error.code, 'INVALID_RESPONSE', text)
  assert.equal((await preview(f, { chunks: [Buffer.from([0xff])] })).body.error.code, 'INVALID_RESPONSE')
  assert.equal((await preview(f, { headers: { 'content-type': 'text/plain' } })).body.error.code, 'INVALID_RESPONSE')
  assert.equal((await preview(f, { headers: { 'content-length': '2' } })).body.error.code, 'INVALID_RESPONSE')
  assert.equal((await preview(f, { text: ' '.repeat(256 * 1024 + 1) })).body.error.code, 'INVALID_RESPONSE')
  assert.deepEqual(f.state.requests, [])
})

test('optional Host-only privacy policy refuses unknown results without returning token', async t => {
  const f = fixture({ safety: () => false }); t.after(() => f.dispose())
  const response = await preview(f)
  assert.equal(response.status, 503)
  assert.equal(response.body.error.code, 'SETTINGS_UNAVAILABLE')
  assert.equal('previewId' in response.body, false)
  assert.deepEqual(f.state.calls, [])
})

test('peer disconnect cancels a preview while its Host safety policy is stalled', async () => {
  let entered, release, exposed
  const reached = new Promise(resolve => { entered = resolve })
  const waiting = new Promise(resolve => { release = resolve })
  const f = fixture({ safety: result => { exposed = result; entered(); return waiting } })
  const controller = new AbortController()
  const pending = preview(f, { peer: { principal: { kind: 'owner' }, key: 'owner', signal: controller.signal } })
  try {
    await reached
    controller.abort()
    let timer
    const response = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(null), 200) })])
    clearTimeout(timer)
    assert.ok(response, 'handler must respond without waiting for the Host policy')
    assert.equal(response.body.error.code, 'AUTH_REQUIRED')
    assert.equal((await confirm(f, exposed)).body.error.code, 'REPREVIEW_REQUIRED')
    assert.deepEqual(f.state.calls, [])
  } finally {
    release(true)
    await pending
    f.dispose()
  }
})

test('peer disconnect after dispatch responds unknown while the original write remains reserved', async () => {
  const f = fixture()
  const controller = new AbortController()
  const peer = { principal: { kind: 'owner' }, key: 'owner', signal: controller.signal }
  const p = (await preview(f)).body
  const mutate = f.services.settings.mutate
  let entered, release
  const reached = new Promise(resolve => { entered = resolve })
  const waiting = new Promise(resolve => { release = resolve })
  f.services.settings.mutate = async (...args) => { entered(); await waiting; return mutate(...args) }
  const pending = confirm(f, p, { peer })
  try {
    await reached
    controller.abort()
    let timer
    const response = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(null), 200) })])
    clearTimeout(timer)
    assert.ok(response, 'handler must respond without waiting for the pending Host mutation')
    assert.equal(response.status, 409)
    assert.equal(response.body.error.code, 'OUTCOME_UNKNOWN')
    assert.doesNotMatch(response.text, /synthetic-bearer|relay\.example|private-tenant/)
    assert.equal((await confirm(f, p)).body.error.code, 'REPREVIEW_REQUIRED')
  } finally {
    release()
    await pending
    f.dispose()
  }
  assert.equal(f.state.calls.length, 1, 'the late Host success ran once, not as a retry')
  assert.equal(f.state.user.providers.sample.models.length, 3)
})

test('15-second safety deadlines cancel tokens and retain real policy permits across unload', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const entered = [], releases = []
  let notify
  const safety = result => {
    entered.push(result)
    notify?.()
    if (entered.length > 4) return true
    return new Promise(resolve => releases.push(resolve))
  }
  let f = fixture({ safety })
  try {
    for (let i = 0; i < 4; i++) {
      const reached = new Promise(resolve => { notify = resolve })
      const pending = preview(f)
      await reached
      t.mock.timers.tick(15000)
      assert.equal((await pending).body.error.code, 'SETTINGS_UNAVAILABLE')
      assert.equal((await confirm(f, entered[i])).body.error.code, 'REPREVIEW_REQUIRED')
    }
    f.dispose()
    f = fixture({ safety })
    assert.equal((await preview(f)).body.error.code, 'SETTINGS_UNAVAILABLE')
    assert.equal(entered.length, 4, 'unsettled callbacks still own permits after unload')
    releases[0](true)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal((await preview(f)).status, 200, 'one settled callback frees exactly one permit')
    assert.deepEqual(f.state.calls, [])
  } finally {
    f.dispose()
    for (const release of releases) release(true)
    await new Promise(resolve => setImmediate(resolve))
  }
})

test('timed-out dispatched writes keep their real owner capacity until Host settlement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  const previews = []
  for (let i = 0; i < 5; i++) previews.push((await preview(f)).body)
  const releases = []
  let entered, calls = 0
  f.services.settings.mutate = () => {
    calls++
    entered()
    if (calls > 4) return undefined
    return new Promise(resolve => releases.push(resolve))
  }
  try {
    for (let i = 0; i < 4; i++) {
      const reached = new Promise(resolve => { entered = resolve })
      const pending = confirm(f, previews[i])
      await reached
      t.mock.timers.tick(15000)
      assert.equal((await pending).body.error.code, 'OUTCOME_UNKNOWN')
      assert.equal((await confirm(f, previews[i])).body.error.code, 'REPREVIEW_REQUIRED')
    }
    assert.equal((await confirm(f, previews[4])).body.error.code, 'SETTINGS_UNAVAILABLE')
    assert.equal(calls, 4, 'HTTP timeouts did not release unresolved write slots')
    releases[0]()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal((await confirm(f, previews[4])).body.status, 'applied')
    assert.equal(calls, 5)
  } finally {
    f.dispose()
    for (const release of releases) release()
    await new Promise(resolve => setImmediate(resolve))
  }
})

test('unload returns an unknown dispatched write without waiting for Host acknowledgement', async () => {
  const f = fixture()
  const p = (await preview(f)).body
  let entered, release
  const reached = new Promise(resolve => { entered = resolve })
  const waiting = new Promise(resolve => { release = resolve })
  const mutate = f.services.settings.mutate
  f.services.settings.mutate = async (...args) => { entered(); await waiting; return mutate(...args) }
  const pending = confirm(f, p)
  try {
    await reached
    f.dispose()
    let timer
    const response = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(null), 200) })])
    clearTimeout(timer)
    assert.ok(response, 'unload must not wait for a dispatched Host write')
    assert.equal(response.body.error.code, 'OUTCOME_UNKNOWN')
  } finally {
    release()
    await pending
    f.dispose()
  }
  assert.equal(f.state.calls.length, 1)
})

test('peer abort while awaiting original-plugin check prevents a late dispatch', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const controller = new AbortController()
  const peer = { principal: { kind: 'owner' }, key: 'owner', signal: controller.signal }
  const p = (await preview(f, { peer })).body
  let entered, release
  const reached = new Promise(resolve => { entered = resolve })
  const wait = new Promise(resolve => { release = resolve })
  f.services.pluginManager.listPlugins = async () => { entered(); await wait; return [] }
  const pending = confirm(f, p, { peer })
  await reached; controller.abort(); release()
  assert.equal((await pending).body.error.code, 'AUTH_REQUIRED')
  assert.deepEqual(f.state.calls, [])
})
