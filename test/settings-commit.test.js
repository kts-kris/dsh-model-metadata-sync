import test from 'node:test'
import assert from 'node:assert/strict'
import { createSettingsCommit } from '../lib/settings-commit.js'

// Synthetic in-memory Settings/PluginManager only: no profile, credentials or network.
class FakeSettingsConflictError extends Error {
  constructor(expected, actual) {
    super('synthetic conflict')
    this.code = 'SETTINGS_CONFLICT'
    this.expected = expected
    this.actual = actual
  }
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function fixture(options = {}) {
  const state = {
    revision: 7,
    section: { providers: { sample: { models: [
      { id: 'old', input: null, reasoningEfforts: false, opaque: { keep: false } },
    ], headers: { authorization: 'synthetic-secret' } } }, unrelated: { keep: null } },
    calls: [],
  }
  const approved = freeze({
    target: { namespace: 'llm-pi-ai', provider: 'sample', providerPath: ['providers', 'sample'],
      protocol: 'openai-completions', endpointFingerprint: 'a'.repeat(64) },
    selectedNewIds: [],
    changes: [{ type: 'set-field', scope: 'models', modelId: 'old', index: 0, field: 'contextWindow', value: 64000 }],
  })
  const settings = {
    describe(options) {
      assert.deepEqual(options, { redactSecrets: true })
      return [{ ns: 'llm-pi-ai', revision: state.revision, applies: 'live',
        value: structuredClone(state.section), user: structuredClone(state.section),
        base: { providers: { sample: {} } }, secrets: [] }]
    },
    async mutate(ns, ops, expected) {
      state.calls.push({ ns, ops: structuredClone(ops), expected })
      if (expected !== state.revision) throw new FakeSettingsConflictError(expected, state.revision)
      for (const op of ops) {
        let node = state.section
        for (const part of op.path.slice(0, -1)) node = node[part]
        node[op.path.at(-1)] = structuredClone(op.value)
      }
      state.revision++
      // Real Settings.mutate resolves to void.
    },
  }
  const pluginManager = { listPlugins: async () => [] }
  const recompute = async ({ revision }) => ({
    plan: approved,
    evidence: { revision, fields: [{ modelId: 'old', field: 'contextWindow',
      status: 'absent', explicit: 'absent', catalog: 'absent', routeDefault: 'absent', counterpart: null }] },
  })
  const makeCommit = (dependencies = {}) => createSettingsCommit({ settings, pluginManager, recompute,
    SettingsConflictError: FakeSettingsConflictError, ...options, ...dependencies })
  const commit = makeCommit()
  return { state, approved, settings, pluginManager, recompute, commit, makeCommit }
}

test('commits a confirmed model-field path without restating unrelated user or credential data', async () => {
  const f = fixture()
  assert.deepEqual(await f.commit(f.approved), { status: 'applied' })
  assert.deepEqual(f.state.calls, [{ ns: 'llm-pi-ai', expected: 7,
    ops: [{ op: 'set', path: ['providers', 'sample', 'models', '0', 'contextWindow'], value: 64000 }] }])
  assert.deepEqual(f.state.section.providers.sample.models, [
    { id: 'old', input: null, reasoningEfforts: false, opaque: { keep: false }, contextWindow: 64000 },
  ])
  assert.deepEqual(f.state.section.unrelated, { keep: null })
  assert.equal(f.state.section.providers.sample.headers.authorization, 'synthetic-secret')
  assert.doesNotMatch(JSON.stringify(f.state.calls), /synthetic-secret|authorization|headers/)
})

test('retries only authenticated no-write conflicts and preserves unrelated revisions', async () => {
  const f = fixture({ proveNoWriteConflict: () => true })
  const mutate = f.settings.mutate
  let conflicts = 2
  f.settings.mutate = async (...args) => {
    if (conflicts-- > 0) {
      f.state.calls.push({ ns: args[0], ops: structuredClone(args[1]), expected: args[2] })
      f.state.revision++
      f.state.section.unrelated.keep = 'concurrent edit'
      throw new FakeSettingsConflictError(args[2], f.state.revision)
    }
    return mutate(...args)
  }
  assert.deepEqual(await f.commit(f.approved), { status: 'applied' })
  assert.deepEqual(f.state.calls.map(call => call.expected), [7, 8, 9])
  assert.equal(f.state.section.unrelated.keep, 'concurrent edit')
  assert.equal(f.state.section.providers.sample.models[0].contextWindow, 64000)
})

test('a proven conflict never replays a changed target, selection or diff', async () => {
  for (const modify of [
    p => { p.target.endpointFingerprint = 'b'.repeat(64) },
    p => { p.selectedNewIds.push('new') },
    p => { p.changes[0].value = 32000 },
  ]) {
    const f = fixture({ proveNoWriteConflict: () => true })
    const changed = structuredClone(f.approved); modify(changed); freeze(changed)
    let recomputes = 0
    const commit = f.makeCommit({ recompute: async input => {
      const result = await f.recompute(input)
      if (++recomputes > 1) result.plan = changed
      return result
    } })
    f.settings.mutate = async (...args) => {
      f.state.calls.push({ expected: args[2] }); f.state.revision++
      throw new FakeSettingsConflictError(args[2], f.state.revision)
    }
    assert.deepEqual(await commit(f.approved), { error: { code: 'REPREVIEW_REQUIRED' } })
    assert.equal(f.state.calls.length, 1)
    assert.equal(f.state.section.providers.sample.models[0].contextWindow, undefined)
  }
})

test('exhausted proven conflicts stop after three attempts', async () => {
  const f = fixture({ proveNoWriteConflict: () => true })
  f.settings.mutate = async (...args) => {
    f.state.calls.push({ expected: args[2] }); f.state.revision++
    throw new FakeSettingsConflictError(args[2], f.state.revision)
  }
  assert.deepEqual(await f.commit(f.approved), { error: { code: 'REVISION_CONFLICT' } })
  assert.deepEqual(f.state.calls.map(call => call.expected), [7, 8, 9])
})

test('a lost acknowledgement or an unproven conflict is outcome unknown and is never replayed', async () => {
  for (const kind of ['lost-ack', 'unproven-conflict', 'fake-code', 'nonvoid']) {
    const f = fixture()
    const mutate = f.settings.mutate
    f.settings.mutate = async (...args) => {
      if (kind === 'unproven-conflict') {
        f.state.calls.push({ expected: args[2] })
        throw new FakeSettingsConflictError(args[2], args[2] + 1)
      }
      if (kind === 'fake-code') {
        f.state.calls.push({ expected: args[2] })
        throw Object.assign(Error('synthetic-secret'), { code: 'SETTINGS_CONFLICT' })
      }
      await mutate(...args)
      if (kind === 'lost-ack') throw Error('synthetic-secret lost ack')
      return { success: true }
    }
    const result = await f.commit(f.approved)
    assert.deepEqual(result, { error: { code: 'OUTCOME_UNKNOWN' } }, kind)
    assert.equal(f.state.calls.length, 1)
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/)
  }
})

