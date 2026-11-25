import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

// This exercises the installed Loader, ConfigEditor, SettingsForms and
// PluginManager against a disposable profile, not the user's running Host.
// The provider is inert, but uses the installed pi-ai Config without changes.
const file = fileURLToPath(import.meta.url)
const repo = path.resolve(path.dirname(file), '..')
const childKey = 'DSH_REAL_SETTINGS_CHILD'
const tmp = fs.realpathSync('/tmp')
const marker = 'dsh-real-settings-'
const inside = (base, target) => {
  const relative = path.relative(base, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

if (process.env[childKey] !== '1') {
  test('installed DSH Settings mutates an explicit user-only provider list in an offline disposable profile', t => {
    const executable = process.env.DSH_NODE_EXECUTABLE
    const installDir = process.env.DSH_INSTALL_DIR
    if (process.platform !== 'darwin' || !executable || !installDir || !fs.existsSync(executable) || !fs.existsSync('/usr/bin/sandbox-exec')) {
      t.skip('inconclusive: requires the installed macOS DSH Electron runtime and sandbox-exec')
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
      // Deny socket operations at the OS level and confine writes to this
      // disposable root. The child must independently confirm both controls.
      const escaped = owned.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
      const policy = `(version 1)(allow default)(deny network*)(deny file-write* (regex #"^/"))(allow file-write* (subpath "${escaped}"))`
      const result = spawnSync('/usr/bin/sandbox-exec', ['-p', policy, executable, file], {
        cwd: owned, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
        env: {
          PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1', HOME: dirs.home, USERPROFILE: dirs.home,
          DSH_HOME: dirs.data, DSH_DATA_DIR: dirs.data, XDG_DATA_HOME: dirs.data,
          XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache, TMPDIR: dirs.temp,
          DSH_INSTALL_DIR: installDir, DSH_TEST_PROFILE: dirs.profile, [childKey]: '1',
        },
      })
      assert.equal(result.error, undefined, `sandbox process could not start: ${result.error}`)
      assert.equal(result.signal, null, `sandbox process interrupted: ${result.signal}`)
      assert.equal(result.status, 0, `installed Settings integration failed:\n${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /REAL_SETTINGS_VERIFIED=1\b/, `missing positive evidence:\n${result.stdout}\n${result.stderr}`)
      console.log('Installed DSH Settings/Loader/ConfigEditor/PluginManager verified with synthetic provider schema and no network.')
    } finally {
      const resolved = fs.realpathSync(owned)
      assert.equal(resolved, owned)
      assert.equal(path.dirname(resolved), tmp)
      assert.match(path.basename(resolved), /^dsh-real-settings-/)
      fs.rmSync(resolved, { recursive: true, force: true })
    }
  })
} else {
  test('real isolated Settings path append, readback, revision conflict and plugin inventory', async () => {
    const profileDir = process.env.DSH_TEST_PROFILE
    const owned = path.dirname(profileDir || '')
    if (path.dirname(owned) !== tmp || !path.basename(owned).startsWith(marker) ||
        !['HOME', 'USERPROFILE', 'DSH_HOME', 'DSH_DATA_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'DSH_TEST_PROFILE']
          .every(key => process.env[key] && path.dirname(process.env[key]) === owned)) {
      throw new Error('refusing to initialize outside a disposable isolated home and profile')
    }
    // Opening an existing device for writing without sending any bytes is a
    // side-effect-free isolation probe even if this child is invoked directly
    // without its parent sandbox. Always close an unexpectedly opened handle.
    let unexpectedFd
    try {
      assert.throws(() => { unexpectedFd = fs.openSync('/dev/null', 'w') },
        error => ['EPERM', 'EACCES'].includes(error.code), 'OS sandbox did not enforce filesystem write isolation')
    } finally {
      if (unexpectedFd !== undefined) fs.closeSync(unexpectedFd)
    }
    const net = await import('node:net')
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: 9 })
      socket.once('connect', () => { socket.destroy(); reject(new Error('OS sandbox permitted a network connection')) })
      socket.once('error', error => ['EPERM', 'EACCES'].includes(error.code) ? resolve() : reject(error))
    })
    const installDir = process.env.DSH_INSTALL_DIR
    const fromDsh = createRequire(path.join(installDir, 'package.json'))
    assert.equal(fromDsh('@deepseek-ai/dsh/package.json').version, '0.2.3-alpha.2')
    const load = name => import(pathToFileURL(fromDsh.resolve(name)).href)
    const [boot, editorModule, settingsModule, pi, managerModule] = await Promise.all([
      load('@deepseek-ai/dsh-app-boot'), load('@deepseek-ai/dsh-config-editor'), load('@deepseek-ai/dsh-settings'),
      load('@deepseek-ai/dsh-llm-pi-ai'), load('@deepseek-ai/dsh-plugin-manager'),
    ])
    const configPath = path.join(profileDir, 'cordis.yml')
    const patchPath = path.join(profileDir, 'cordis.patch.yml')
    const manifestPath = path.join(profileDir, 'package.json')
    fs.writeFileSync(manifestPath, JSON.stringify({ name: 'isolated-settings-profile', private: true, dsh: { profile: { bundles: [] } } }))
    fs.writeFileSync(configPath, '[]\n')
    const provider = { api: 'openai-completions', baseURL: 'https://fixture.invalid/v1',
      headers: { 'x-fixture': 'preserve' }, models: [{ id: 'existing', reasoningEfforts: { off: null, high: 'high' }, compat: { supportsStore: false } }] }
    const patches = [{ insert: [
      { id: 'llm-pi-ai', name: 'cordis:fixture-pi-ai', config: {} },
      { id: 'original-sync', name: '@goodandready/dsh-model-sync', disabled: true },
    ] }, { id: 'llm-pi-ai', config: { providers: { 'fixture-route': provider } } }]
    fs.writeFileSync(patchPath, JSON.stringify(patches, null, 2))
    const profile = { name: 'isolated', dir: profileDir, patchPath, installAnchor: path.join(installDir, 'package.json'),
      cwd: owned, home: process.env.DSH_HOME, startedBundles: [], overlayPaths: [], telemetryDisabledEnv: '1' }
    let mountCount = 0
    let updates = 0
    const fixture = { name: 'fixture-pi-ai', Config: pi.Config, apply(ctx) {
      mountCount++
      ctx.on('loader/volatile-update', () => { updates++ })
    } }
    const app = await boot.boot('dsh-test', configPath, boot.readProfilePatches('dsh-test', profile), async ctx => {
      ctx.provide('profileContext', profile)
      ctx.loader.builtins['fixture-pi-ai'] = fixture
      await ctx.plugin(editorModule.ConfigEditor)
      await ctx.plugin(settingsModule.SettingsForms)
      await ctx.plugin(managerModule.PluginManager, {})
    })
    try {
      const settings = app.get('settings')
      const manager = app.get('pluginManager')
      assert.ok(settings && manager, 'installed services must be active')
      const describe = () => {
        const rows = settings.describe({ redactSecrets: true }).filter(row => row.ns === 'llm-pi-ai')
        assert.equal(rows.length, 1)
        return rows[0]
      }
      const before = describe()
      assert.equal(before.applies, 'live')
      assert.ok(Number.isSafeInteger(before.revision) && before.revision >= 0)
      assert.deepEqual(before.base, { providers: {} })
      assert.deepEqual(before.user.providers['fixture-route'], provider)
      assert.equal(before.value.providers['fixture-route'].defaultContextWindow, 1000000)
      assert.deepEqual(before.value.providers['fixture-route'].modelOverrides, {})
      assert.equal(mountCount, 1)
      const inventory = await manager.listPlugins()
      assert.ok(Array.isArray(inventory))
      const item = inventory.find(row => row.moduleName === 'cordis:fixture-pi-ai')
      assert.ok(item, 'real manager must return the fixture Loader entry')
      assert.equal(typeof item.entryId, 'string')
      assert.equal(item.enabled, true)
      assert.equal(item.fiberPhase, 'active')
      assert.equal(item.patchId, 'llm-pi-ai')
      const original = inventory.find(row => row.moduleName === '@goodandready/dsh-model-sync')
      assert.ok(original, 'disabled original is still represented in the real Loader inventory')
      assert.equal(original.enabled, false)
      assert.equal(original.fiberPhase, null)
      assert.equal(await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'fixture-route', 'models', '1'], value: { id: 'added' } }], before.revision), undefined)
      const after = describe()
      assert.ok(after.revision > before.revision)
      assert.deepEqual(after.user.providers['fixture-route'], { ...provider, models: [...provider.models, { id: 'added' }] })
      assert.deepEqual(after.value.providers['fixture-route'].models.map(model => model.id), ['existing', 'added'])
      assert.equal(after.user.providers['fixture-route'].headers['x-fixture'], 'preserve')
      assert.equal(after.user.providers['fixture-route'].models[0].compat.supportsStore, false)
      assert.equal(after.user.providers['fixture-route'].models[0].reasoningEfforts.off, null)
      assert.equal(mountCount, 1, 'volatile update must not remount the fixture')
      assert.ok(updates > 0, 'Loader must deliver a volatile update')
      const persisted = fs.readFileSync(patchPath, 'utf8')
      assert.match(persisted, /\badded\b/, 'successful append must be persisted to the isolated patch file')
      await assert.rejects(settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'fixture-route', 'models', '2'], value: { id: 'conflict' } }], before.revision),
        error => error instanceof settingsModule.SettingsConflictError && error.code === 'SETTINGS_CONFLICT' && error.expected === before.revision && error.actual === after.revision)
      assert.equal(fs.readFileSync(patchPath, 'utf8'), persisted, 'CAS conflict must not write the profile')
      assert.deepEqual(describe().user, after.user)
      console.log('REAL_SETTINGS_VERIFIED=1')
    } finally {
      await app.fiber.dispose()
    }
  })
}
