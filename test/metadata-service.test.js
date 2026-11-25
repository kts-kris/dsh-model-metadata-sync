import test from 'node:test'
import assert from 'node:assert/strict'
import { createMetadataService } from '../lib/metadata-service.js'

// These are synthetic Host services, in-memory Settings and a fake HTTP transport.
// No real profile, secret, network, or global credential inventory is involved.
const SECRET = 'synthetic-bearer-0123456789'
const BASE = 'https://relay.example.invalid/private-tenant/v1'
const REF = 'SYNTHETIC_TOKEN'
const OWNER = Object.freeze({})
const OTHER = Object.freeze({})
class Conflict extends Error {
  constructor(expected, actual) {
    super('synthetic conflict')
    this.code = 'SETTINGS_CONFLICT'
    this.expected = expected
    this.actual = actual
  }
}
function fixture({ proveConflicts = false, authorizeOwner = owner => owner === OWNER || owner === OTHER } = {}) {
  const verifiedConflicts = new WeakSet()
  const state = {
    revision: 7,
    user: { providers: { sample: { api: 'openai-completions', baseURL: BASE, apiKeyEnv: REF,
      models: [{ id: 'old', input: null, reasoningEfforts: false, opaque: { keep: false } }] } }, unrelated: { keep: null } },
    base: { providers: { sample: {} } }, calls: [], requests: [], rows: [{ id: 'new-b' }, { id: 'old' }, { id: 'new-a' }], plugins: [],
  }
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', revision: state.revision, applies: 'live',
      user: structuredClone(state.user), value: structuredClone(state.user), base: structuredClone(state.base), secrets: [] }],
    async mutate(ns, ops, revision) {
      state.calls.push({ ns, ops: structuredClone(ops), revision })
      if (revision !== state.revision) throw new Conflict(revision, state.revision)
      for (const op of ops) {
        let node = state.user
        for (const key of op.path.slice(0, -1)) node = node[key]
        node[op.path.at(-1)] = structuredClone(op.value)
      }
      state.revision++
    },
  }
  const pluginManager = { listPlugins: async () => state.plugins }
  const credentials = { resolve: async () => ({ value: SECRET }) }
  const ctx = { get: name => ({ settings, pluginManager, llm: {
    listConfigurableProviders: () => [{ provider: 'sample', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'sample'] }],
    listProviders: () => [{ id: 'sample' }],
  }, credentials })[name] }
  let now = 1000
  const service = createMetadataService({ ctx, ownerIdentity: owner => authorizeOwner(owner) ? owner : null,
    SettingsConflictError: Conflict, clock: () => now,
    ...(proveConflicts ? { proveNoWriteConflict: error => verifiedConflicts.has(error) } : {}),
    fetchImpl: async (url, options) => {
      state.requests.push({ url: String(url), authorization: new Headers(options.headers).get('authorization') })
      return new Response(JSON.stringify({ data: state.rows }), { headers: { 'content-type': 'application/json' } })
    },
  })
  return { service, state, settings, credentials, pluginManager, verifiedConflicts, setTime: value => { now = value } }
}
const preview = f => f.service.preview(OWNER, { provider: 'sample', selectedNewIds: ['new-a', 'new-b'] })
const apply = (f, p, owner = OWNER) => f.service.apply(owner, { previewId: p.previewId, digest: p.digest })

test('stalled credentials are bounded per owner and released on unload without network', async () => {
  const f = fixture()
  let resolveCredential, credentialCalls = 0
  const late = new Promise(resolve => { resolveCredential = resolve })
  f.credentials.resolve = () => { credentialCalls++; return late }
  const input = { provider: 'sample', selectedNewIds: ['new-a'] }
  const running = Array.from({ length: 5 }, () => f.service.preview(OWNER, input))
  // A different owner can still be admitted, while the fifth request must never
  // reach the credential provider. All promises are settled even on failure.
  const other = f.service.preview(OTHER, input)
  try {
    assert.equal(credentialCalls, 5, 'only four requests for one owner and one for another enter')
    assert.deepEqual(f.state.requests, [], 'no network before credential resolution')
  } finally {
    f.service.unload()
    resolveCredential({ value: SECRET })
    await Promise.all([...running, other])
  }
  assert.deepEqual(f.state.requests, [], 'late credentials do not start network after unload')
})

