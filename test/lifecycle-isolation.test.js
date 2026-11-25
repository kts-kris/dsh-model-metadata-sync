import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { syncBuiltinESMExports } from 'node:module'

// This is a fake Host isolation test, not the real DSH lifecycle proof (T49).
// The child receives no inherited profile, credentials, network or home paths.
const filename = fileURLToPath(import.meta.url)
const repo = path.resolve(path.dirname(filename), '..')
const secret = 'SYNTHETIC_LIFECYCLE_SECRET_8391'
const inside = (parent, child) => {
  const relative = path.relative(parent, child)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

if (process.env.METADATA_LIFECYCLE_CHILD !== '1') {
  test('fork lifecycle runs only with fake Host and owned state', (t) => {
    const temporaryRoot = fs.realpathSync('/tmp')
    const owned = fs.mkdtempSync(path.join(temporaryRoot, 'metadata-lifecycle-'))
    assert.equal(path.dirname(owned), temporaryRoot)
    const inheritedHome = process.env.HOME && path.resolve(process.env.HOME)
    assert.ok(!inside(repo, owned) && (!inheritedHome || !inside(inheritedHome, owned)))
    try {
      const home = path.join(owned, 'home')
      const data = path.join(owned, 'data')
      const temporary = path.join(owned, 'temp')
      for (const dir of [home, data, temporary]) fs.mkdirSync(dir)
      const child = spawnSync(process.execPath, ['--test', filename], {
        cwd: repo,
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: home,
          USERPROFILE: home,
          TMPDIR: temporary,
          DSH_DATA_DIR: data,
          DSH_MODEL_SYNC_STATE_PATH: path.join(data, 'original-env-state.json'),
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          METADATA_LIFECYCLE_CHILD: '1',
        },
      })
      assert.equal(child.error, undefined, 'isolated child could not start')
      assert.equal(child.signal, null, 'isolated child terminated by signal')
      assert.ok(!`${child.stdout}${child.stderr}`.includes(secret), 'synthetic secret appeared in child output')
      assert.equal(child.status, 0, `isolated behavioral tests failed:\n${child.stdout}\n${child.stderr}`)
      assert.match(child.stdout, /(?:#|ℹ)\s+tests [1-9]\d*/, 'zero tests are not evidence')
      const count = child.stdout.match(/(?:#|ℹ)\s+tests (\d+)/)[1]
      const skipped = child.stdout.match(/(?:#|ℹ)\s+skipped (\d+)/)?.[1] ?? '0'
      console.log(`fake Host isolated child: ${count} cases, ${skipped} skipped`)
      if (Number(skipped)) t.diagnostic('INCONCLUSIVE: actual Host entry not exercised; install @deepseek-ai/schemastery as a local dependency or use the separately verified Electron runtime')
    } finally {
      assert.equal(path.dirname(owned), temporaryRoot)
      assert.match(path.basename(owned), /^metadata-lifecycle-/)
      fs.rmSync(owned, { recursive: true, force: true })
    }
  })
} else {
  const home = process.env.HOME
  const data = process.env.DSH_DATA_DIR
  const temporary = process.env.TMPDIR
  const owned = path.dirname(home || '')
  if (!home || !data || !temporary || !path.isAbsolute(owned) ||
      !/^metadata-lifecycle-/.test(path.basename(owned)) || inside(repo, owned) ||
      ![home, data, temporary, process.env.DSH_MODEL_SYNC_STATE_PATH].every(value => value && inside(owned, value))) {
    throw new Error('refusing lifecycle test without an owned isolated environment')
  }

  const { registerHooks } = await import('node:module')
  if (process.versions.electron) {
    // Resolve the actual bundled dependency, not a fake Schema. This hook is
    // child-local, read-only, and is not evidence of DSH plugin installation.
    const schemaURL = 'file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs'
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === '@deepseek-ai/schemastery') return { url: schemaURL, shortCircuit: true }
      return nextResolve(specifier, context)
    } })
  }

  test('fork state never reads or migrates original paths, even when an old environment variable is set', async () => {
    const originalEnvPath = process.env.DSH_MODEL_SYNC_STATE_PATH
    const originalDefaultPath = path.join(data, 'state.json')
    const originalLegacyPath = path.join(home, '.deepseek-agent', 'data', 'dsh-model-sync-state.json')
    const originalHomePath = path.join(home, '.dsh', 'data', 'dsh-model-sync', 'state.json')
    const oldPaths = [originalEnvPath, originalDefaultPath, originalLegacyPath, originalHomePath]
    for (const target of oldPaths) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, JSON.stringify({ history: [{ id: 'original', marker: secret }] }))
    }
    const snapshots = oldPaths.map(target => fs.readFileSync(target, 'utf8'))
    const accesses = []
    const originalExists = fs.existsSync
    const originalRead = fs.readFileSync
    fs.existsSync = function (target) { accesses.push(['exists', String(target)]); return originalExists.apply(this, arguments) }
    fs.readFileSync = function (target) { accesses.push(['read', String(target)]); return originalRead.apply(this, arguments) }
    syncBuiltinESMExports()
    try {
      const { createRuntimeStateStore, resolveDefaultStatePath } = await import('../lib/state-store.js')
      const defaultPath = resolveDefaultStatePath()
      assert.ok(inside(data, defaultPath), 'fork default path must remain inside its configured data root')
      assert.ok(!oldPaths.includes(defaultPath), 'the old environment variable must not select the fork state')
      const store = createRuntimeStateStore({ persistToDisk: true, legacyPath: originalLegacyPath })
      assert.deepEqual(store.get('history'), [], 'legacy snapshots must not be imported')
      store.update({ lifecycleRevision: 1 })
      assert.ok(!accesses.some(([, target]) => oldPaths.includes(target)), 'original paths must not even be probed')
      assert.deepEqual(oldPaths.map(target => originalRead(target, 'utf8')), snapshots, 'original state must remain unchanged')
    } finally {
      fs.existsSync = originalExists
      fs.readFileSync = originalRead
      syncBuiltinESMExports()
    }
  })

  let entryUnavailable
  try {
    import.meta.resolve('@deepseek-ai/schemastery')
  } catch (error) {
    if (!process.versions.electron && error.code === 'ERR_MODULE_NOT_FOUND') {
      entryUnavailable = 'INCONCLUSIVE: @deepseek-ai/schemastery is not installed for ordinary Node'
    } else {
      throw error
    }
  }
  // Electron's child-local hook uses the real runtime's bundled Schemastery;
  // import.meta.resolve does not consult registerHooks on every Node release.
  if (process.versions.electron) entryUnavailable = undefined

  test('partial route registration rolls back if a later route collides', async () => {
    const { registerHttpApi } = await import('../lib/http.js')
    const existing = Object.freeze({ sentinel: 'existing' })
    const routes = new Map([['/dsh-model-metadata-sync/apply', existing]])
    const ctx = { webServer: { register(route) {
      if (routes.has(route.path)) throw new Error('duplicate route')
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    } } }
    assert.throws(() => registerHttpApi(ctx, {}), /duplicate route/)
    assert.deepEqual([...routes.entries()], [['/dsh-model-metadata-sync/apply', existing]])
  })

  test('failed registration attempts all disposers and reports uncertain cleanup', async () => {
    const { registerHttpApi } = await import('../lib/http.js')
    const disposed = []
    const ctx = { webServer: { register(route) {
      if (route.path.endsWith('/status')) throw new Error('synthetic-private-collision')
      return () => {
        disposed.push(route.path)
        if (route.path.endsWith('/preview/cancel')) throw new Error('synthetic-private-disposer')
      }
    } } }
    assert.throws(() => registerHttpApi(ctx, {}), error =>
      error.code === 'ROUTE_CLEANUP_UNCONFIRMED' && !error.message.includes('synthetic-private'))
    assert.deepEqual(disposed, [
      '/dsh-model-metadata-sync/preview/cancel', '/dsh-model-metadata-sync/apply', '/dsh-model-metadata-sync/preview',
    ])
  })

  test('reference preference edits only its own live loader entry, and fails closed on unload or editor failure', { skip: entryUnavailable }, async () => {
    const { Config, createForkReferenceSettings, plainConfig } = await import('../lib/index.js')
    assert.equal(plainConfig(Config({})).referenceEnabled, true)
    const entry = { id: 'dsh-model-metadata-sync' }
    const original = { id: 'dsh-model-sync', config: { referenceEnabled: 'original', marker: secret } }
    const originalSnapshot = structuredClone(original)
    let forkConfig = { referenceEnabled: true, unrelated: 'keep' }
    const calls = []
    const ctx = {
      fiber: { entry },
      get(name) {
        calls.push(name)
        return name === 'configEditor' ? {
          async edit(target, change) {
            assert.equal(target, entry, 'only this fork loader entry may be edited')
            forkConfig = change(forkConfig, {})
          },
        } : undefined
      },
    }
    const config = { referenceEnabled: { get: () => forkConfig.referenceEnabled } }
    const preference = createForkReferenceSettings(ctx, config)
    assert.equal(preference.getReferenceEnabled(), true)
    await preference.setReferenceEnabled(false)
    assert.deepEqual(forkConfig, { referenceEnabled: false, unrelated: 'keep' })
    assert.equal(preference.getReferenceEnabled(), false, 'volatile box must be read lazily')
    assert.deepEqual(original, originalSnapshot)
    await assert.rejects(preference.setReferenceEnabled('false'), error => error.code === 'INVALID_CONFIG')
    preference.dispose()
    await assert.rejects(preference.setReferenceEnabled(true), error => error.code === 'CONFIG_UNAVAILABLE')
    assert.deepEqual(calls, ['configEditor'], 'invalid and unloaded writes must not consult services')
    const missing = createForkReferenceSettings({ fiber: { entry }, get: () => undefined })
    await assert.rejects(missing.setReferenceEnabled(false), error => error.code === 'CONFIG_UNAVAILABLE')
    const failing = createForkReferenceSettings({ fiber: { entry }, get: () => ({ edit: async () => { throw new Error(secret) } }) })
    await assert.rejects(failing.setReferenceEnabled(false), error => error.code === 'WRITE_REJECTED' && !error.message.includes(secret))
  })

  test('normal teardown attempts all route disposers and reports uncertain cleanup', { skip: entryUnavailable }, async () => {
    const { apply } = await import('../lib/index.js')
    const disposals = []
    let cleanup
    const ctx = {
      webServer: { register(route) { return () => {
        disposals.push(route.path)
        if (route.path.endsWith('/policy')) throw new Error('synthetic-private-disposer')
      } } },
      effect(fn) { cleanup = fn() },
    }
    apply(ctx, {})
    assert.throws(() => cleanup(), error =>
      error.code === 'ROUTE_CLEANUP_UNCONFIRMED' && !error.message.includes('synthetic-private'))
    assert.equal(disposals.length, 37, 'every route must be attempted despite one failure')
    assert.equal(disposals.at(-1), '/dsh-model-metadata-sync/preview')
  })

  test('provider facade cannot inspect the original runner or expose unsupported pricing and probing', async () => {
    const lookups = []
    const sentinel = { getVerifiedCapabilities() { throw new Error('original runner must never be called') } }
    const ctx = {
      reflect: { get(key) { lookups.push(key); return key === 'modelSyncRunner' ? sentinel : undefined } },
      get(key) { lookups.push(key); return key === 'modelSyncRunner' ? sentinel : undefined },
    }
    const { createProviderService } = await import('../lib/provider-service.js')
    const service = createProviderService(ctx)
    assert.equal(service.getVerifiedCapabilities, undefined, 'legacy probing facade must not be exposed')
    assert.equal(service.getPricing, undefined, 'legacy pricing facade must not be exposed')
    assert.ok(!lookups.includes('modelSyncRunner'), 'original runner must not be looked up')
  })

  test('real fork entry does not affect original services, routes, updater, or state during fake Host restart', { skip: entryUnavailable }, async () => {
    const originalServices = new Map([
      ['modelSync', Object.freeze({ sentinel: 'original-service' })],
      ['modelSyncRunner', Object.freeze({ sentinel: 'original-runner' })],
    ])
    const originalSnapshots = [...originalServices.entries()]
    const services = new Map(originalServices)
    // A preexisting fork route exercises registration failure and rollback;
    // the original service and route sentinels must remain untouched.
    const originalRoutes = new Map([['/dsh-model-sync/run', Object.freeze({ sentinel: 'original-route' })]])
    const routes = new Map(originalRoutes)
    const routeDisposals = []
    const listeners = new Map()
    const lookedUp = []
    const timers = []
    const disk = []
    const effects = []
    const logLines = []
    const forbidden = []
    const originalExists = fs.existsSync
    const originalRead = fs.readFileSync
    fs.existsSync = function (target) { disk.push(['exists', String(target)]); return originalExists.apply(this, arguments) }
    fs.readFileSync = function (target) { disk.push(['read', String(target)]); return originalRead.apply(this, arguments) }
    syncBuiltinESMExports()
    const originalFetch = globalThis.fetch
    const originalSetInterval = globalThis.setInterval
    globalThis.fetch = async () => { forbidden.push('fetch'); throw new Error('network forbidden') }
    globalThis.setInterval = (...args) => { timers.push(args); throw new Error('timers forbidden') }
    const socketMethods = []
    for (const [name, methods] of [
      ['node:http', ['request', 'get']], ['node:https', ['request', 'get']],
      ['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']],
      ['node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6']],
    ]) {
      const module = (await import(name)).default
      for (const method of methods) {
        const original = module[method]
        socketMethods.push([module, method, original])
        module[method] = () => { forbidden.push(`${name}.${method}`); throw new Error('network forbidden') }
      }
    }
    syncBuiltinESMExports()
    const entry = { id: 'dsh-model-metadata-sync' }
    const ctx = {
      fiber: { entry },
      logger: Object.fromEntries(['warn', 'error', 'debug', 'info'].map(level => [level, (...args) => logLines.push(args.map(String).join(' '))])),
      get(key) { lookedUp.push(key); return services.get(key) },
      reflect: { get(key) { lookedUp.push(key); return services.get(key) } },
      provide(key, service) { services.set(key, service) },
      on(event, fn) {
        if (listeners.has(event)) throw new Error('listener collision')
        listeners.set(event, fn)
        return () => { assert.equal(listeners.get(event), fn); listeners.delete(event) }
      },
      effect(fn, label) {
        const dispose = fn()
        assert.equal(typeof dispose, 'function', `effect ${label} has no teardown`)
        effects.push({ label, dispose })
      },
      webServer: { register(route) {
        assert.equal(routes.has(route.path), false, 'route collision')
        routes.set(route.path, route)
        return () => { assert.equal(routes.get(route.path), route); routes.delete(route.path); routeDisposals.push(route.path) }
      } },
    }
    const teardown = () => {
      for (const effect of effects.splice(0).reverse()) effect.dispose()
      assert.deepEqual([...routes.entries()], [...originalRoutes.entries()], 'all fork routes must be disposed')
      assert.equal(listeners.size, 0, 'all listeners must be disposed')
      assert.deepEqual([...services.entries()], originalSnapshots, 'original services must stay unchanged')
    }
    try {
      const { apply, name, Config, plainConfig } = await import('../lib/index.js')
      assert.equal(name, 'dsh-model-metadata-sync')
      assert.equal(plainConfig(Config({})).referenceEnabled, true, 'reference opt-out must default to enabled')
      for (let cycle = 0; cycle < 2; cycle++) {
        apply(ctx, { enabled: true, autoApply: true, scheduleEnabled: true, diffWebhookSecret: secret })
        const registrations = [...routes.values()].filter(route => route?.path)
        assert.ok(registrations.length > 0, 'expected fork HTTP route reservations')
        assert.ok(registrations.every(route => route.path.startsWith('/dsh-model-metadata-sync/')))
        assert.ok(registrations.every(route => route.auth === 'required'))
        assert.ok(registrations.every(route => !route.path.includes('/update')), 'updater must not be registered')
        assert.deepEqual([...services.entries()], originalSnapshots, 'fork must not expose legacy or unsafe service facades')
        for (const fn of [...listeners.values()]) fn()
        await Promise.resolve()
        teardown()
      }
      assert.ok(routeDisposals.length > 0, 'route disposers must actually run')
      assert.ok(!lookedUp.some(key => ['modelSync', 'modelSyncRunner'].includes(key)), 'original service lookup is forbidden')
      assert.deepEqual(forbidden, [], 'network must not be attempted')
      assert.equal(timers.length, 0, 'scheduler must not create background work')
      const forbiddenPaths = [process.env.DSH_MODEL_SYNC_STATE_PATH, path.join(data, 'state.json'),
        path.join(home, '.deepseek-agent', 'data', 'dsh-model-sync-state.json'),
        path.join(home, '.dsh', 'data', 'dsh-model-sync', 'state.json')]
      assert.ok(!disk.some(([, target]) => forbiddenPaths.includes(target)), 'original state must not even be probed')
      assert.ok(!logLines.join('\n').includes(secret), 'logger must not expose the synthetic secret')
    } finally {
      globalThis.fetch = originalFetch
      globalThis.setInterval = originalSetInterval
      for (const [module, method, original] of socketMethods) module[method] = original
      fs.existsSync = originalExists
      fs.readFileSync = originalRead
      syncBuiltinESMExports()
    }
  })
}