test('original plugin must be absent or demonstrably disabled and stopped', async () => {
  for (const [rows, expected] of [
    [[], 'applied'],
    [[{ moduleName: '@goodandready/dsh-model-sync', enabled: false, fiberPhase: null }], 'applied'],
    [[{ moduleName: '@goodandready/dsh-model-sync', enabled: true, fiberPhase: null }], 'ORIGINAL_WRITER_ACTIVE'],
    [[{ moduleName: '@goodandready/dsh-model-sync', enabled: false, fiberPhase: 'active' }], 'ORIGINAL_WRITER_ACTIVE'],
    [[{ moduleName: '@goodandready/dsh-model-sync', enabled: false }], 'SETTINGS_UNAVAILABLE'],
    [[{}], 'SETTINGS_UNAVAILABLE'],
  ]) {
    const f = fixture()
    f.pluginManager.listPlugins = async () => rows
    const result = await f.commit(f.approved)
    assert.equal(result.status ?? result.error.code, expected)
    assert.equal(f.state.calls.length, expected === 'applied' ? 1 : 0)
  }
  const f = fixture()
  f.pluginManager.listPlugins = async () => { throw Error('unavailable') }
  assert.equal((await f.commit(f.approved)).error.code, 'SETTINGS_UNAVAILABLE')
  assert.equal(f.state.calls.length, 0)
})

test('a nonempty explicit model list appends only selected unique IDs in approved order', async () => {
  const f = fixture()
  const plan = structuredClone(f.approved)
  plan.selectedNewIds = ['new-a', 'new-b']
  plan.changes = [
    { type: 'add-model', modelId: 'new-a' },
    { type: 'add-model', modelId: 'new-b' },
  ]
  freeze(plan)
  const commit = f.makeCommit({ recompute: async ({ revision }) => ({ plan, evidence: { revision, fields: [] } }) })
  assert.deepEqual(await commit(plan), { status: 'applied' })
  assert.deepEqual(f.state.section.providers.sample.models, [
    { id: 'old', input: null, reasoningEfforts: false, opaque: { keep: false } },
    { id: 'new-a' }, { id: 'new-b' },
  ])
  assert.deepEqual(f.state.calls[0].ops, [
    { op: 'set', path: ['providers', 'sample', 'models', '1'], value: { id: 'new-a' } },
    { op: 'set', path: ['providers', 'sample', 'models', '2'], value: { id: 'new-b' } },
  ])
})

