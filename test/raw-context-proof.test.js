import test from 'node:test'
import assert from 'node:assert/strict'
import { createHostRuntime } from '../lib/host-runtime.js'
import { createRawContextProof } from '../lib/raw-context-proof.js'
import { normalizeOpenRouterCatalog, openRouterCatalogMatchesTarget } from '../lib/openrouter-metadata.js'

// A synthetic Host and fake transport only: no profile, network or credential.
// The callbacks model the future *trusted Host* integration contract; they are
// not evidence that the currently installed runtime exposes such an integration.
function fixture(options = {}) {
  const state = { now: Date.now() + 1000, revision: 7, writes: 0, source: null, sourceValue: 64000,
    raw: { providers: { custom: { api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1', models: [
      { id: 'm1', maxTokens: 8192, reasoningEfforts: false, opaque: { keep: null } },
      { id: 'm2', custom: { retained: true } },
    ] } }, unrelated: { keep: false } }, inherited: { providers: {} } }
  const owner = Object.freeze({ name: 'host-owner' })
  const entry = { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' } }
  const editor = {
    configuration: () => [{ entry }],
    async edit(actual, change) {
      assert.equal(actual, entry)
      state.beforeEdit?.()
      const next = change(structuredClone(state.raw), structuredClone(state.inherited))
      state.raw = next
      state.writes++
      state.revision++
    },
  }
  const ctx = { get(name) { return {
    configEditor: editor,
    llm: { listConfigurableProviders: () => [{ provider: 'custom', declared: true,
      settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'custom'] }] },
    settings: { describe: () => [{ ns: 'llm-pi-ai', revision: state.revision, applies: 'live',
      value: state.raw, user: state.raw, base: state.inherited, secrets: [] }] },
  }[name] } }
  const runtime = createHostRuntime(ctx, { fetchImpl: async () => new Response(JSON.stringify({ data: [
    { id: 'm1', context_length: state.sourceValue }, { id: 'm2', context_length: 32000 },
  ], links: { next: null }, total_count: 2 }), { headers: { 'content-type': 'application/json' } }) })
  const proof = createRawContextProof({ ctx, runtime,
    ownerIdentity: identity => identity,
    // In this synthetic fixture this callback invokes the original runtime, not
    // normalizeOpenRouterCatalog. A real Host must authenticate its provenance.
    async loadSource(provider) {
      state.loadCount = (state.loadCount ?? 0) + 1
      if (state.onLoad) await state.onLoad(state.loadCount)
      const result = state.forcedSource ?? await runtime.discover(provider)
      state.source = result
      return result
    },
    currentSource: () => state.source,
    readLocal: provider => ({ namespace: 'llm-pi-ai', provider, providerPath: ['providers', provider],
      revision: state.revision, current: structuredClone(state.raw), inherited: structuredClone(state.inherited) }),
    clock: () => state.now,
    ...options,
  })
  return { state, owner, proof, runtime, ctx, editor }
}

test('preview alone writes nothing; confirmation applies only the displayed existing-model context field', async () => {
  const f = fixture()
  const before = structuredClone(f.state.raw)
  const view = await f.proof.preview(f.owner, { provider: 'custom', modelId: 'm1' })
  assert.match(view.previewId, /^[A-Za-z0-9_-]{43}$/)
  assert.match(view.digest, /^[a-f0-9]{64}$/)
  assert.deepEqual(view.changes, [{ type: 'set-field', scope: 'models', modelId: 'm1', index: 0, field: 'contextWindow', value: 64000 }])
  assert.equal(f.state.writes, 0)
  assert.deepEqual(f.state.raw, before)
  assert.deepEqual(await f.proof.apply(f.owner, { previewId: view.previewId, digest: view.digest }), { status: 'applied' })
  before.providers.custom.models[0].contextWindow = 64000
  assert.equal(f.state.writes, 1)
  assert.deepEqual(f.state.raw, before)
})