test('timed-out credential work retains its owner quota across service instances until it settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const a = fixture(), b = fixture()
  const releases = [], running = []
  let calls = 0
  const resolve = () => { calls++; return new Promise(done => releases.push(done)) }
  a.credentials.resolve = b.credentials.resolve = resolve
  const input = { provider: 'sample', selectedNewIds: ['new-a'] }
  try {
    for (let i = 0; i < 4; i++) running.push((i % 2 ? b : a).service.preview(OWNER, input))
    assert.equal(calls, 4)
    t.mock.timers.tick(15000)
    const outcomes = await Promise.all(running)
    assert.ok(outcomes.every(result => result.error), 'outer callers return at the deadline')
    const extra = b.service.preview(OWNER, input)
    running.push(extra)
    assert.equal(calls, 4, 'a timed-out but unresolved credential still consumes its slot')
    assert.ok((await extra).error, 'saturation refuses the request')
    releases[0]({ value: SECRET })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    const replacement = b.service.preview(OWNER, input)
    running.push(replacement)
    assert.equal(calls, 5, 'settlement returns precisely the original credential slot')
  } finally {
    a.service.unload(); b.service.unload()
    for (const release of releases) release({ value: SECRET })
    await Promise.all(running)
    await Promise.resolve(); await Promise.resolve()
  }
  assert.deepEqual(a.state.requests, [])
  assert.deepEqual(b.state.requests, [])
})

test('end-to-end deadline frees a stalled credential slot, ignoring its late resolution', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  const pendingCredentials = []
  f.credentials.resolve = () => new Promise(resolve => pendingCredentials.push(resolve))
  const input = { provider: 'sample', selectedNewIds: ['new-a'] }
  const first = f.service.preview(OWNER, input)
  t.mock.timers.tick(15000)
  assert.equal((await first).error.code, 'REPREVIEW_REQUIRED')
  const active = Array.from({ length: 3 }, () => f.service.preview(OWNER, input))
  assert.equal(pendingCredentials.length, 4)
  assert.ok((await f.service.preview(OWNER, input)).error, 'unresolved timed-out work still uses its credential slot')
  pendingCredentials[0]({ value: SECRET })
  await Promise.resolve(); await Promise.resolve()
  const replacement = f.service.preview(OWNER, input)
  active.push(replacement)
  assert.equal(pendingCredentials.length, 5)
  const refused = await f.service.preview(OWNER, input)
  assert.equal(refused.error.code, 'SETTINGS_UNAVAILABLE', 'late completion must not free another request')
  assert.deepEqual(f.state.requests, [])
  f.service.unload()
  await Promise.all(active)
  for (const resolve of pendingCredentials.slice(1)) resolve({ value: SECRET })
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(f.state.requests, [])
})

test('aborted plugin checks retain their owner quota across service instances until each settles', async () => {
  const a = fixture(), b = fixture()
  const releases = []
  const list = () => new Promise(resolve => { releases.push(resolve) })
  a.pluginManager.listPlugins = b.pluginManager.listPlugins = list
  const turn = () => new Promise(resolve => setImmediate(resolve))
  async function abortApply(f) {
    const p = await preview(f)
    assert.ok(p.previewId, 'preview is independently authorized')
    const controller = new AbortController()
    const applying = f.service.apply(OWNER, { previewId: p.previewId, digest: p.digest }, controller.signal)
    await turn()
    controller.abort()
    assert.ok((await applying).error, 'aborted or capacity-denied apply fails closed')
  }
  try {
    for (let i = 0; i < 12; i++) await abortApply(i % 2 ? b : a)
    assert.equal(releases.length, 4, 'twelve aborted applies cannot start more than four pending Host calls')
    releases[0]([])
    await turn()
    await abortApply(b)
    assert.equal(releases.length, 5, 'settling one call admits exactly one replacement')
    await abortApply(a)
    assert.equal(releases.length, 5, 'the remaining pending calls still consume their own permits')
    releases[0]([])
    await turn()
    await abortApply(b)
    assert.equal(releases.length, 5, 'repeated settlement of an old call cannot release another permit')
  } finally {
    a.service.unload(); b.service.unload()
    for (const release of releases) release([])
    await turn()
  }
  assert.deepEqual(a.state.calls, [], 'aborted applies never dispatch a write')
  assert.deepEqual(b.state.calls, [], 'late completions never dispatch a write')
})

