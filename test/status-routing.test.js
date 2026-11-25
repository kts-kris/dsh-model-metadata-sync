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
  const { apply } = await import('../lib/index.js')
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

  test('preview and apply remain unavailable and effect-free', async () => {
    const f = fakeHost()
    for (const suffix of ['/preview', '/apply', '/preview/cancel']) {
      const response = await invoke(f.routes.get(`${BASE}${suffix}`), { method: 'POST', raw: '{}' })
      assert.equal(response.status, 503)
      assert.equal(response.body.error.code, 'AUTHORITY_UNAVAILABLE')
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
    const pending = invoke(f.routes.get(`${BASE}/reference-settings`), { method: 'POST', raw: '{"enabled":false}', peer })
    await entered
    controller.abort()
    release()
    const result = await pending
    assert.notEqual(result.status, 200)
    assert.deepEqual(f.config, { referenceEnabled: true, unrelated: 'preserve' })
    assert.deepEqual(f.host.effects, [])
    f.host.dispose()
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
    f.ctx.get = () => ({ edit: async () => { throw Error(SECRET) } })
    const rejected = await invoke(route, { method: 'POST', raw: '{"enabled":false}' })
    assert.equal(rejected.status, 409)
    assert.equal(rejected.body.error.code, 'WRITE_REJECTED')
    assert.equal(rejected.data.includes(SECRET), false)
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