const request = { provider: 'custom', modelId: 'm1' }
const confirm = view => ({ previewId: view.previewId, digest: view.digest })
const code = value => value?.error?.code
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('per-owner/global pending source operations remain limited until real settlement, even after unload', async () => {
  const blocked = deferred(); let calls = 0
  const options = { loadSource: () => { calls++; return blocked.promise } }
  const hosts = Array.from({ length: 2 }, () => fixture(options))
  const owners = Array.from({ length: 9 }, () => Object.freeze({}))
  const work = []
  for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) work.push(hosts[i % 2].proof.preview(owners[i], request))
  assert.equal(calls, 32)
  assert.equal(code(await hosts[0].proof.preview(owners[0], request)), 'SETTINGS_UNAVAILABLE')
  assert.equal(code(await hosts[0].proof.preview(owners[8], request)), 'SETTINGS_UNAVAILABLE')
  for (const f of hosts) f.proof.unload()
  assert.ok((await Promise.all(work)).every(r => code(r) === 'REPREVIEW_REQUIRED'))
  const later = fixture(options)
  assert.equal(code(await later.proof.preview(owners[8], request)), 'SETTINGS_UNAVAILABLE')
  assert.equal(calls, 32)
  blocked.resolve(null)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(code(await later.proof.preview(owners[8], request)), 'REPREVIEW_REQUIRED')
  assert.equal(calls, 33)
  later.proof.unload()
})

test('unload after editor callback returns reports unknown without releasing real edit permit or reusing confirmation', async () => {
  const f = fixture(), view = await f.proof.preview(f.owner, request)
  const entered = deferred(), release = deferred()
  f.editor.edit = async (entry, change) => {
    const next = change(structuredClone(f.state.raw), structuredClone(f.state.inherited))
    entered.resolve()
    await release.promise
    f.state.raw = next
    f.state.writes++
  }
  const result = f.proof.apply(f.owner, confirm(view))
  await entered.promise
  f.proof.unload()
  assert.equal(code(await result), 'OUTCOME_UNKNOWN')
  assert.equal(code(await f.proof.apply(f.owner, confirm(view))), 'REPREVIEW_REQUIRED')
  assert.equal(f.state.writes, 0)
  release.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.state.writes, 1, 'a late Host write remains possible after unknown result')
})

test('an aborted pending source retains its owner permit until the Host promise settles', async () => {
  const blocked = deferred(), controller = new AbortController(); let calls = 0
  const f = fixture({ loadSource: () => { calls++; return blocked.promise } })
  const work = Array.from({ length: 4 }, () => f.proof.preview(f.owner, request, controller.signal))
  assert.equal(calls, 4)
  controller.abort()
  assert.ok((await Promise.all(work)).every(result => code(result) === 'REPREVIEW_REQUIRED'))
  assert.equal(code(await f.proof.preview(f.owner, request)), 'SETTINGS_UNAVAILABLE')
  assert.equal(calls, 4)
  blocked.resolve(null)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(code(await f.proof.preview(f.owner, request)), 'REPREVIEW_REQUIRED')
  assert.equal(calls, 5)
  f.proof.unload()
})

test('unconfirmed, cloned, forged, wrong-owner and replayed capabilities never write', async () => {
  const f = fixture(), original = structuredClone(f.state.raw)
  const view = await f.proof.preview(f.owner, request)
  const other = Object.freeze({ name: 'host-owner' })
  for (const input of [
    { previewId: view.previewId, digest: '0'.repeat(64) },
    { ...confirm(view), proof: {} },
    { previewId: 'A'.repeat(43), digest: view.digest },
  ]) assert.equal(code(await f.proof.apply(f.owner, input)), 'REPREVIEW_REQUIRED')
  assert.equal(code(await f.proof.apply(other, confirm(view))), 'REPREVIEW_REQUIRED')
  assert.equal(code(await f.proof.apply(structuredClone(f.owner), confirm(view))), 'REPREVIEW_REQUIRED')
  assert.deepEqual(f.state.raw, original)
  assert.equal(f.state.writes, 0)
  assert.deepEqual(await f.proof.apply(f.owner, confirm(view)), { status: 'applied' })
  assert.equal(code(await f.proof.apply(f.owner, confirm(view))), 'REPREVIEW_REQUIRED')
  assert.equal(f.state.writes, 1)
})

test('read-only OpenRouter brand forged with exported normalizer cannot replace original Host discovery', async () => {
  const f = fixture()
  const view = await f.proof.preview(f.owner, request)
  const endpoint = 'https://openrouter.ai/api/v1/models'
  const fake = normalizeOpenRouterCatalog({ provider: 'custom', endpoint, protocol: 'openai-completions',
    source: { kind: 'upstream', origin: 'https://openrouter.ai', fetchedAt: new Date(f.state.now).toISOString() },
    payload: { data: [{ id: 'm1', context_length: 64000 }, { id: 'm2', context_length: 32000 }] },
    responseComplete: true, existingModelIds: ['m1', 'm2'] })
  assert.equal(openRouterCatalogMatchesTarget(fake, { provider: 'custom', endpoint, protocol: 'openai-completions' }), true)
  f.state.forcedSource = Object.freeze({ status: 'complete', inventory: 'explicit', revision: 7, catalog: fake })
  assert.equal(code(await f.proof.apply(f.owner, confirm(view))), 'REPREVIEW_REQUIRED')
  assert.equal(f.state.writes, 0)
})