test('timed-out plugin checks retain their owner quota across service instances', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const a = fixture(), b = fixture()
  const releases = []
  const list = () => new Promise(resolve => { releases.push(resolve) })
  a.pluginManager.listPlugins = b.pluginManager.listPlugins = list
  const turn = () => new Promise(resolve => setImmediate(resolve))
  async function timeOutApply(f) {
    const p = await preview(f)
    assert.ok(p.previewId)
    const pending = apply(f, p)
    await turn()
    t.mock.timers.tick(15000)
    assert.ok((await pending).error)
  }
  try {
    for (let i = 0; i < 8; i++) await timeOutApply(i % 2 ? b : a)
    assert.equal(releases.length, 4, 'deadlines do not release unresolved Host calls')
    releases[0]([])
    await turn()
    await timeOutApply(b)
    await timeOutApply(a)
    assert.equal(releases.length, 5, 'one late settlement permits exactly one replacement')
  } finally {
    a.service.unload(); b.service.unload()
    for (const release of releases) release([])
    await turn()
  }
  assert.deepEqual(a.state.calls, [])
  assert.deepEqual(b.state.calls, [])
})

test('plugin checks enforce a global pending-call limit across owners and instances', async () => {
  const a = fixture({ authorizeOwner: () => true }), b = fixture({ authorizeOwner: () => true })
  const releases = []
  const list = () => new Promise(resolve => { releases.push(resolve) })
  a.pluginManager.listPlugins = b.pluginManager.listPlugins = list
  const turn = () => new Promise(resolve => setImmediate(resolve))
  async function abortApply(f, owner) {
    const p = await f.service.preview(owner, { provider: 'sample', selectedNewIds: ['new-a'] })
    assert.ok(p.previewId)
    const controller = new AbortController()
    const pending = f.service.apply(owner, { previewId: p.previewId, digest: p.digest }, controller.signal)
    await turn(); controller.abort()
    assert.ok((await pending).error)
  }
  try {
    for (let i = 0; i < 33; i++) await abortApply(i % 2 ? b : a, Object.freeze({ i }))
    assert.equal(releases.length, 32, 'a 33rd owner does not start another pending Host call')
    releases[0]([])
    await turn()
    await abortApply(b, Object.freeze({ i: 33 }))
    assert.equal(releases.length, 33, 'one settled call permits one new call globally')
    await abortApply(a, Object.freeze({ i: 34 }))
    assert.equal(releases.length, 33, 'all other pending calls keep their permits')
  } finally {
    a.service.unload(); b.service.unload()
    for (const release of releases) release([])
    await turn()
  }
  assert.deepEqual(a.state.calls, [])
  assert.deepEqual(b.state.calls, [])
})

test('plugin manager synchronous throws and asynchronous rejections release their permits', async () => {
  for (const mode of ['throw', 'reject']) {
    const f = fixture()
    let calls = 0
    f.pluginManager.listPlugins = () => {
      calls++
      if (mode === 'throw') throw Error('synthetic failure')
      return Promise.reject(Error('synthetic failure'))
    }
    for (let i = 0; i < 6; i++) {
      const p = await preview(f)
      assert.ok((await apply(f, p)).error, `${mode} fails closed`)
    }
    assert.equal(calls, 6, `${mode} does not exhaust four permits`)
    assert.deepEqual(f.state.calls, [], `${mode} never authorizes a write`)
    f.pluginManager.listPlugins = async () => []
    assert.equal((await apply(f, await preview(f))).status, 'applied', `${mode} leaves later valid work usable`)
    assert.equal(f.state.calls.length, 1)
    f.service.unload()
  }
})

test('a late plugin rejection frees only its own permit without a write', async () => {
  const f = fixture()
  const pending = []
  f.pluginManager.listPlugins = () => new Promise((resolve, reject) => { pending.push({ resolve, reject }) })
  const turn = () => new Promise(resolve => setImmediate(resolve))
  async function abortApply() {
    const p = await preview(f)
    const controller = new AbortController()
    const applying = f.service.apply(OWNER, { previewId: p.previewId, digest: p.digest }, controller.signal)
    await turn(); controller.abort()
    assert.ok((await applying).error)
  }
  try {
    for (let i = 0; i < 4; i++) await abortApply()
    pending[0].reject(Error('synthetic late rejection'))
    await turn()
    await abortApply()
    await abortApply()
    assert.equal(pending.length, 5, 'one rejected Host call admits one replacement, not two')
  } finally {
    f.service.unload()
    for (const item of pending) item.resolve([])
    await turn()
  }
  assert.deepEqual(f.state.calls, [])
})

