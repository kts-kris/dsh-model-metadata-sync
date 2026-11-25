import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// The production entry and route handlers are exercised in a fake Host. The
// child has no inherited profile, credentials, or usable network transport.
const filename = fileURLToPath(import.meta.url)
const repo = path.resolve(path.dirname(filename), '..')
if (process.env.METADATA_STATUS_CHILD !== '1') {
  test('status and reference routes in an isolated fake Host', () => {
    const child = spawnSync(process.execPath, ['--test', filename], {
      cwd: repo, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      env: {
        PATH: '/usr/bin:/bin', HOME: '/nonexistent-metadata-status-home',
        USERPROFILE: '/nonexistent-metadata-status-home',
        DSH_HOME: '/nonexistent-metadata-status-data', DSH_DATA_DIR: '/nonexistent-metadata-status-data',
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        METADATA_STATUS_CHILD: '1',
      },
    })
    assert.equal(child.error, undefined, `child failed to start: ${child.error}`)
    assert.equal(child.signal, null, `child terminated: ${child.signal}`)
    assert.equal(child.status, 0, `isolated status tests failed:\n${child.stdout}\n${child.stderr}`)
    assert.match(child.stdout, /(?:#|ℹ)\s+tests [1-9]\d*/, 'zero executed tests are not evidence')
    console.log(`isolated status routes: ${child.stdout.match(/(?:#|ℹ)\s+tests (\d+)/)?.[1]} cases`)
  })
} else {
  const { registerHooks, syncBuiltinESMExports } = await import('node:module')
  const blockedNetwork = []
  const denyNetwork = () => { blockedNetwork.push(true); throw new Error('network forbidden by fixture') }
  globalThis.fetch = denyNetwork
  for (const [name, methods] of [
    ['node:http', ['request', 'get']], ['node:https', ['request', 'get']],
    ['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']],
    ['node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6']], ['node:dgram', ['createSocket']],
  ]) {
    const module = (await import(name)).default
    for (const method of methods) module[method] = denyNetwork
  }
  // Fake the isolated fixed worker before importing the real entry. The caller
  // also runs this entire child under a system network-deny sandbox.
  const { EventEmitter } = await import('node:events')
  let workerState = { status: 'complete', calls: [] }
  class FakeWorker extends EventEmitter {
    constructor(entry, options) {
      super()
      this.state = workerState
      this.state.calls.push({ entry: entry.href, options, worker: this })
      queueMicrotask(() => {
        if (this.terminated) return
        if (this.state.status === 'complete') this.emit('message', JSON.stringify([{ synthetic: true }]))
        this.emit('exit', this.state.status === 'complete' ? 0 : 1)
      })
    }
    terminate() { this.terminated = true; queueMicrotask(() => this.emit('exit', 1)); return Promise.resolve(1) }
  }
  ;(await import('node:worker_threads')).default.Worker = FakeWorker
  syncBuiltinESMExports()

  // Schema is the only import shim on ordinary Node; no business factory is
  // replaced. Under Electron use the real read-only packaged Schemastery.
  let schema
  if (process.versions.electron) {
    schema = 'file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs'
  } else {
    try { import.meta.resolve('@deepseek-ai/schemastery') } catch {
      const source = `const field = () => ({ default() { return this }, volatile() { return this } }); export default { boolean: field, object: value => value }`
      schema = `data:text/javascript,${encodeURIComponent(source)}`
    }
  }
  if (schema) registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/schemastery') return { url: schema, shortCircuit: true }
    return nextResolve(specifier, context)
  } })
  const { Readable, PassThrough } = await import('node:stream')
  const { apply, createForkReferenceSettings } = await import('../lib/index.js')
  const SECRET = 'SYNTHETIC_ONLY_SECRET_4729'
  const ENDPOINT = 'https://private-tenant.example.invalid/v1'
  const BASE = '/dsh-model-metadata-sync'
  const owner = { principal: { kind: 'owner' }, signal: new AbortController().signal }

  function fakeHost() {
    const routes = new Map()
    const effects = []
    const entry = { id: 'dsh-model-metadata-sync' }
    const config = { referenceEnabled: true, unrelated: 'preserve' }
    const host = {
      directory: [
        { provider: 'sample', displayName: SECRET, settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'sample'], defaultBaseURL: ENDPOINT },
        { provider: 'dormant', displayName: SECRET, settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'dormant'] },
        { provider: 'not-registered', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'not-registered'] },
      ],
      registered: [{ id: 'sample', name: SECRET }, { id: 'dormant', name: SECRET }],
      values: { providers: { sample: { api: 'openai-completions', baseURL: ENDPOINT, headers: { authorization: SECRET } }, 'not-registered': {} } },
      effects,
    }
    const editor = { async edit(target, change) {
      assert.equal(target, entry)
      Object.assign(config, change({ ...config }))
      effects.push('own-entry-edit')
    } }
    const services = {
      configEditor: editor,
      llm: {
        listConfigurableProviders: () => host.directory,
        listProviders: () => host.registered,
        stream: () => { effects.push('inference'); throw new Error('forbidden') },
      },
      settings: {
        describe: options => { assert.deepEqual(options, { redactSecrets: true }); return [{ ns: 'llm-pi-ai', value: host.values, revision: 1, secrets: [] }] },
        update: () => { effects.push('settings update') }, mutate: () => { effects.push('settings mutate') }, replace: () => { effects.push('settings replace') },
      },
    }
    const ctx = {
      fiber: { entry },
      get(name) { return services[name] },
      get llm() { throw Error('llm is not injected') },
      get settings() { throw Error('settings is not injected') },
      credentials: { resolve: () => { effects.push('credential resolution'); throw new Error('forbidden') } },
      webApp: { getAdvertisedUrl: () => 'http://127.0.0.1:3000' },
      webServer: { register(route) { assert.equal(routes.has(route.path), false); routes.set(route.path, route); return () => routes.delete(route.path) } },
      logger: { error: () => {}, warn: () => {} },
      effect(fn) { host.dispose = fn() },
    }
    apply(ctx, { referenceEnabled: { get: () => config.referenceEnabled } })
    return { ctx, routes, config, host, entry, editor, services }
  }

  async function invoke(route, { method = 'GET', raw = '', origin = 'http://127.0.0.1:3000', site = 'same-origin', peer = owner, contentType = 'application/json', input } = {}) {
    const req = input ?? Readable.from([Buffer.from(raw)])
    Object.assign(req, { method, headers: { host: '127.0.0.1:3000', origin, 'sec-fetch-site': site, 'content-type': contentType } })
    const out = { data: '' }
    const res = {
      writeHead(status, headers) { out.status = status; out.headers = headers; return this },
      end(data = '') { out.data += data; return this },
    }
    await route.handler(req, res, peer)
    out.body = JSON.parse(out.data)
    return out
  }

  test('real entry registers a single-use confirmation for an exact explicit-model addition', async () => {
    const originalFetch = globalThis.fetch
    const requests = []
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), authorization: new Headers(options.headers).get('authorization') })
      assert.equal(String(url), `${ENDPOINT}/models`)
      return new Response(JSON.stringify({ data: [{ id: 'old' }, { id: 'new' }] }), { headers: { 'content-type': 'application/json' } })
    }
    let f
    try {
      f = fakeHost()
      f.config.referenceEnabled = false
      let revision = 7
      const route = { api: 'openai-completions', baseURL: ENDPOINT, apiKeyEnv: 'SYNTHETIC_KEY',
        models: [{ id: 'old', custom: null, reasoningEfforts: false }] }
      const section = { providers: { sample: route }, unrelated: { preserve: true } }
      f.services.settings.describe = () => [{ ns: 'llm-pi-ai', revision, applies: 'live', secrets: [],
        value: structuredClone(section), user: structuredClone(section), base: { providers: { sample: {} } } }]
      f.services.credentials = { resolve: async () => ({ value: SECRET }) }
      f.services.pluginManager = { listPlugins: async () => [] }
      f.services.settings.mutate = async (ns, ops, expected) => {
        assert.equal(ns, 'llm-pi-ai'); assert.equal(expected, revision)
        for (const op of ops) {
          let target = section
          for (const part of op.path.slice(0, -1)) target = target[part]
          target[op.path.at(-1)] = structuredClone(op.value)
        }
        f.host.effects.push('mutate'); revision++
      }
      const p = await invoke(f.routes.get(`${BASE}/preview`), { method: 'POST',
        peer: { principal: { kind: 'owner' }, signal: new AbortController().signal },
        raw: JSON.stringify({ provider: 'sample', selectedNewIds: ['new'] }) })
      assert.equal(p.status, 200, p.data)
      assert.deepEqual(p.body.changes, [{ type: 'add-model', modelId: 'new' }])
      assert.equal(p.body.sources.reference.status, 'disabled')
      assert.deepEqual(f.host.effects, [], 'preview is read-only')
      const raw = JSON.stringify({ previewId: p.body.previewId, digest: p.body.digest })
      const confirmation = { method: 'POST', raw, peer: { principal: { kind: 'owner' }, signal: new AbortController().signal } }
      const applied = await invoke(f.routes.get(`${BASE}/apply`), confirmation)
      assert.equal(applied.body.status, 'applied', applied.data)
      assert.deepEqual(section.providers.sample.models, [{ id: 'old', custom: null, reasoningEfforts: false }, { id: 'new' }])
      assert.deepEqual(section.unrelated, { preserve: true })
      assert.equal((await invoke(f.routes.get(`${BASE}/apply`), confirmation)).body.error.code, 'REPREVIEW_REQUIRED')
      assert.deepEqual(f.host.effects, ['mutate'])
      // An active or indeterminate original plugin blocks a newly confirmed plan.
      for (const plugin of [
        { moduleName: '@goodandready/dsh-model-sync', enabled: true, fiberPhase: 'active' },
        { moduleName: '@goodandready/dsh-model-sync', enabled: false, fiberPhase: 'loading' },
      ]) {
        section.providers.sample.models.pop()
        f.services.pluginManager.listPlugins = async () => [plugin]
        const next = await invoke(f.routes.get(`${BASE}/preview`), { method: 'POST',
          raw: JSON.stringify({ provider: 'sample', selectedNewIds: ['new'] }) })
        const refused = await invoke(f.routes.get(`${BASE}/apply`), { method: 'POST',
          raw: JSON.stringify({ previewId: next.body.previewId, digest: next.body.digest }) })
        assert.equal(refused.body.error.code, 'ORIGINAL_WRITER_ACTIVE', refused.data)
        assert.deepEqual(f.host.effects, ['mutate'])
        // restore only this isolated synthetic fixture for the next case
        section.providers.sample.models.push({ id: 'new' })
      }
      // Disabled preference starts no worker; enabled preference remains unknown
      // even on complete worker output and changes in status require re-preview.
      assert.equal(workerState.calls.length, 0)
      f.services.pluginManager.listPlugins = async () => []
      section.providers.sample.models.pop()
      f.config.referenceEnabled = true
      workerState = { status: 'complete', calls: [] }
      const withReference = await invoke(f.routes.get(`${BASE}/preview`), { method: 'POST',
        raw: JSON.stringify({ provider: 'sample', selectedNewIds: ['new'] }) })
      assert.equal(withReference.status, 200, withReference.data)
      assert.equal(withReference.body.sources.reference.status, 'unknown')
      assert.equal(withReference.body.sources.reference.lookupStatus, 'complete')
      assert.equal(workerState.calls.length, 1)
      assert.equal(workerState.calls[0].entry.endsWith('/lib/reference-worker-entry.js'), true)
      assert.deepEqual(workerState.calls[0].options.env, {})
      assert.equal(Object.hasOwn(workerState.calls[0].options, 'workerData'), false)
      workerState.status = 'unknown'
      const changed = await invoke(f.routes.get(`${BASE}/apply`), { method: 'POST',
        raw: JSON.stringify({ previewId: withReference.body.previewId, digest: withReference.body.digest }) })
      assert.equal(changed.body.error.code, 'REPREVIEW_REQUIRED', changed.data)
      assert.deepEqual(f.host.effects, ['mutate'])
      f.config.referenceEnabled = false
      const noReference = await invoke(f.routes.get(`${BASE}/preview`), { method: 'POST',
        raw: JSON.stringify({ provider: 'sample', selectedNewIds: ['new'] }) })
      assert.equal(noReference.body.sources.reference.status, 'disabled')
      const count = workerState.calls.length
      f.config.referenceEnabled = true
      const disabledChanged = await invoke(f.routes.get(`${BASE}/apply`), { method: 'POST',
        raw: JSON.stringify({ previewId: noReference.body.previewId, digest: noReference.body.digest }) })
      assert.equal(disabledChanged.body.error.code, 'REPREVIEW_REQUIRED')
      assert.equal(workerState.calls.length, count)
      assert.deepEqual(f.host.effects, ['mutate'])
      assert.ok(requests.length >= 1)
      for (const secret of [SECRET, ENDPOINT, 'SYNTHETIC_KEY']) assert.equal(p.data.includes(secret), false)
      assert.deepEqual(blockedNetwork, [])
    } finally { f?.host.dispose(); globalThis.fetch = originalFetch }
  })

  test('real entry displays authenticated OpenRouter candidates without issuing write authority', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), 'https://openrouter.ai/api/v1/models')
      assert.equal(new Headers(options.headers).has('authorization'), false)
      return new Response(JSON.stringify({ data: [{ id: 'old' }, { id: 'vendor/model', context_length: 64000,
        top_provider: { max_completion_tokens: 4096 }, reasoning: { mandatory: false, supported_efforts: ['high'] } }],
        links: { next: null }, total_count: 2 }),
      { headers: { 'content-type': 'application/json' } })
    }
    const f = fakeHost()
    try {
      f.config.referenceEnabled = false
      const section = { providers: { sample: { api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1', models: [{ id: 'old' }] } } }
      f.services.settings.describe = () => [{ ns: 'llm-pi-ai', revision: 7, applies: 'live', secrets: [],
        value: structuredClone(section), user: structuredClone(section), base: { providers: { sample: {} } } }]
      const p = await invoke(f.routes.get(`${BASE}/preview`), { method: 'POST',
        raw: JSON.stringify({ provider: 'sample', selectedNewIds: ['vendor/model'] }) })
      assert.equal(p.status, 200, p.data)
      assert.equal(p.body.writeEnabled, false)
      assert.equal(p.body.authority, 'unavailable')
      assert.equal('previewId' in p.body, false)
      assert.equal('digest' in p.body, false)
      assert.deepEqual(p.body.changes, [{ type: 'add-model', modelId: 'vendor/model' }])
      const item = p.body.items.find(row => row.modelId === 'vendor/model')
      assert.equal(item.fields.find(row => row.field === 'contextWindow').candidate, 64000)
      assert.deepEqual(item.fields.find(row => row.field === 'maxTokens').candidate, { value: 4096, scope: 'top-provider', applicable: false })
      assert.ok(item.fields.every(row => row.state === 'unknown'))
      const forged = await invoke(f.routes.get(`${BASE}/apply`), { method: 'POST',
        raw: JSON.stringify({ previewId: 'A'.repeat(43), digest: '0'.repeat(64) }) })
      assert.equal(forged.body.error.code, 'REPREVIEW_REQUIRED')
      assert.deepEqual(f.host.effects, [])
      assert.deepEqual(blockedNetwork, [])
    } finally { f.host.dispose(); globalThis.fetch = originalFetch }
  })

  test('status exposes only configured, registered provider IDs and a live reference preference', async () => {
    const f = fakeHost()
    const route = f.routes.get(`${BASE}/status`)
    assert.equal(route.auth, 'required')
    const result = await invoke(route)
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, { providers: [{ id: 'sample', status: 'unknown', lastAttemptAt: null }], referenceEnabled: true })
    assert.equal(result.headers['cache-control'], 'no-store')
    assert.doesNotMatch(result.data, /SYNTHETIC_ONLY_SECRET|private-tenant|authorization|baseURL|settingsNs|displayName/)
    assert.deepEqual(f.host.effects, [])
    assert.deepEqual(blockedNetwork, [])
    f.host.dispose()
  })

  test('reference preference writes only the fork entry and is reflected by the next status read', async () => {
    const f = fakeHost()
    const route = f.routes.get(`${BASE}/reference-settings`)
    assert.equal(route.auth, 'required')
    const result = await invoke(route, { method: 'POST', raw: '{"enabled":false}' })
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, { referenceEnabled: false })
    assert.deepEqual(f.config, { referenceEnabled: false, unrelated: 'preserve' })
    assert.deepEqual(f.host.effects, ['own-entry-edit'])
    const status = await invoke(f.routes.get(`${BASE}/status`))
    assert.equal(status.body.referenceEnabled, false)
    assert.deepEqual(blockedNetwork, [])
    f.host.dispose()
  })

  test('a live client receives unknown after a stalled editor reaches the request deadline', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const f = fakeHost()
    let release, started, finished, editorCalls = 0
    const gate = new Promise(resolve => { release = resolve })
    const entered = new Promise(resolve => { started = resolve })
    const editorDone = new Promise(resolve => { finished = resolve })
    f.editor.edit = async (target, change) => {
      try {
        assert.equal(target, f.entry)
        editorCalls++
        started()
        await gate
        Object.assign(f.config, change({ ...f.config }))
      } finally { finished() }
    }
    let completed = false
    const pending = invoke(f.routes.get(`${BASE}/reference-settings`), { method: 'POST', raw: '{"enabled":false}' })
      .then(result => { completed = true; return result })
    try {
      await entered
      t.mock.timers.tick(14999)
      await Promise.resolve()
      assert.equal(completed, false, 'deadline must not fire early')
      t.mock.timers.tick(1)
      for (let i = 0; i < 8; i++) await Promise.resolve()
      assert.equal(completed, true, 'live peer and response cannot hold HTTP open after 15 seconds')
      const result = await pending
      assert.equal(result.status, 503)
      assert.equal(result.body.error.code, 'OUTCOME_UNKNOWN')
      assert.equal(editorCalls, 1, 'a timed-out edit is not retried')
      assert.deepEqual(f.config, { referenceEnabled: true, unrelated: 'preserve' })
      assert.deepEqual(blockedNetwork, [])
    } finally {
      f.host.dispose()
      release()
      await pending
      await editorDone
    }
  })

  test('stalled edits retain the owner budget across timeout, unload and module reload until actual settlement', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const f = fakeHost()
    const requests = []
    const gates = []
    let started = 0
    const entered = []
    f.editor.edit = async (target, change) => {
      assert.equal(target, f.entry)
      const gate = new Promise(resolve => gates.push(resolve))
      entered.shift()?.()
      started++
      await gate
      Object.assign(f.config, change({ ...f.config }))
    }
    const launch = () => {
      const ready = new Promise(resolve => entered.push(resolve))
      const request = invoke(f.routes.get(`${BASE}/reference-settings`), { method: 'POST', raw: '{"enabled":false}' })
      requests.push(request)
      return ready
    }
    let reloaded, second
    try {
      for (let i = 0; i < 4; i++) await launch()
      t.mock.timers.tick(15000)
      for (const result of await Promise.all(requests)) assert.equal(result.body.error.code, 'OUTCOME_UNKNOWN')
      assert.equal((await invoke(f.routes.get(`${BASE}/reference-settings`), { method: 'POST', raw: '{"enabled":false}' })).body.error.code, 'CONFIG_BUSY')
      assert.equal(started, 4)
      f.host.dispose()
      second = fakeHost()
      assert.equal((await invoke(second.routes.get(`${BASE}/reference-settings`), { method: 'POST', raw: '{"enabled":false}' })).body.error.code, 'CONFIG_BUSY')
      // A distinct ESM evaluation represents a reloaded plugin module in the
      // same Host process; it must not manufacture a fresh allowance.
      const { registerHttpApi } = await import('../lib/http.js?reference-budget-test')
      const routes = new Map()
      const ctx = Object.create(second.ctx)
      ctx.webServer = { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } }
      const settings = createForkReferenceSettings(ctx, { referenceEnabled: { get: () => second.config.referenceEnabled } })
      const registrations = registerHttpApi(ctx, {}, { referenceSettings: settings })
      reloaded = () => { settings.dispose(); for (const dispose of registrations) dispose?.() }
      assert.equal((await invoke(routes.get(`${BASE}/reference-settings`), { method: 'POST', raw: '{"enabled":false}' })).body.error.code, 'CONFIG_BUSY')
      gates.shift()()
      for (let i = 0; i < 12; i++) await Promise.resolve()
      const saved = await invoke(second.routes.get(`${BASE}/reference-settings`), { method: 'POST', raw: '{"enabled":false}' })
      assert.equal(saved.status, 200, saved.data)
      assert.equal(second.config.referenceEnabled, false)
      assert.equal(started, 4, 'timeout and busy responses do not retry edits')
      assert.deepEqual(blockedNetwork, [])
    } finally {
      reloaded?.()
      second?.host.dispose()
      f.host.dispose()
      for (const release of gates) release()
      for (let i = 0; i < 12; i++) await Promise.resolve()
    }
  })

  test('unload promptly ends a stalled HTTP request without releasing its editor', async () => {
    const f = fakeHost()
    let release, started, finished
    const gate = new Promise(resolve => { release = resolve })
    const entered = new Promise(resolve => { started = resolve })
    const editorDone = new Promise(resolve => { finished = resolve })
    f.editor.edit = async (target, change) => {
      try { started(); await gate; Object.assign(f.config, change({ ...f.config })) } finally { finished() }
    }
    let completed = false
    const pending = invoke(f.routes.get(`${BASE}/reference-settings`), { method: 'POST', raw: '{"enabled":false}' })
      .then(result => { completed = true; return result })
    try {
      await entered
      f.host.dispose()
      for (let i = 0; i < 8; i++) await Promise.resolve()
      assert.equal(completed, true, 'unload must not await the editor')
      const result = await pending
      assert.equal(result.status, 503)
      assert.equal(result.body.error.code, 'OUTCOME_UNKNOWN')
      assert.deepEqual(f.config, { referenceEnabled: true, unrelated: 'preserve' })
    } finally { release(); await pending; await editorDone }
  })

  test('status fails closed for unavailable or ambiguous Host information without echoing it', async () => {
    for (const mode of ['missing-llm', 'missing-settings', 'directory', 'registered', 'settings', 'duplicate', 'getter']) {
      const f = fakeHost()
      let invoked = false
      if (mode === 'missing-llm') delete f.services.llm
      if (mode === 'missing-settings') delete f.services.settings
      if (mode === 'directory') f.services.llm.listConfigurableProviders = () => { throw Error(SECRET) }
      if (mode === 'registered') delete f.services.llm.listProviders
      if (mode === 'settings') f.services.settings.describe = () => { throw Error(SECRET) }
      if (mode === 'duplicate') f.host.directory.push({ ...f.host.directory[0] })
      if (mode === 'getter') Object.defineProperty(f.host.values.providers, 'sample', { get() { invoked = true; return { secret: SECRET } } })
      const response = await invoke(f.routes.get(`${BASE}/status`))
      assert.equal(response.status, 503, mode)
      assert.equal(response.body.error.code, 'SETTINGS_UNAVAILABLE', mode)
      assert.doesNotMatch(response.data, /SYNTHETIC_ONLY_SECRET|private-tenant|authorization|baseURL|settingsNs|displayName/)
      assert.equal(invoked, false)
      assert.deepEqual(f.host.effects, [])
      f.host.dispose()
    }
  })

  test('strict method, JSON, and boolean validation never edits settings', async () => {
    const f = fakeHost()
    const status = f.routes.get(`${BASE}/status`)
    const settings = f.routes.get(`${BASE}/reference-settings`)
    for (const method of ['POST', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) {
      const response = await invoke(status, { method })
      assert.equal(response.status, 405, `status ${method}`)
    }
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) {
      const response = await invoke(settings, { method })
      assert.equal(response.status, 405, `settings ${method}`)
    }
    for (const raw of ['', '{}', 'null', '[]', '{"enabled":"false"}', '{"enabled":1}',
      '{"enabled":false,"enabled":true}', '{"enabled":false,"extra":true}', '{"enabled":false} junk',
      `{${' '.repeat(1024)}"enabled":false}`]) {
      const response = await invoke(settings, { method: 'POST', raw })
      assert.equal(response.status, 400)
      assert.equal(response.body.error.code, 'INVALID_CONFIG')
    }
    for (const contentType of ['text/plain', 'application/jsonp']) {
      assert.equal((await invoke(settings, { method: 'POST', raw: '{"enabled":false}', contentType })).status, 400)
    }
    assert.deepEqual(f.host.effects, [])
    f.host.dispose()
  })

  test('invalid preview and confirmation requests remain effect-free', async () => {
    const f = fakeHost()
    const invalid = await invoke(f.routes.get(`${BASE}/preview`), { method: 'POST', raw: '{}' })
    assert.equal(invalid.status, 422)
    assert.equal(invalid.body.error.code, 'INVALID_RESPONSE')
    for (const suffix of ['/apply', '/preview/cancel']) {
      const response = await invoke(f.routes.get(`${BASE}${suffix}`), { method: 'POST', raw: '{}' })
      assert.equal(response.status, 422)
      assert.equal(response.body.error.code, 'INVALID_RESPONSE')
    }
    assert.deepEqual(f.host.effects, [])
    f.host.dispose()
  })

  test('owner admission and CSRF defenses run before settings parsing or Host access', async () => {
    const f = fakeHost()
    const settings = f.routes.get(`${BASE}/reference-settings`)
    for (const [request, expected] of [
      [{ peer: null }, 401],
      [{ peer: { principal: { kind: 'non-owner' }, signal: new AbortController().signal } }, 403],
      [{ origin: 'https://attacker.invalid' }, 403],
      [{ origin: 'https://127.0.0.1:3000' }, 403],
      [{ site: 'cross-site' }, 403], [{ site: null }, 403],
    ]) {
      const response = await invoke(settings, { method: 'POST', raw: '{"enabled":false}', ...request })
      assert.equal(response.status, expected)
    }
    assert.deepEqual(f.host.effects, [])
    f.host.dispose()
  })

  test('aborted owner during body read cannot invoke the editor after the body arrives', async () => {
    const f = fakeHost()
    const controller = new AbortController()
    const peer = { principal: { kind: 'owner' }, signal: controller.signal }
    const input = new PassThrough()
    let editorCalls = 0
    const edit = f.editor.edit
    f.editor.edit = (...args) => { editorCalls++; return edit(...args) }
    const pending = invoke(f.routes.get(`${BASE}/reference-settings`), { method: 'POST', input, peer })
    input.write('{"enabled":')
    controller.abort()
    input.end('false}')
    const result = await pending
    assert.notEqual(result.status, 200)
    assert.equal(editorCalls, 0)
    assert.deepEqual(f.config, { referenceEnabled: true, unrelated: 'preserve' })
    assert.deepEqual(f.host.effects, [])
    f.host.dispose()
  })

  test('closed response revokes a queued preference write even when the admitted peer stays live', async () => {
    const f = fakeHost()
    const controller = new AbortController()
    const peer = { principal: { kind: 'owner' }, signal: controller.signal }
    const input = new PassThrough()
    Object.assign(input, { method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000',
      'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } })
    const res = new EventEmitter()
    const output = { writesAfterClose: 0 }
    Object.assign(res, {
      writableFinished: false, destroyed: false,
      writeHead() { if (this.destroyed) output.writesAfterClose++; return this },
      end() { if (this.destroyed) output.writesAfterClose++; else this.writableFinished = true; return this },
    })
    let release, started, editorFinished
    const gate = new Promise(resolve => { release = resolve })
    const entered = new Promise(resolve => { started = resolve })
    const editorDone = new Promise(resolve => { editorFinished = resolve })
    f.editor.edit = async (target, change) => {
      try {
        assert.equal(target, f.entry)
        started()
        await gate
        Object.assign(f.config, change({ ...f.config }))
        f.host.effects.push('own-entry-edit')
      } finally { editorFinished() }
    }
    const requestClosed = new Promise(resolve => input.once('close', resolve))
    const pending = f.routes.get(`${BASE}/reference-settings`).handler(input, res, peer)
    input.end('{"enabled":false}')
    try {
      await entered
      await requestClosed
      assert.equal(input.readableEnded, true, 'normal request close follows the completed body')
      assert.equal(controller.signal.aborted, false)
      assert.deepEqual(f.host.effects, [])
      res.destroyed = true
      res.emit('close')
      const settledBeforeRelease = await Promise.race([
        pending.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100)),
      ])
      release()
      await pending
      await editorDone
      assert.deepEqual(f.config, { referenceEnabled: true, unrelated: 'preserve' }, 'the queued callback must not save')
      assert.deepEqual(f.host.effects, [])
      assert.equal(settledBeforeRelease, true, 'a disconnected client must not hold the handler on a stalled editor')
      assert.equal(output.writesAfterClose, 0, 'a closed response cannot deliver any receipt')
      assert.equal(controller.signal.aborted, false)
      assert.deepEqual(blockedNetwork, [])
    } finally {
      release()
      await pending
      f.host.dispose()
    }
  })

  test('an unfinished response disconnect after callback dispatch has an unknown write outcome', async () => {
    const f = fakeHost()
    const controller = new AbortController()
    const peer = { principal: { kind: 'owner' }, signal: controller.signal }
    const input = new PassThrough()
    Object.assign(input, { method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000',
      'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } })
    const res = new EventEmitter()
    let writesAfterClose = 0, release, dispatched, editorFinished
    Object.assign(res, { writableFinished: false, destroyed: false,
      writeHead() { if (this.destroyed) writesAfterClose++; return this },
      end() { if (this.destroyed) writesAfterClose++; else this.writableFinished = true; return this },
    })
    const gate = new Promise(resolve => { release = resolve })
    const started = new Promise(resolve => { dispatched = resolve })
    const editorDone = new Promise(resolve => { editorFinished = resolve })
    f.editor.edit = async (target, change) => {
      try {
        assert.equal(target, f.entry)
        const saved = change({ ...f.config })
        dispatched()
        await gate
        Object.assign(f.config, saved)
        f.host.effects.push('own-entry-edit')
      } finally { editorFinished() }
    }
    const pending = f.routes.get(`${BASE}/reference-settings`).handler(input, res, peer)
    input.end('{"enabled":false}')
    try {
      await started
      res.destroyed = true
      res.emit('close')
      const settledBeforeRelease = await Promise.race([
        pending.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100)),
      ])
      release()
      await pending
      await editorDone
      assert.equal(settledBeforeRelease, true)
      assert.equal(writesAfterClose, 0, 'no receipt can be delivered after close')
      assert.deepEqual(f.config, { referenceEnabled: false, unrelated: 'preserve' }, 'dispatch can still complete')
      assert.deepEqual(f.host.effects, ['own-entry-edit'], 'no automatic retry')
      assert.equal(controller.signal.aborted, false)
      assert.equal(input.listenerCount('aborted'), 0)
      assert.equal(res.listenerCount('close'), 0)
      assert.deepEqual(blockedNetwork, [])
    } finally {
      release()
      await pending
      f.host.dispose()
    }
  })

  test('dispose while the editor is queued prevents its callback from saving', async () => {
    const f = fakeHost()
    let release, started
    const gate = new Promise(resolve => { release = resolve })
    const entered = new Promise(resolve => { started = resolve })
    f.editor.edit = async (target, change) => {
      assert.equal(target, f.entry)
      started()
      await gate
      Object.assign(f.config, change({ ...f.config }))
      f.host.effects.push('own-entry-edit')
    }
    const pending = invoke(f.routes.get(`${BASE}/reference-settings`), { method: 'POST', raw: '{"enabled":false}' })
    await entered
    f.host.dispose()
    release()
    const result = await pending
    assert.notEqual(result.status, 200)
    assert.deepEqual(f.config, { referenceEnabled: true, unrelated: 'preserve' })
    assert.deepEqual(f.host.effects, [])
  })

  test('owner abort while the editor is queued prevents its callback from saving', async () => {
    const f = fakeHost()
    const controller = new AbortController()
    const peer = { principal: { kind: 'owner' }, signal: controller.signal }
    let release, started
    const gate = new Promise(resolve => { release = resolve })
    const entered = new Promise(resolve => { started = resolve })
    f.editor.edit = async (target, change) => {
      assert.equal(target, f.entry)
      started()
      await gate
      Object.assign(f.config, change({ ...f.config }))
      f.host.effects.push('own-entry-edit')
    }
    let completed = false
    const pending = invoke(f.routes.get(`${BASE}/reference-settings`), { method: 'POST', raw: '{"enabled":false}', peer })
      .then(result => { completed = true; return result })
    try {
      await entered
      controller.abort()
      for (let i = 0; i < 8; i++) await Promise.resolve()
      assert.equal(completed, true, 'peer abort cannot wait for the editor')
      const result = await pending
      assert.equal(result.status, 503)
      assert.equal(result.body.error.code, 'OUTCOME_UNKNOWN')
    } finally {
      release()
      await pending
      f.host.dispose()
      for (let i = 0; i < 8; i++) await Promise.resolve()
    }
    assert.deepEqual(f.config, { referenceEnabled: true, unrelated: 'preserve' })
    assert.deepEqual(f.host.effects, [])
  })

  test('a body with too many empty chunks is rejected even within the byte budget', async () => {
    const f = fakeHost()
    const input = new PassThrough()
    const pending = invoke(f.routes.get(`${BASE}/reference-settings`), { method: 'POST', input })
    for (let i = 0; i < 256; i++) input.emit('data', Buffer.alloc(0))
    input.end('{"enabled":false}')
    const result = await pending
    assert.equal(result.status, 400)
    assert.deepEqual(f.config, { referenceEnabled: true, unrelated: 'preserve' })
    assert.deepEqual(f.host.effects, [])
    input.destroy()
    f.host.dispose()
  })

  test('an invalid content type safely stops the stream and cleans its error guard on close', async () => {
    const f = fakeHost()
    const input = new PassThrough()
    const result = await invoke(f.routes.get(`${BASE}/reference-settings`), { method: 'POST', input, contentType: 'text/plain' })
    assert.equal(result.status, 400)
    assert.doesNotThrow(() => input.emit('error', new Error('late synthetic error')))
    input.destroy()
    await new Promise(resolve => input.once('close', resolve))
    assert.equal(input.listenerCount('error'), 0)
    assert.deepEqual(f.host.effects, [])
    f.host.dispose()
  })

  test('request abort after destroy cannot leak a pending stream error', async () => {
    const f = fakeHost()
    const input = new PassThrough()
    const pending = invoke(f.routes.get(`${BASE}/reference-settings`), { method: 'POST', input })
    input.write('{"enabled":')
    input.destroy(new Error('late synthetic error'))
    input.emit('aborted')
    const result = await pending
    assert.equal(result.status, 400)
    await new Promise(resolve => input.once('close', resolve))
    assert.equal(input.listenerCount('error'), 0)
    assert.deepEqual(f.host.effects, [])
    f.host.dispose()
  })

  test('peer abort ends a stalled body read and removes read listeners', async () => {
    const f = fakeHost()
    const controller = new AbortController()
    const input = new PassThrough()
    const peer = { principal: { kind: 'owner' }, signal: controller.signal }
    const pending = invoke(f.routes.get(`${BASE}/reference-settings`), { method: 'POST', input, peer })
    input.write('{"enabled":')
    controller.abort()
    const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve(null), 100))])
    assert.ok(result, 'abort should not wait for the body timeout')
    assert.notEqual(result.status, 200)
    for (const event of ['data', 'end', 'aborted']) assert.equal(input.listenerCount(event), 0)
    assert.doesNotThrow(() => input.emit('error', new Error('late synthetic error')))
    input.destroy()
    assert.deepEqual(f.host.effects, [])
    f.host.dispose()
  })

  test('an incomplete request hits its deadline without a settings write', async () => {
    const f = fakeHost()
    const route = f.routes.get(`${BASE}/reference-settings`)
    const req = new PassThrough()
    Object.assign(req, { method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000',
      'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } })
    const response = { data: '' }
    const res = { writeHead(status) { response.status = status; return this }, end(data = '') { response.data += data; return this } }
    req.write('{"enabled":')
    const actual = await Promise.race([
      route.handler(req, res, owner).then(() => response.status),
      new Promise(resolve => setTimeout(() => resolve('pending'), 6500)),
    ])
    assert.equal(actual, 400, 'an incomplete JSON body must not hold the request forever')
    for (const event of ['data', 'end', 'aborted']) assert.equal(req.listenerCount(event), 0)
    assert.doesNotThrow(() => req.emit('error', new Error('late synthetic error')))
    req.destroy()
    await new Promise(resolve => req.once('close', resolve))
    assert.equal(req.listenerCount('error'), 0)
    assert.deepEqual(f.host.effects, [])
    f.host.dispose()
  })

  test('configuration errors are sanitized and unload revokes retained write callbacks', async () => {
    const f = fakeHost()
    const route = f.routes.get(`${BASE}/reference-settings`)
    for (const edit of [() => { throw Error(SECRET) }, async () => { throw Error(SECRET) }]) {
      f.ctx.get = () => ({ edit })
      for (let i = 0; i < 5; i++) {
        const rejected = await invoke(route, { method: 'POST', raw: '{"enabled":false}' })
        assert.equal(rejected.status, 409)
        assert.equal(rejected.body.error.code, 'WRITE_REJECTED')
        assert.equal(rejected.data.includes(SECRET), false)
      }
    }
    f.ctx.get = () => f.editor
    assert.equal((await invoke(route, { method: 'POST', raw: '{"enabled":false}' })).status, 200, 'settled failures cannot leak permits')
    f.host.effects.length = 0
    f.ctx.get = () => undefined
    const unavailable = await invoke(route, { method: 'POST', raw: '{"enabled":false}' })
    assert.equal(unavailable.status, 503)
    assert.equal(unavailable.body.error.code, 'CONFIG_UNAVAILABLE')
    f.ctx.get = () => f.editor
    f.host.dispose()
    const stale = await invoke(route, { method: 'POST', raw: '{"enabled":false}' })
    assert.equal(stale.status, 503)
    assert.equal(stale.body.error.code, 'CONFIG_UNAVAILABLE')
    assert.deepEqual(f.host.effects, [])
    assert.deepEqual(blockedNetwork, [])
  })
}
