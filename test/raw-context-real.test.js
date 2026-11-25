import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

// This is an isolated integration probe of the *unmounted candidate sink*, not
// production authorization, a live provider, or the original plugin's races.
// The directory and the verifier are synthetic; Loader, Entry, ConfigEditor,
// Settings and the pi-ai Config schema come from the installed DSH distribution.
const file = fileURLToPath(import.meta.url)
const repo = path.resolve(path.dirname(file), '..')
const childKey = 'DSH_RAW_CONTEXT_REAL_CHILD'
const marker = 'dsh-raw-context-real-'
const inside = (base, target) => {
  const rel = path.relative(base, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

if (process.env[childKey] !== '1') {
  test('installed ConfigEditor commits raw context in an offline disposable profile', t => {
    const executable = process.env.DSH_NODE_EXECUTABLE
    const installDir = process.env.DSH_INSTALL_DIR
    if (process.platform !== 'darwin' || !executable || !installDir || !path.isAbsolute(executable) ||
        !path.isAbsolute(installDir) || !fs.existsSync(executable) || !fs.existsSync('/usr/bin/sandbox-exec')) {
      t.skip('inconclusive: requires installed macOS DSH Electron and sandbox-exec')
      return
    }
    const tmp = fs.realpathSync('/tmp')
    if (tmp !== '/private/tmp') { t.skip('inconclusive: /tmp does not resolve to /private/tmp'); return }
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
      if (result.status === 0 && result.stdout.includes('RAW_CONTEXT_INCONCLUSIVE=')) {
        t.skip(result.stdout.match(/RAW_CONTEXT_INCONCLUSIVE=([^\n]+)/)?.[1] ?? 'installed runtime unavailable')
        return
      }
      assert.equal(result.status, 0, `raw-context integration failed:\n${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /RAW_CONTEXT_REAL_VERIFIED=1\b/, `missing positive evidence:\n${result.stdout}\n${result.stderr}`)
      console.log('Installed Loader/Entry, ConfigEditor, Settings and pi.Config verified with an inert module and synthetic verifier.')
    } finally {
      const resolved = fs.realpathSync(owned)
      assert.equal(resolved, owned)
      assert.equal(path.dirname(resolved), tmp)
      assert.match(path.basename(resolved), /^dsh-raw-context-real-/)
      fs.rmSync(resolved, { recursive: true, force: true })
    }
  })
} else {
  test('real entry and editor write one existing model, then reload the profile', async t => {
    const tmp = fs.realpathSync('/tmp')
    const profileDir = process.env.DSH_TEST_PROFILE
    const owned = path.dirname(profileDir || '')
    const envDirs = ['HOME', 'USERPROFILE', 'DSH_HOME', 'DSH_DATA_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'DSH_TEST_PROFILE']
    if (tmp !== '/private/tmp' || path.dirname(owned) !== tmp || !path.basename(owned).startsWith(marker) ||
        !envDirs.every(key => process.env[key] && path.dirname(process.env[key]) === owned && fs.realpathSync(process.env[key]) === process.env[key])) {
      throw Error('refusing to initialize outside an owned disposable profile')
    }
    // A side-effect-free outside write probe and a denied loopback connection
    // must both succeed before any fixture file or host service is created.
    let fd, deniedWrite = false
    try { fd = fs.openSync('/dev/null', 'w') } catch (error) { deniedWrite = ['EPERM', 'EACCES'].includes(error.code) }
    finally { if (fd !== undefined) fs.closeSync(fd) }
    if (!deniedWrite) {
      console.log('RAW_CONTEXT_INCONCLUSIVE=OS sandbox outside-write denial not verified')
      t.skip('OS sandbox unavailable'); return
    }
    const net = await import('node:net')
    const deniedNetwork = await new Promise(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port: 9 })
      socket.once('connect', () => { socket.destroy(); resolve(false) })
      socket.once('error', error => resolve(['EPERM', 'EACCES'].includes(error.code)))
    })
    if (!deniedWrite || !deniedNetwork) {
      console.log('RAW_CONTEXT_INCONCLUSIVE=OS sandbox write and network denials not both verified')
      t.skip('OS sandbox unavailable'); return
    }
    const fromDsh = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'))
    let version
    try { version = fromDsh('@deepseek-ai/dsh/package.json').version } catch {
      console.log('RAW_CONTEXT_INCONCLUSIVE=installed DSH package unavailable')
      t.skip('installed DSH unavailable'); return
    }
    if (version !== '0.2.3-alpha.2' || !process.versions.electron) {
      console.log('RAW_CONTEXT_INCONCLUSIVE=requires installed DSH 0.2.3-alpha.2 Electron runtime')
      t.skip('unsupported installed runtime'); return
    }
    const load = name => import(pathToFileURL(fromDsh.resolve(name)).href)
    const [boot, editorModule, settingsModule, pi, loader, include, sink] = await Promise.all([
      load('@deepseek-ai/dsh-app-boot'), load('@deepseek-ai/dsh-config-editor'), load('@deepseek-ai/dsh-settings'),
      load('@deepseek-ai/dsh-llm-pi-ai'), load('@deepseek-ai/cordis-plugin-loader'),
      load('@deepseek-ai/cordis-plugin-include'), import('../lib/raw-context-commit.js'),
    ])
    const moduleName = '@deepseek-ai/dsh-llm-pi-ai'
    // Redirect exactly this import, not a Loader entry: Loader itself creates
    // the entry with the required original options.name. The lazy module is
    // inert and exposes the installed Config object, never pi-ai's apply().
    const fixtureModule = path.join(owned, 'inert-pi-fixture.mjs')
    fs.writeFileSync(fixtureModule, `export const name = 'llm-pi-ai';\nexport const Config = globalThis[Symbol.for('raw-context-real.Config')];\nexport function apply() { globalThis[Symbol.for('raw-context-real.mounts')]++; }\n`)
    globalThis[Symbol.for('raw-context-real.Config')] = pi.Config
    globalThis[Symbol.for('raw-context-real.mounts')] = 0
    const { registerHooks } = await import('node:module')
    let redirects = 0
    const hooks = registerHooks({ resolve(specifier, context, next) {
      if (specifier === moduleName) { redirects++; return { url: pathToFileURL(fixtureModule).href, shortCircuit: true } }
      return next(specifier, context)
    } })
    const bundleDir = path.join(profileDir, 'node_modules', 'raw-context-fixture-bundle')
    fs.mkdirSync(bundleDir, { recursive: true })
    fs.writeFileSync(path.join(bundleDir, 'package.json'), JSON.stringify({ name: 'raw-context-fixture-bundle', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    const inherited = { providers: {}, inheritedOnly: { keepFalse: false, keepNull: null } }
    const lower = [{ insert: [{ id: 'llm-pi-ai', name: moduleName, config: inherited }] }]
    fs.writeFileSync(path.join(bundleDir, 'cordis.patch.yml'), JSON.stringify(lower))
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'isolated-raw-context-profile', private: true,
      dsh: { profile: { bundles: ['raw-context-fixture-bundle'] } } }))
    const configPath = path.join(profileDir, 'cordis.yml')
    const patchPath = path.join(profileDir, 'cordis.patch.yml')
    fs.writeFileSync(configPath, '[]\n')
    const route = { api: 'openai-completions', baseURL: 'https://fixture.invalid/v1', headers: { 'x-fixture': 'keep' },
      models: [{ id: 'existing', maxTokens: 8192, reasoningEfforts: { off: null, high: 'high' }, compat: { supportsStore: false } },
        { id: 'other', maxTokens: 4096, reasoningEfforts: false }] }
    const raw = { providers: { sample: route }, unrelated: { keepFalse: false, keepNull: null } }
    const userPatches = [{ id: 'llm-pi-ai', config: raw }, { insert: [{ id: 'other-row', name: 'cordis:other-fixture', disabled: true, config: { keep: false, nil: null } }] }]
    fs.writeFileSync(patchPath, JSON.stringify(userPatches, null, 2))
    const profile = { name: 'isolated', dir: profileDir, patchPath, installAnchor: path.join(process.env.DSH_INSTALL_DIR, 'package.json'),
      cwd: owned, home: process.env.DSH_HOME, startedBundles: [], overlayPaths: [], telemetryDisabledEnv: '1' }
    const directory = { listConfigurableProviders: () => [{ provider: 'sample', settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'sample'], declared: true }] }
    const start = () => boot.boot('dsh-raw-test', configPath, boot.readProfilePatches('dsh-raw-test', profile), async ctx => {
      ctx.provide('profileContext', profile)
      ctx.provide('llm', directory)
      await ctx.plugin(editorModule.ConfigEditor)
      await ctx.plugin(settingsModule.SettingsForms)
    })
    const loaded = boot.loadProfileDirectory('dsh-raw-test', profileDir, profile.installAnchor)
    assert.deepEqual(loaded.skippedBundles, [])
    assert.equal(loaded.layers.length, 1)
    let app = await start()
    try {
      assert.ok(redirects > 0, 'the installed Loader must import the inert named fixture')
      assert.equal(globalThis[Symbol.for('raw-context-real.mounts')], 1)
      const editor = app.get('configEditor'), settings = app.get('settings')
      assert.ok(editor instanceof editorModule.ConfigEditor && settings instanceof settingsModule.SettingsForms)
      assert.equal(app.get('llm'), directory)
      const row = () => {
        const matches = editor.configuration().filter(item => item.entry.options.id === 'llm-pi-ai')
        assert.equal(matches.length, 1)
        return matches[0]
      }
      const desc = () => {
        const matches = settings.describe({ redactSecrets: true }).filter(item => item.ns === 'llm-pi-ai')
        assert.equal(matches.length, 1)
        return matches[0]
      }
      const before = row(), beforeSettings = desc()
      assert.ok(before.entry instanceof loader.Entry, 'entry must be constructed by the installed Loader')
      assert.equal(before.entry.options.name, moduleName)
      assert.deepEqual(before.inherited, inherited)
      assert.deepEqual(before.override, raw)
      assert.deepEqual(before.entry.options.config, raw)
      assert.equal(beforeSettings.applies, 'live')
      assert.ok(Number.isSafeInteger(beforeSettings.revision))
      assert.deepEqual(beforeSettings.user.providers.sample, route)
      assert.equal(Object.hasOwn(beforeSettings.user.providers.sample.models[0], 'contextWindow'), false)
      const freeze = value => {
        if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
        return value
      }
      const owner = Object.freeze({ fixture: 'owner' }), authority = Object.freeze({ fixture: 'authority' }), proof = Object.freeze({ fixture: 'proof' })
      const plan = freeze({ revision: beforeSettings.revision, target: { namespace: 'llm-pi-ai', provider: 'sample',
        providerPath: ['providers', 'sample'], protocol: 'openai-completions', endpointFingerprint: 'a'.repeat(64) },
      modelIds: ['existing', 'other'], selectedNewIds: [], changes: [{ type: 'set-field', scope: 'models', modelId: 'existing',
        index: 0, field: 'contextWindow', value: 64000 }] })
      let verified = 0
      // This deliberately checks synthetic in-memory identities, not production
      // source authenticity, owner approval, replay prevention or original writer state.
      const commit = sink.createRawContextCommit(app, { verify(evidence) {
        assert.equal(evidence.owner, owner); assert.equal(evidence.authority, authority); assert.equal(evidence.proof, proof)
        assert.equal(evidence.plan, plan); assert.ok(Object.isFrozen(evidence))
        assert.equal(evidence.endpoint, 'https://fixture.invalid/v1/models')
        assert.equal(evidence.maxTokens, 8192); assert.equal(evidence.contextWindow, 64000)
        verified++
        return true
      } })
      const originalPatch = fs.readFileSync(patchPath, 'utf8')
      assert.deepEqual(await commit({ owner, authority, proof, plan }), { status: 'applied' })
      assert.equal(verified, 1)
      const expected = structuredClone(raw)
      expected.providers.sample.models[0].contextWindow = 64000
      const after = row(), afterSettings = desc()
      assert.equal(after.entry, before.entry)
      assert.deepEqual(after.inherited, inherited)
      assert.deepEqual(after.override, expected)
      assert.deepEqual(after.entry.options.config, expected)
      assert.ok(afterSettings.revision > beforeSettings.revision)
      assert.deepEqual(afterSettings.user.providers.sample, expected.providers.sample)
      assert.equal(afterSettings.value.providers.sample.models[0].contextWindow, 64000)
      assert.equal(afterSettings.value.providers.sample.models[0].maxTokens, 8192)
      const persisted = fs.readFileSync(patchPath, 'utf8')
      assert.notEqual(persisted, originalPatch)
      const parsed = include.parseEntryYaml(persisted)
      assert.deepEqual(parsed.find(item => item.id === 'llm-pi-ai').config, expected)
      assert.deepEqual(parsed.find(item => item.insert?.[0]?.id === 'other-row'), userPatches[1])
      assert.equal(fs.readFileSync(path.join(bundleDir, 'cordis.patch.yml'), 'utf8'), JSON.stringify(lower))
      await app.fiber.dispose()
      app = await start()
      const reloaded = app.get('configEditor').configuration().filter(item => item.entry.options.id === 'llm-pi-ai')
      assert.equal(reloaded.length, 1)
      assert.ok(reloaded[0].entry instanceof loader.Entry)
      assert.equal(reloaded[0].entry.options.name, moduleName)
      assert.deepEqual(reloaded[0].inherited, inherited)
      assert.deepEqual(reloaded[0].override, expected)
      assert.deepEqual(reloaded[0].entry.options.config, expected)
      const reloadSettings = app.get('settings').describe({ redactSecrets: true }).find(item => item.ns === 'llm-pi-ai')
      assert.deepEqual(reloadSettings.user.providers.sample, expected.providers.sample)
      assert.equal(reloadSettings.value.providers.sample.models[0].contextWindow, 64000)
      console.log('RAW_CONTEXT_REAL_VERIFIED=1')
    } finally {
      await app.fiber.dispose()
      hooks.deregister()
      delete globalThis[Symbol.for('raw-context-real.Config')]
      delete globalThis[Symbol.for('raw-context-real.mounts')]
    }
  })
}
