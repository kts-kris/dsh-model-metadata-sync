import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

// One disposable Host process, no real profile, provider, credentials or network.
// WebServer/WebApp and provider directory/credentials/transport are fixtures.
// Connection's Peer and authentication registry and DSH Settings are real; this
// deliberately does not test production cookies or cross-process exclusion.
const file = fileURLToPath(import.meta.url)
const repo = path.resolve(path.dirname(file), '..')
const marker = 'dsh-metadata-vertical-'
const childKey = 'DSH_METADATA_VERTICAL_CHILD'
const tmp = fs.realpathSync('/tmp')
const base = '/dsh-model-metadata-sync'
const origin = 'http://127.0.0.1:31843'
const endpoint = 'https://relay.example.invalid/tenant-private/v1'
const credential = 'synthetic-bearer-987654321'
const inside = (parent, target) => {
  const rel = path.relative(parent, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

if (process.env[childKey] !== '1') {
  test('installed Host entry persists a selected model in an OS-isolated profile', t => {
    const executable = process.env.DSH_NODE_EXECUTABLE
    const installDir = process.env.DSH_INSTALL_DIR
    if (process.platform !== 'darwin' || !executable || !installDir || !path.isAbsolute(executable) ||
        !path.isAbsolute(installDir) || !fs.existsSync(executable) || !fs.existsSync('/usr/bin/sandbox-exec')) {
      t.skip('inconclusive: needs macOS sandbox-exec and installed DSH Electron runtime')
      return
    }
    const owned = fs.mkdtempSync(path.join(tmp, marker))
    assert.equal(path.dirname(owned), tmp)
    const home = process.env.HOME && fs.realpathSync(process.env.HOME)
    assert.ok(!inside(repo, owned) && (!home || !inside(home, owned)))
    try {
      const dirs = Object.fromEntries(['home', 'data', 'config', 'cache', 'temp', 'profile'].map(name => {
        const dir = path.join(owned, name)
        fs.mkdirSync(dir)
        return [name, dir]
      }))
      const escaped = owned.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
      const policy = `(version 1)(allow default)(deny network*)(deny file-write* (regex #"^/"))(allow file-write* (subpath "${escaped}"))`
      const result = spawnSync('/usr/bin/sandbox-exec', ['-p', policy, executable, file], {
        cwd: owned, encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024,
        env: { PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1', HOME: dirs.home, USERPROFILE: dirs.home,
          DSH_HOME: dirs.data, DSH_DATA_DIR: dirs.data, XDG_DATA_HOME: dirs.data,
          XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache, TMPDIR: dirs.temp,
          DSH_INSTALL_DIR: installDir, DSH_TEST_PROFILE: dirs.profile, [childKey]: '1' },
      })
      assert.equal(result.error, undefined, `sandbox child failed: ${result.error}`)
      assert.equal(result.signal, null, `sandbox child interrupted: ${result.signal}`)
      assert.equal(result.status, 0, `vertical test failed:\n${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /REAL_METADATA_VERTICAL_VERIFIED=1\b/, `missing completion evidence:\n${result.stdout}\n${result.stderr}`)
      console.log('Verified installed Loader/Settings/ConfigEditor/PluginManager and actual plugin entry with fixture transport in the OS sandbox.')
    } finally {
      const resolved = fs.realpathSync(owned)
      assert.equal(resolved, owned)
      assert.equal(path.dirname(resolved), tmp)
      assert.match(path.basename(resolved), /^dsh-metadata-vertical-/)
      fs.rmSync(resolved, { recursive: true, force: true })
    }
  })
} else {
  test('real Settings sink is reached through the entry and authenticated fixture carrier', async () => {
    const profileDir = process.env.DSH_TEST_PROFILE
    const owned = path.dirname(profileDir || '')
    if (path.dirname(owned) !== tmp || !path.basename(owned).startsWith(marker) ||
        !['HOME', 'USERPROFILE', 'DSH_HOME', 'DSH_DATA_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'DSH_TEST_PROFILE']
          .every(key => process.env[key] && path.dirname(process.env[key]) === owned)) {
      throw Error('refusing to initialize without owned profile and isolated home')
    }
    // Probe without creating any file, even if invoked without sandbox-exec.
    let fd
    try {
      assert.throws(() => { fd = fs.openSync('/dev/null', 'w') }, e => ['EPERM', 'EACCES'].includes(e.code),
        'OS sandbox did not deny outside writes')
    } finally { if (fd !== undefined) fs.closeSync(fd) }
    const net = await import('node:net')
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: 9 })
      socket.once('connect', () => { socket.destroy(); reject(Error('OS sandbox allowed network')) })
      socket.once('error', error => ['EPERM', 'EACCES'].includes(error.code) ? resolve() : reject(error))
    })
    const fromDsh = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'))
    assert.equal(fromDsh('@deepseek-ai/dsh/package.json').version, '0.2.3-alpha.2')
    assert.ok(process.versions.electron, 'must use the installed Electron runtime')
    const { registerHooks } = await import('node:module')
    const schemaUrl = pathToFileURL(fromDsh.resolve('@deepseek-ai/schemastery'))
    const repoUrl = pathToFileURL(`${repo}${path.sep}`).href
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === '@deepseek-ai/schemastery' && context.parentURL?.startsWith(repoUrl)) return { url: schemaUrl.href, shortCircuit: true }
      return next(specifier, context)
    } })
    const load = name => import(pathToFileURL(fromDsh.resolve(name)).href)
    const [boot, editor, settingsModule, pi, managerModule, connectionModule, plugin] = await Promise.all([
      load('@deepseek-ai/dsh-app-boot'), load('@deepseek-ai/dsh-config-editor'), load('@deepseek-ai/dsh-settings'),
      load('@deepseek-ai/dsh-llm-pi-ai'), load('@deepseek-ai/dsh-plugin-manager'), load('@deepseek-ai/dsh-client-connection'),
      import('../lib/index.js'),
    ])
    let fetchCalls = 0
    globalThis.fetch = async (url, options) => {
      fetchCalls++
      assert.equal(String(url), `${endpoint}/models`)
      assert.equal(new Headers(options.headers).get('authorization'), `Bearer ${credential}`)
      return new Response(JSON.stringify({ data: [{ id: 'existing' }, { id: 'chosen' }, { id: 'ignored' }] }),
        { headers: { 'content-type': 'application/json' } })
    }
    const routes = new Map()
    const webServer = { host: '127.0.0.1', protocol: 'http:', register(route) {
      assert.ok(!routes.has(route.path), `duplicate path ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    } }
    const provider = { api: 'openai-completions', baseURL: endpoint, apiKeyEnv: 'FAKE_CREDENTIAL',
      models: [{ id: 'existing', reasoningEfforts: { off: null, high: 'high' }, compat: { supportsStore: false } }] }
    const configPath = path.join(profileDir, 'cordis.yml')
    const patchPath = path.join(profileDir, 'cordis.patch.yml')
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'isolated-metadata-profile', private: true, dsh: { profile: { bundles: [] } } }))
    fs.writeFileSync(configPath, '[]\n')
    fs.writeFileSync(patchPath, JSON.stringify([
      { insert: [
        { id: 'llm-pi-ai', name: 'cordis:fixture-pi-ai', config: {} },
        { id: 'original-sync', name: '@goodandready/dsh-model-sync', disabled: true },
        { id: 'metadata-fork', name: 'cordis:metadata-fork', config: { referenceEnabled: false } },
      ] },
      { id: 'llm-pi-ai', config: { providers: { sample: provider } } },
    ], null, 2))
    const profile = { name: 'isolated', dir: profileDir, patchPath, installAnchor: path.join(process.env.DSH_INSTALL_DIR, 'package.json'),
      cwd: owned, home: process.env.DSH_HOME, startedBundles: [], overlayPaths: [], telemetryDisabledEnv: '1' }
    let mountCount = 0
    let credentialCalls = 0
    const fixture = { name: 'fixture-pi-ai', Config: pi.Config, apply() { mountCount++ } }
    const llm = { listConfigurableProviders: () => [{ provider: 'sample', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'sample'] }],
      listProviders: () => [{ id: 'sample' }] }
    const credentials = { async resolve(ref) { credentialCalls++; assert.equal(ref, 'FAKE_CREDENTIAL'); return { value: credential } } }
    const app = await boot.boot('dsh-test', configPath, boot.readProfilePatches('dsh-test', profile), async ctx => {
      ctx.provide('profileContext', profile)
      ctx.provide('webServer', webServer)
      ctx.provide('webApp', { getAdvertisedUrl: () => origin })
      ctx.provide('llm', llm)
      ctx.provide('credentials', credentials)
      ctx.loader.builtins['fixture-pi-ai'] = fixture
      ctx.loader.builtins['metadata-fork'] = plugin
      await ctx.plugin(editor.ConfigEditor)
      await ctx.plugin(settingsModule.SettingsForms)
      await ctx.plugin(managerModule.PluginManager, {})
      await ctx.plugin(connectionModule)
    })
    let owner, disposeVerifier
    try {
      const settings = app.get('settings')
      const manager = app.get('pluginManager')
      const connection = app.get('connection')
      assert.ok(settings && manager && connection)
      const rows = await manager.listPlugins()
      const original = rows.find(row => row.moduleName === '@goodandready/dsh-model-sync')
      assert.equal(original?.enabled, false)
      assert.equal(original?.fiberPhase, null)
      assert.equal(mountCount, 1)
      const describe = () => {
        const matches = settings.describe({ redactSecrets: true }).filter(row => row.ns === 'llm-pi-ai')
        assert.equal(matches.length, 1)
        return matches[0]
      }
      const before = describe()
      assert.deepEqual(before.user.providers.sample, provider)
      assert.equal(before.applies, 'live')
      owner = connection.createPeer({ principal: { kind: 'owner' } })
      disposeVerifier = connection.authentication.register({ authenticate(request) {
        if (request.headers.authorization === 'Synthetic owner') return owner
      } })
      async function request(suffix, body, authorized = true) {
        const route = routes.get(base + suffix)
        assert.ok(route, `entry did not register ${suffix}`)
        assert.equal(route.auth, 'required')
        const text = JSON.stringify(body)
        const headers = { host: '127.0.0.1:31843', origin, 'sec-fetch-site': 'same-origin',
          'content-type': 'application/json', authorization: authorized ? 'Synthetic owner' : 'Synthetic invalid' }
        // This is an in-memory carrier. It asks the actual Connection to admit
        // the fixture's synthetic credential before invoking the registered route.
        const admission = connection.admit({ headers, url: `${origin}${base}${suffix}`, socket: { destroyed: false } })
        if (!admission.peer) return { status: admission.rejection }
        const req = Readable.from([Buffer.from(text)])
        Object.assign(req, { method: 'POST', headers })
        const res = new EventEmitter()
        const response = { text: '' }
        Object.assign(res, { writableFinished: false, destroyed: false,
          writeHead(status, resultHeaders) { response.status = status; response.headers = resultHeaders; return this },
          end(value = '') { response.text += value; this.writableFinished = true; return this } })
        await route.handler(req, res, admission.peer)
        response.body = JSON.parse(response.text)
        assert.equal(response.headers['cache-control'], 'no-store')
        return response
      }
      assert.equal((await request('/preview', { provider: 'sample', selectedNewIds: ['chosen'] }, false)).status, 401)
      const preview = async () => {
        const result = await request('/preview', { provider: 'sample', selectedNewIds: ['chosen'] })
        assert.equal(result.status, 200, result.text)
        assert.equal(result.body.writeEnabled, true)
        assert.deepEqual(result.body.changes, [{ type: 'add-model', modelId: 'chosen' }])
        assert.equal(result.body.sources.reference.status, 'disabled')
        return { previewId: result.body.previewId, digest: result.body.digest }
      }
      // Derive both refusals from the real inventory, with a synthetic override
      // of just the original row; this is not a real original-plugin lifecycle.
      const actualList = manager.listPlugins.bind(manager)
      try {
        for (const replacement of [{ enabled: true, fiberPhase: 'active' }, { enabled: false, fiberPhase: 'unknown' }]) {
          const confirmation = await preview()
          const persisted = fs.readFileSync(patchPath, 'utf8')
          manager.listPlugins = async () => (await actualList()).map(row => row.moduleName === '@goodandready/dsh-model-sync' ? { ...row, ...replacement } : row)
          const denied = await request('/apply', confirmation)
          assert.equal(denied.status, 409, denied.text)
          assert.equal(denied.body.error.code, 'ORIGINAL_WRITER_ACTIVE')
          assert.equal(fs.readFileSync(patchPath, 'utf8'), persisted)
          manager.listPlugins = actualList
        }
      } finally { manager.listPlugins = actualList }
      const confirmation = await preview()
      const savedBeforeApply = fs.readFileSync(patchPath, 'utf8')
      const applied = await request('/apply', confirmation)
      assert.equal(applied.status, 200, applied.text)
      assert.equal(applied.body.status, 'applied')
      const after = describe()
      assert.ok(after.revision > before.revision)
      assert.deepEqual(after.user.providers.sample, { ...provider, models: [...provider.models, { id: 'chosen' }] })
      assert.deepEqual(after.value.providers.sample.models.map(model => model.id), ['existing', 'chosen'])
      assert.equal(after.user.providers.sample.models[0].compat.supportsStore, false)
      assert.equal(after.user.providers.sample.models[0].reasoningEfforts.off, null)
      const persisted = fs.readFileSync(patchPath, 'utf8')
      assert.notEqual(persisted, savedBeforeApply)
      assert.match(persisted, /chosen/)
      assert.doesNotMatch(persisted, /ignored/)
      const replay = await request('/apply', confirmation)
      assert.equal(replay.status, 409)
      assert.equal(replay.body.error.code, 'REPREVIEW_REQUIRED')
      assert.equal(fs.readFileSync(patchPath, 'utf8'), persisted)
      assert.equal(mountCount, 1)
      assert.ok(fetchCalls >= 4 && credentialCalls >= 4)
      const retained = routes.get(`${base}/preview`)
      await app.fiber.dispose()
      assert.ok(!routes.has(`${base}/preview`) && !routes.has(`${base}/apply`), 'unload must remove routes')
      assert.equal(owner.signal.aborted, true, 'unload disposes Peer')
      assert.ok(retained, 'route existed before unload')
      console.log('REAL_METADATA_VERTICAL_VERIFIED=1')
    } finally {
      await disposeVerifier?.()
      await owner?.dispose()
      await app.fiber.dispose()
    }
  })
}
