import test from 'node:test'
import assert from 'node:assert/strict'
import { createRawContextCommit } from '../lib/raw-context-commit.js'

// Synthetic host services only; no real profile, network or credentials.
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function fixture() {
  const owner = Object.freeze({}), authority = Object.freeze({}), proof = Object.freeze({})
  const plan = freeze({ revision: 7, target: { namespace: 'llm-pi-ai', provider: 'custom',
    providerPath: ['providers', 'custom'], protocol: 'openai-completions', endpointFingerprint: 'a'.repeat(64) },
  modelIds: ['m1', 'm2'], selectedNewIds: [], changes: [
    { type: 'set-field', scope: 'models', modelId: 'm1', index: 0, field: 'contextWindow', value: 64000 },
  ] })
  const entry = { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' } }
  const state = { calls: 0, revision: 7, inherited: { providers: {} }, raw: {
    providers: { custom: { api: 'openai-completions', baseURL: 'https://synthetic.invalid/v1',
      headers: { authorization: 'synthetic-secret' }, models: [
        { id: 'm1', maxTokens: 8192, reasoningEfforts: false, opaque: { keep: null } },
        { id: 'm2', custom: { retained: true } },
      ] } }, unrelated: { keep: false },
  } }
  const editor = {
    configuration: () => [{ entry, inherited: structuredClone(state.inherited), override: {} }],
    async edit(actual, change) {
      state.calls++
      assert.equal(actual, entry)
      state.beforeEdit?.()
      const next = change(structuredClone(state.raw), structuredClone(state.inherited))
      state.raw = next
      state.revision++
    },
  }
  const settings = { describe: () => [{ ns: 'llm-pi-ai', revision: state.revision, applies: 'live' }] }
  const llm = { listConfigurableProviders: () => [{ provider: 'custom', settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'custom'], declared: true }] }
  const ctx = { get: key => ({ configEditor: editor, settings, llm })[key] }
  const verify = input => input.owner === owner && input.authority === authority && input.proof === proof && input.plan === plan
  const commit = createRawContextCommit(ctx, { verify })
  return { owner, authority, proof, plan, state, editor, settings, llm, ctx, verify, commit,
    run: () => commit({ owner, authority, proof, plan }) }
}

test('one confirmed existing model receives only contextWindow while unrelated raw configuration is preserved', async () => {
  const f = fixture()
  assert.deepEqual(await f.run(), { status: 'applied' })
  assert.deepEqual(f.state.raw, { providers: { custom: { api: 'openai-completions', baseURL: 'https://synthetic.invalid/v1',
    headers: { authorization: 'synthetic-secret' }, models: [
      { id: 'm1', maxTokens: 8192, reasoningEfforts: false, opaque: { keep: null }, contextWindow: 64000 },
      { id: 'm2', custom: { retained: true } },
    ] } }, unrelated: { keep: false } })
})

test('under the edit lock, inherited changes, configured values and stale revisions refuse without writing', async t => {
  for (const [name, mutate] of [
    ['inherited route appeared', s => { s.inherited = { providers: { custom: {} } } }],
    ['current root expression', s => { s.raw.__jsExpr = 'untrusted-expression' }],
    ['current providers expression', s => { s.raw.providers.__jsExpr = 'untrusted-expression' }],
    ['current route expression', s => { s.raw.providers.custom.__jsExpr = 'untrusted-expression' }],
    ['current model expression', s => { s.raw.providers.custom.models[0].__jsExpr = 'untrusted-expression' }],
    ['current other model expression', s => { s.raw.providers.custom.models[1].__jsExpr = 'untrusted-expression' }],
    ['current expression marker false', s => { s.raw.providers.custom.__jsExpr = false }],
    ['inherited path unreadable', s => { s.inherited.providers = null }],
    ['inherited expression unknown', s => { s.inherited.providers = { __jsExpr: 'untrusted-expression' } }],
    ['inherited root expression unknown', s => { s.inherited = { __jsExpr: 'untrusted-expression' } }],
    ['configured context false', s => { s.raw.providers.custom.models[0].contextWindow = false }],
    ['configured context null', s => { s.raw.providers.custom.models[0].contextWindow = null }],
    ['configured context empty', s => { s.raw.providers.custom.models[0].contextWindow = {} }],
    ['configured route default false', s => { s.raw.providers.custom.defaultContextWindow = false }],
    ['configured route default null', s => { s.raw.providers.custom.defaultContextWindow = null }],
    ['configured overrides empty', s => { s.raw.providers.custom.modelOverrides = {} }],
    ['output exceeds context', s => { s.raw.providers.custom.models[0].maxTokens = 64001 }],
    ['output unknown', s => { delete s.raw.providers.custom.models[0].maxTokens }],
    ['output invalid', s => { s.raw.providers.custom.models[0].maxTokens = -1 }],
    ['revision changed', s => { s.revision++ }],
    ['model order changed', s => { s.raw.providers.custom.models.reverse() }],
    ['model id changed', s => { s.raw.providers.custom.models[0].id = 'other' }],
  ]) await t.test(name, async () => {
    const f = fixture()
    f.state.beforeEdit = () => mutate(f.state)
    assert.deepEqual(await f.run(), { error: { code: 'OUTCOME_UNKNOWN' } })
    assert.equal(f.state.calls, 1)
    assert.notEqual(f.state.raw.providers.custom.models.find(row => row.id === 'm1')?.contextWindow, 64000)
  })
})