test('an apply aborted before plugin dispatch never starts the Host call', async () => {
  const f = fixture(); const p = await preview(f)
  let calls = 0
  f.pluginManager.listPlugins = () => { calls++; return [] }
  const controller = new AbortController()
  const applying = f.service.apply(OWNER, { previewId: p.previewId, digest: p.digest }, controller.signal)
  controller.abort()
  assert.ok((await applying).error)
  assert.equal(calls, 0)
  assert.deepEqual(f.state.calls, [])
  f.service.unload()
})

test('deadline cancels a stalled plugin check before mutation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(); const p = await preview(f)
  let entered, release
  const reached = new Promise(resolve => { entered = resolve })
  f.pluginManager.listPlugins = () => { entered(); return new Promise(resolve => { release = resolve }) }
  const applying = apply(f, p)
  try {
    await reached
    t.mock.timers.tick(15000)
    assert.ok((await applying).error)
    assert.deepEqual(f.state.calls, [])
  } finally {
    f.service.unload()
    release?.([])
    await applying
  }
})

test('no confirmation, wrong owner, and concurrent repeat cannot create additional writes', async () => {
  const f = fixture()
  const p = await preview(f)
  assert.deepEqual(f.state.calls, [])
  assert.equal((await apply(f, p, OTHER)).error.code, 'REPREVIEW_REQUIRED')
  const [a, b] = await Promise.all([apply(f, p), apply(f, p)])
  assert.deepEqual([a.status, b.error?.code], ['applied', 'REPREVIEW_REQUIRED'])
  assert.equal(f.state.calls.length, 1)
  assert.equal((await apply(f, p)).error.code, 'REPREVIEW_REQUIRED')
})

test('another owner cannot disrupt a reserved in-flight confirmation', async () => {
  const f = fixture()
  const p = await preview(f)
  let release, entered
  const waiting = new Promise(resolve => { release = resolve })
  const reached = new Promise(resolve => { entered = resolve })
  f.pluginManager.listPlugins = async () => { entered(); await waiting; return [] }
  const first = apply(f, p)
  await reached
  const second = await apply(f, p, OTHER)
  const cancellation = f.service.cancel(OTHER, { previewId: p.previewId })
  release()
  assert.equal(second.error.code, 'REPREVIEW_REQUIRED')
  assert.equal(cancellation.status, 'not-found')
  assert.equal((await first).status, 'applied')
  assert.equal(f.state.calls.length, 1)
})

test('confirmed synthetic Host preview appends only selected IDs via settings path CAS', async () => {
  const f = fixture()
  const p = await preview(f)
  assert.equal(p.writeEnabled, true)
  assert.match(p.sources.upstream.lastAttemptAt, /^\d{4}-\d\d-\d\dT.*Z$/)
  assert.deepEqual(p.changes, [{ type: 'add-model', modelId: 'new-b' }, { type: 'add-model', modelId: 'new-a' }])
  assert.equal(f.state.calls.length, 0, 'preview does not write')
  assert.equal((await apply(f, p)).status, 'applied')
  assert.deepEqual(f.state.user.providers.sample.models, [
    { id: 'old', input: null, reasoningEfforts: false, opaque: { keep: false } }, { id: 'new-b' }, { id: 'new-a' },
  ])
  assert.deepEqual(f.state.calls, [{ ns: 'llm-pi-ai', revision: 7, ops: [
    { op: 'set', path: ['providers', 'sample', 'models', '1'], value: { id: 'new-b' } },
    { op: 'set', path: ['providers', 'sample', 'models', '2'], value: { id: 'new-a' } },
  ] }])
  assert.deepEqual(f.state.user.unrelated, { keep: null })
})

test('writer-active and unknown-outcome refusals never repeat mutations', async () => {
  let f = fixture()
  let p = await preview(f)
  f.state.plugins = [{ moduleName: '@goodandready/dsh-model-sync', enabled: true, fiberPhase: 'active' }]
  assert.equal((await apply(f, p)).error.code, 'ORIGINAL_WRITER_ACTIVE')
  assert.equal(f.state.calls.length, 0)
  f = fixture(); p = await preview(f)
  const mutate = f.settings.mutate
  f.settings.mutate = async (...args) => { await mutate(...args); throw Error(`lost ack ${SECRET} ${BASE}`) }
  const result = await apply(f, p)
  assert.equal(result.error.code, 'OUTCOME_UNKNOWN')
  assert.equal(f.state.calls.length, 1)
  assert.equal((await apply(f, p)).error.code, 'REPREVIEW_REQUIRED')
  assert.doesNotMatch(JSON.stringify(result), /synthetic-bearer|relay\.example|private-tenant/)
})