test('a claimed absent counterpart cannot override an actually configured opposite capacity', async () => {
  const f = fixture()
  f.state.section.providers.sample.models[0].maxTokens = 128000
  assert.notEqual((await f.commit(f.approved)).status, 'applied')
  assert.equal(f.state.calls.length, 0)
  assert.equal(f.state.section.providers.sample.models[0].maxTokens, 128000)
})

test('rejects absent counterpart evidence when the effective model exposes an output limit', async () => {
  const f = fixture()
  const describe = f.settings.describe
  f.settings.describe = options => {
    const rows = describe(options)
    rows[0].value.providers.sample.models[0].maxTokens = 128000
    return rows
  }

  assert.deepEqual(await f.commit(f.approved), { error: { code: 'SETTINGS_UNAVAILABLE' } })
  assert.deepEqual(f.state.calls, [])
  assert.equal(f.state.section.providers.sample.models[0].contextWindow, undefined)
})

test('commits when effective counterpart and same-revision evidence agree within capacity', async () => {
  const f = fixture()
  const describe = f.settings.describe
  f.settings.describe = options => {
    const rows = describe(options)
    rows[0].value.providers.sample.models[0].maxTokens = 32000
    return rows
  }
  const commit = f.makeCommit({ recompute: async ({ revision }) => ({
    plan: f.approved,
    evidence: { revision, fields: [{ modelId: 'old', field: 'contextWindow',
      status: 'absent', explicit: 'absent', catalog: 'absent', routeDefault: 'absent', counterpart: 32000 }] },
  }) })

  assert.deepEqual(await commit(f.approved), { status: 'applied' })
  assert.deepEqual(f.state.calls, [{ ns: 'llm-pi-ai', expected: 7,
    ops: [{ op: 'set', path: ['providers', 'sample', 'models', '0', 'contextWindow'], value: 64000 }] }])
})

test('rejects contradictory visible base models and effective route defaults', async () => {
  for (const scenario of ['base-model-field', 'base-model-counterpart', 'effective-default', 'effective-opposite-default']) {
    const f = fixture()
    const describe = f.settings.describe
    f.settings.describe = options => {
      const rows = describe(options)
      if (scenario === 'base-model-field') rows[0].base.providers.sample.models = [{ id: 'old', contextWindow: 96000 }]
      if (scenario === 'base-model-counterpart') rows[0].base.providers.sample.models = [{ id: 'old', maxTokens: 128000 }]
      if (scenario === 'effective-default') rows[0].value.providers.sample.defaultContextWindow = 96000
      if (scenario === 'effective-opposite-default') rows[0].value.providers.sample.defaultMaxTokens = 128000
      return rows
    }
    assert.deepEqual(await f.commit(f.approved), { error: { code: 'SETTINGS_UNAVAILABLE' } }, scenario)
    assert.equal(f.state.calls.length, 0, scenario)
  }
})

test('protected, inherited, hidden, malformed, or unknown settings are never overwritten', async () => {
  for (const scenario of ['false', 'null', 'override', 'implicit-list', 'default', 'unknown-catalog', 'missing-sidecar', 'index', 'duplicate-ns']) {
    const f = fixture()
    const route = f.state.section.providers.sample
    if (scenario === 'false') route.models[0].contextWindow = false
    if (scenario === 'null') route.models[0].contextWindow = null
    if (scenario === 'override') route.modelOverrides = {}
    if (scenario === 'implicit-list') delete route.models
    if (scenario === 'default') route.defaultContextWindow = 1
    let commit = f.commit
    if (scenario === 'unknown-catalog') commit = f.makeCommit({ recompute: async ({ revision }) => ({
      plan: f.approved, evidence: { revision, fields: [{ modelId: 'old', field: 'contextWindow', status: 'unknown',
        explicit: 'absent', catalog: 'unknown', routeDefault: 'absent', counterpart: null }] },
    }) })
    if (scenario === 'missing-sidecar') {
      const describe = f.settings.describe
      f.settings.describe = options => { const rows = describe(options); delete rows[0].secrets; return rows }
    }
    if (scenario === 'index') route.models[0].id = 'different'
    if (scenario === 'duplicate-ns') {
      const describe = f.settings.describe
      f.settings.describe = options => { const rows = describe(options); return [...rows, rows[0]] }
    }
    const result = await commit(f.approved)
    assert.ok(result.error, scenario)
    assert.equal(f.state.calls.length, 0, scenario)
  }
})