test('untrusted approvals and unproven results never write or expose credentials', async t => {
  for (const [name, makeVerify] of [
    ['unverified', () => () => false], ['async verifier', () => async () => true],
    ['throwing verifier', () => () => { throw Error('synthetic-secret') }],
    ['different plan', f => args => f.verify({ ...args, plan: structuredClone(args.plan) })],
  ]) await t.test(name, async () => {
    const f = fixture()
    const commit = createRawContextCommit(f.ctx, { verify: makeVerify(f) })
    const result = await commit({ owner: f.owner, authority: f.authority, proof: f.proof, plan: f.plan })
    assert.deepEqual(result, { error: { code: 'OUTCOME_UNKNOWN' } })
    assert.equal(Object.hasOwn(f.state.raw.providers.custom.models[0], 'contextWindow'), false)
    assert.equal(JSON.stringify(result).includes('synthetic-secret'), false)
  })
})

test('non-pi entries and builtin or mismatched directory entries are refused before editing', async t => {
  for (const [name, change] of [
    ['fake module', f => { f.editor.configuration = () => [{ entry: { options: { id: 'llm-pi-ai', name: 'cordis:fixture-pi-ai' } } }] }],
    ['other module', f => { f.editor.configuration = () => [{ entry: { options: { id: 'llm-pi-ai', name: '@other/plugin' } } }] }],
    ['builtin provider', f => { f.llm.listConfigurableProviders = () => [{ provider: 'custom', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'custom'], declared: false }] }],
    ['directory path', f => { f.llm.listConfigurableProviders = () => [{ provider: 'custom', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'other'], declared: true }] }],
  ]) await t.test(name, async () => {
    const f = fixture(); change(f)
    assert.deepEqual(await f.run(), { error: { code: 'SETTINGS_UNAVAILABLE' } })
    assert.equal(f.state.calls, 0)
  })
})

test('entry identity getters and proxies are refused without being evaluated', async () => {
  for (const kind of ['entry', 'options', 'id', 'proxy']) {
    const f = fixture(); let touched = 0
    const invoke = () => { touched++; throw Error('must not run') }
    let entry = { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' } }
    let row = { entry }
    if (kind === 'entry') Object.defineProperty(row, 'entry', { get: invoke, enumerable: true })
    if (kind === 'options') Object.defineProperty(entry, 'options', { get: invoke, enumerable: true })
    if (kind === 'id') Object.defineProperty(entry.options, 'id', { get: invoke, enumerable: true })
    if (kind === 'proxy') row.entry = new Proxy(entry, { getOwnPropertyDescriptor: invoke })
    f.editor.configuration = () => [row]
    assert.deepEqual(await f.run(), { error: { code: 'SETTINGS_UNAVAILABLE' } })
    assert.equal(touched, 0)
    assert.equal(f.state.calls, 0)
  }
})

test('lost acknowledgement and nonvoid result are unknown and never retried', async () => {
  for (const mode of ['lost', 'nonvoid']) {
    const f = fixture(), edit = f.editor.edit
    f.editor.edit = async (...args) => { await edit(...args); if (mode === 'lost') throw Error('synthetic-secret'); return true }
    assert.deepEqual(await f.run(), { error: { code: 'OUTCOME_UNKNOWN' } })
    assert.equal(f.state.calls, 1)
    assert.equal(f.state.raw.providers.custom.models[0].contextWindow, 64000)
  }
})