test('only a proven no-write conflict permits same-plan recomputation; a changed diff aborts', async () => {
  let f = fixture({ proveConflicts: true })
  let p = await preview(f)
  const mutate = f.settings.mutate
  let remaining = 2
  f.settings.mutate = async (...args) => {
    if (remaining-- > 0) {
      f.state.calls.push({ revision: args[2] })
      f.state.revision++; f.state.user.unrelated.keep = 'concurrent'
      const error = new Conflict(args[2], f.state.revision); f.verifiedConflicts.add(error); throw error
    }
    return mutate(...args)
  }
  assert.equal((await apply(f, p)).status, 'applied')
  assert.deepEqual(f.state.calls.map(call => call.revision), [7, 8, 9])
  assert.equal(f.state.user.unrelated.keep, 'concurrent')
  f = fixture({ proveConflicts: true }); p = await preview(f)
  f.settings.mutate = async (...args) => {
    f.state.calls.push({ revision: args[2] }); f.state.revision++
    f.state.rows = [{ id: 'old' }, { id: 'new-a' }, { id: 'new-b' }]
    const error = new Conflict(args[2], f.state.revision); f.verifiedConflicts.add(error); throw error
  }
  assert.equal((await apply(f, p)).error.code, 'REPREVIEW_REQUIRED')
  assert.equal(f.state.calls.length, 1)
  assert.deepEqual(f.state.user.providers.sample.models.map(model => model.id), ['old'])
})

test('selection, target or revision changes require a new preview', async () => {
  for (const alter of [
    f => { f.state.revision++ },
    f => { f.state.user.providers.sample.baseURL = 'https://other.example.invalid/v1'; f.state.revision++ },
    f => { f.state.rows = [{ id: 'old' }, { id: 'new-a' }] },
  ]) {
    const f = fixture(); const p = await preview(f); alter(f)
    assert.equal((await apply(f, p)).error.code, 'REPREVIEW_REQUIRED')
    assert.equal(f.state.calls.length, 0)
  }
})

test('implicit or unproven models never become a replacement list', async () => {
  const f = fixture()
  delete f.state.user.providers.sample.models
  const p = await f.service.preview(OWNER, { provider: 'sample', selectedNewIds: [] })
  assert.equal(p.writeEnabled, false)
  assert.ok(p.items.every(item => item.existing === null && item.fields.every(field => field.state === 'unknown')))
  assert.deepEqual(p.changes, [])
  const selected = await f.service.preview(OWNER, { provider: 'sample', selectedNewIds: ['new-a'] })
  assert.equal(selected.error.code, 'INVALID_RESPONSE')
  assert.equal(f.state.calls.length, 0)
})

test('responses contain no synthetic bearer or private upstream endpoint, including reflected attacks', async () => {
  const f = fixture()
  const p = await preview(f)
  for (const text of [SECRET, BASE, REF, 'relay.example.invalid', 'private-tenant']) {
    assert.equal(JSON.stringify(p).includes(text), false, text)
  }
  assert.deepEqual(f.state.requests, [{ url: `${BASE}/models`, authorization: `Bearer ${SECRET}` }])
  f.state.rows = [{ id: `model-${SECRET}` }]
  const rejected = await f.service.preview(OWNER, { provider: 'sample', selectedNewIds: [] })
  assert.equal(rejected.error.code, 'INVALID_RESPONSE')
  assert.equal(JSON.stringify(rejected).includes(SECRET), false)
  assert.equal(f.state.calls.length, 0)
})

test('cancel, expiry, invalid digest and unload cannot authorize a write', async () => {
  let f = fixture(); let p = await preview(f)
  assert.equal(f.service.cancel(OTHER, { previewId: p.previewId }).status, 'not-found')
  assert.equal(f.service.cancel(OWNER, { previewId: p.previewId }).status, 'cancelled')
  assert.equal((await apply(f, p)).error.code, 'REPREVIEW_REQUIRED')
  f = fixture(); p = await preview(f); f.setTime(301000)
  assert.equal((await apply(f, p)).error.code, 'REPREVIEW_REQUIRED')
  assert.equal(f.state.calls.length, 0)
  f = fixture(); p = await preview(f)
  assert.equal((await f.service.apply(OWNER, { previewId: p.previewId, digest: 'bad' })).error.code, 'REPREVIEW_REQUIRED')
  assert.equal((await apply(f, p)).error.code, 'REPREVIEW_REQUIRED')
  f = fixture(); p = await preview(f); f.service.unload()
  assert.equal((await apply(f, p)).error.code, 'REPREVIEW_REQUIRED')
  assert.equal(f.state.calls.length, 0)
})