test('source, local state, revision, and maxTokens changes require a fresh preview', async t => {
  for (const [name, change] of [
    ['source value', f => { f.state.sourceValue = 64001 }],
    ['unrelated source model', f => { f.state.forcedSource = structuredClone(f.state.source) }],
    ['local unrelated field', f => { f.state.raw.unrelated.keep = true }],
    ['max output', f => { f.state.raw.providers.custom.models[0].maxTokens = 9000 }],
    ['model order', f => { f.state.raw.providers.custom.models.reverse() }],
    ['revision', f => { f.state.revision++ }],
    ['endpoint', f => { f.state.raw.providers.custom.baseURL = 'https://other.invalid/api/v1' }],
  ]) await t.test(name, async () => {
    const f = fixture(), view = await f.proof.preview(f.owner, request)
    assert.ok(view.previewId)
    change(f)
    assert.equal(code(await f.proof.apply(f.owner, confirm(view))), 'REPREVIEW_REQUIRED')
    assert.equal(f.state.writes, 0)
    assert.equal(code(await f.proof.apply(f.owner, confirm(view))), 'REPREVIEW_REQUIRED')
  })
})

test('expiry and unload invalidate pending confirmation', async () => {
  for (const mode of ['expiry', 'unload']) {
    const f = fixture(), view = await f.proof.preview(f.owner, request)
    if (mode === 'expiry') f.state.now += 300000
    else f.proof.unload()
    assert.equal(code(await f.proof.apply(f.owner, confirm(view))), 'REPREVIEW_REQUIRED')
    assert.equal(f.state.writes, 0)
  }
})

test('concurrent duplicate and wrong-owner apply cannot consume the single winner', async () => {
  const f = fixture(), view = await f.proof.preview(f.owner, request)
  let release, started
  const waiting = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { started = resolve })
  f.state.onLoad = async count => { if (count === 2) { started(); await waiting } }
  const winner = f.proof.apply(f.owner, confirm(view))
  await entered
  assert.equal(code(await f.proof.apply(Object.freeze({}), confirm(view))), 'REPREVIEW_REQUIRED')
  assert.equal(code(await f.proof.apply(f.owner, confirm(view))), 'REPREVIEW_REQUIRED')
  release()
  assert.deepEqual(await winner, { status: 'applied' })
  assert.equal(f.state.writes, 1)
})

test('locked callback changes and unknown acknowledgement consume the confirmation', async () => {
  for (const mode of ['local-race', 'lost-ack']) {
    const f = fixture(), view = await f.proof.preview(f.owner, request)
    if (mode === 'local-race') f.state.beforeEdit = () => { f.state.raw.unrelated.keep = true }
    else {
      const original = f.editor.edit
      f.editor.edit = async (...args) => { await original(...args); throw Error('lost ack') }
    }
    assert.equal(code(await f.proof.apply(f.owner, confirm(view))), 'OUTCOME_UNKNOWN')
    assert.equal(f.state.writes, mode === 'lost-ack' ? 1 : 0)
    assert.equal(code(await f.proof.apply(f.owner, confirm(view))), 'REPREVIEW_REQUIRED')
  }
})

test('missing or oversized explicit maximum and dynamic aliases never produce authority', async () => {
  for (const mode of ['missing', 'oversized', 'alias']) {
    const f = fixture()
    if (mode === 'missing') delete f.state.raw.providers.custom.models[0].maxTokens
    if (mode === 'oversized') f.state.raw.providers.custom.models[0].maxTokens = 64001
    if (mode === 'alias') f.state.raw.providers.custom.models[0].id = 'm1~latest'
    const input = mode === 'alias' ? { provider: 'custom', modelId: 'm1~latest' } : request
    assert.equal(code(await f.proof.preview(f.owner, input)), 'REPREVIEW_REQUIRED')
    assert.equal(f.state.writes, 0)
  }
})