test('unload during an in-flight commit revalidation prevents dispatch', async () => {
  const f = fixture(); const p = await preview(f)
  let entered, release
  const reached = new Promise(resolve => { entered = resolve })
  const wait = new Promise(resolve => { release = resolve })
  f.pluginManager.listPlugins = async () => { entered(); await wait; return [] }
  const pending = apply(f, p); await reached
  f.service.unload(); release()
  assert.ok((await pending).error)
  assert.equal(f.state.calls.length, 0)
})

test('a proven conflict cannot switch credential reference and silently reuse confirmation', async () => {
  const f = fixture({ proveConflicts: true }); const p = await preview(f)
  f.settings.mutate = async (...args) => {
    f.state.calls.push({ revision: args[2] }); f.state.revision++
    f.state.user.providers.sample.apiKeyEnv = 'A_DIFFERENT_REFERENCE'
    const error = new Conflict(args[2], f.state.revision); f.verifiedConflicts.add(error); throw error
  }
  assert.equal((await apply(f, p)).error.code, 'REPREVIEW_REQUIRED')
  assert.equal(f.state.calls.length, 1)
})

test('a proven conflict cannot reuse confirmation for a changed target or source basis with the same diff', async t => {
  for (const [name, change] of [
    ['same canonical endpoint, different configured base URL', f => { f.state.user.providers.sample.baseURL += '/' }],
    ['same credential ref, different configured source field', f => {
      delete f.state.user.providers.sample.apiKeyEnv
      f.state.user.providers.sample.credentialRef = REF
    }],
    ['inherited route preservation basis', f => { f.state.base.providers.sample.marker = 'changed' }],
  ]) await t.test(name, async () => {
    const f = fixture({ proveConflicts: true }); const p = await preview(f)
    f.settings.mutate = async (...args) => {
      f.state.calls.push({ revision: args[2] }); f.state.revision++; change(f)
      const error = new Conflict(args[2], f.state.revision); f.verifiedConflicts.add(error); throw error
    }
    const result = await apply(f, p)
    assert.equal(result.error.code, 'REPREVIEW_REQUIRED')
    assert.equal(f.state.calls.length, 1)
    assert.deepEqual(f.state.user.providers.sample.models.map(model => model.id), ['old'])
    assert.doesNotMatch(JSON.stringify(result), /synthetic-bearer|SYNTHETIC_TOKEN|relay\.example|private-tenant/)
  })
})

test('commit refuses an ABA snapshot with a shorter models list at the same revision', async () => {
  const f = fixture()
  f.state.user.providers.sample.models.push({ id: 'old-1', opaque: { keep: true } })
  const p = await preview(f)
  const approvedModels = structuredClone(f.state.user.providers.sample.models)
  // Commit reads the shorter B snapshot before listPlugins first yields. The
  // fake Host then restores A without changing revision; checking only the
  // post-await snapshot would accept A but derive index 1 from B and overwrite.
  f.state.user.providers.sample.models.pop()
  let pluginReads = 0
  f.pluginManager.listPlugins = async () => {
    if (pluginReads++ === 0) f.state.user.providers.sample.models = structuredClone(approvedModels)
    return []
  }
  const result = await apply(f, p)
  assert.ok(result.error, 'a snapshot other than the approved one cannot authorize operations')
  assert.deepEqual(f.state.calls, [], 'no mutation is dispatched')
  assert.ok(pluginReads === 0 || pluginReads === 1)
  assert.deepEqual(f.state.user.providers.sample.models, pluginReads ? approvedModels : approvedModels.slice(0, 1),
    'no new model overwrites the Host snapshot')
})

test('source selection is revalidated even if Host data changes without a revision increment', async () => {
  const f = fixture(); const p = await preview(f)
  f.state.user.providers.sample.apiKeyEnv = 'A_DIFFERENT_REFERENCE'
  assert.equal((await apply(f, p)).error.code, 'REPREVIEW_REQUIRED')
  assert.equal(f.state.calls.length, 0)
})

test('an absent inherited provider route is safe for an explicitly user-owned list', async () => {
  const f = fixture(); f.state.base.providers = {}
  const p = await preview(f)
  assert.equal((await apply(f, p)).status, 'applied')
  assert.deepEqual(f.state.user.providers.sample.models.map(model => model.id), ['old', 'new-b', 'new-a'])
})
