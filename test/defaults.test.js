import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'

// No user profile or inherited credentials are visible to the behavioral tests.
// The child runs the real scheduler and runner; it writes no files.
const filename = fileURLToPath(import.meta.url)
if (process.env.METADATA_SCHEDULER_TEST_CHILD !== '1') {
  test('scheduler safety with isolated fake Host, network and clock', () => {
    const result = spawnSync(process.execPath, ['--test', filename], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/nonexistent-metadata-scheduler-test-home',
        USERPROFILE: '/nonexistent-metadata-scheduler-test-home',
        DSH_DATA_DIR: '/nonexistent-metadata-scheduler-test-data',
        METADATA_SCHEDULER_TEST_CHILD: '1',
      },
    })
    assert.equal(result.error, undefined, `isolated child failed to start: ${result.error}`)
    assert.equal(result.signal, null, `isolated child terminated: ${result.signal}`)
    assert.equal(result.status, 0, `isolated scheduler tests failed:\n${result.stdout}\n${result.stderr}`)
    const count = Number(result.stdout.match(/(?:#|ℹ)\s+tests (\d+)/)?.[1] ?? 0)
    assert.ok(count >= 5, `expected actual behavioral tests, got ${count}`)
    console.log(`isolated scheduler: ${count} behavioral tests passed`)
  })
} else {
  const networkAttempts = []
  globalThis.fetch = async (...args) => {
    networkAttempts.push(`fetch:${String(args[0])}`)
    throw new Error('network is forbidden in scheduler tests')
  }
  // Also prevent bypassing fetch through node sockets or DNS.
  for (const [name, methods] of [
    ['node:http', ['request', 'get']], ['node:https', ['request', 'get']],
    ['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']],
    ['node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6']],
    ['node:dgram', ['createSocket']],
  ]) {
    const module = (await import(name)).default
    for (const method of methods) {
      module[method] = () => {
        networkAttempts.push(`${name}.${method}`)
        throw new Error('network is forbidden in scheduler tests')
      }
    }
  }
  syncBuiltinESMExports()
  const { createSyncScheduler } = await import('../lib/scheduler.js')
  const { createModelSynchronizer } = await import('../lib/synchronizer.js')

  function fakeHost() {
    const effects = []
    const record = name => (..._args) => { effects.push(name) }
    const settings = {
      get: () => ({ providers: { synthetic: { models: [{ id: 'retained-model', custom: null }] } } }),
      describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers: {} } }],
      update: record('settings.update'), replace: record('settings.replace'), mutate: record('settings.mutate'),
    }
    const llm = {
      listProviders: () => [], listConfigurableProviders: () => [], stream: record('paid inference'),
    }
    const credentials = { resolve: record('credential lookup') }
    const stateStore = {
      getState: () => ({}), get: () => undefined,
      update: record('stateStore.update'), reset: record('stateStore.reset'),
    }
    const ctx = {
      settings, llm, credentials,
      get: name => ({ settings, llm, credentials })[name],
      emit: record('ctx.emit'), pluginNotify: { send: record('webhook/notification') },
      logger: { warn() {}, debug() {} },
    }
    return {
      effects, settings, llm, ctx, stateStore,
      saveConfig: record('saveConfig'), fetchImpl: record('fetchImpl'),
      probeModel: record('paid probing'), webhook: record('webhook'),
      pricing: record('pricing'), rollback: record('rollback'),
    }
  }

  function fakeTime() {
    let now = 1_700_000_000_000
    let id = 0
    const timers = new Map()
    return {
      now: () => now,
      setIntervalFn(fn, ms) { const key = ++id; timers.set(key, { fn, ms }); return key },
      clearIntervalFn(key) { timers.delete(key) },
      async advance(ms) {
        now += ms
        for (const { fn } of [...timers.values()]) await fn()
        await flushMicrotasks()
      },
      size: () => timers.size,
    }
  }

  async function flushMicrotasks() {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  }

  function syncSpy(host, { failRun = false, failPricing = false } = {}) {
    const runs = []
    const pricingCalls = []
    const rollbackCalls = []
    const sync = {
      listProviders: () => [
        { provider: 'global-legacy', configured: true },
        { provider: 'provider-legacy', configured: true },
      ],
      async run(options) {
        runs.push(structuredClone(options))
        if (options?.dryRun !== true) {
          host.settings.update('llm-pi-ai', {})
          host.llm.stream()
          host.webhook()
          host.rollback()
        }
        if (failRun) throw new Error('synthetic run failure')
        return { results: [{ provider: options.provider, status: 'ok' }] }
      },
      async syncPricing() {
        pricingCalls.push(true)
        host.pricing()
        if (failPricing) throw new Error('synthetic pricing failure')
      },
      async rollbackHistory(...args) { rollbackCalls.push(args); host.rollback() },
    }
    return { sync, runs, pricingCalls, rollbackCalls }
  }

  function legacyConfig() {
    return {
      enabled: true, scheduleEnabled: true, autoApply: true, intervalMinutes: 1,
      providers: [
        { provider: 'global-legacy' },
        { provider: 'provider-legacy', autoApply: true },
      ],
      history: [{ id: 'unsafe', providers: [{ provider: 'global-legacy', before: [{ id: 'truncated' }] }] }],
    }
  }

  function fixture({ failRun = false, failPricing = false, config = legacyConfig() } = {}) {
    const host = fakeHost()
    const spy = syncSpy(host, { failRun, failPricing })
    const clock = fakeTime()
    const logs = []
    const scheduler = createSyncScheduler(spy.sync, {
      getConfig: () => config, nowFn: clock.now,
      setIntervalFn: clock.setIntervalFn, clearIntervalFn: clock.clearIntervalFn,
      randomFn: () => 0, logger: { warn: message => logs.push(message) },
    })
    return { scheduler, host, spy, clock, config, logs }
  }

  async function captureError(operation) {
    try { await operation(); return null } catch (error) { return error }
  }

  function assertNoEffects(host) {
    assert.deepEqual(host.effects, [], 'no Host writes, inference, pricing, webhook, rollback or other effects')
    assert.deepEqual(networkAttempts, [], 'no network attempt')
  }

  function assertNoLegacyScheduling(f) {
    assert.ok(f.spy.runs.every(options => options?.dryRun === true),
      `every scheduled run must be explicitly read-only: ${JSON.stringify(f.spy.runs)}`)
    assert.deepEqual(f.spy.pricingCalls, [], 'scheduler must never attempt syncPricing')
    assert.deepEqual(f.spy.rollbackCalls, [], 'scheduler must never invoke rollback')
    // The current runner does not yet support safe discovery. In this phase the
    // scheduler must not call even its nominally dry-run legacy interface.
    assert.deepEqual(f.spy.runs, [], 'legacy runner must not be scheduled until preview discovery is safe')
    assertNoEffects(f.host)
  }

  function assertDisabledStatus(scheduler) {
    const status = scheduler.status()
    assert.equal(status.active, false)
    assert.equal(status.running, false)
    assert.equal(status.lastRunAt, null)
    assert.equal(status.nextRunAt, null)
    assert.deepEqual(status.providers, {})
    assert.equal(status.status, 'unsupported')
    assert.match(status.reason, /disabled|unavailable/i)
    assert.match(status.reason, /preview/i)
  }

  test('initial microtask cannot use legacy global or provider autoApply', async () => {
    const f = fixture()
    const started = f.scheduler.start()
    await flushMicrotasks()
    assertNoLegacyScheduling(f)
    assert.equal(started, false, 'start visibly reports that scheduling is unavailable')
    assert.equal(f.clock.size(), 0)
    assertDisabledStatus(f.scheduler)
  })

  test('manual tick never invokes pricing, even when old scheduling is enabled', async () => {
    const f = fixture({ config: { ...legacyConfig(), autoApply: false } })
    const error = await captureError(() => f.scheduler.tick())
    assert.deepEqual(f.spy.pricingCalls, [], 'syncPricing must not be attempted at all')
    assertNoLegacyScheduling(f)
    assert.equal(error?.code, 'UNSUPPORTED_OPERATION')
    assert.match(error.message, /preview/i)
    assertDisabledStatus(f.scheduler)
  })

  test('manual tick cannot apply either legacy autoApply setting', async () => {
    const f = fixture()
    const error = await captureError(() => f.scheduler.tick())
    assertNoLegacyScheduling(f)
    assert.equal(error?.code, 'UNSUPPORTED_OPERATION')
    assertDisabledStatus(f.scheduler)
  })

  test('stop, restart, reconfigure and clock advances do not revive an initial tick', async () => {
    const f = fixture()
    f.scheduler.start()
    f.scheduler.stop()
    await flushMicrotasks()
    f.scheduler.start()
    f.scheduler.reconfigure()
    await flushMicrotasks()
    await f.clock.advance(60_000)
    await f.clock.advance(24 * 60 * 60_000)
    assertNoLegacyScheduling(f)
    assert.equal(f.clock.size(), 0)
    assert.equal(f.scheduler.reconfigure(), false)
    f.scheduler.stop()
    assertDisabledStatus(f.scheduler)
  })

  test('throwing runner and pricing collaborators cannot trigger fallback effects', async () => {
    const f = fixture({ failRun: true, failPricing: true })
    f.scheduler.start()
    await flushMicrotasks()
    const first = await captureError(() => f.scheduler.tick())
    f.scheduler.stop()
    f.scheduler.start()
    await f.clock.advance(60_000)
    const second = await captureError(() => f.scheduler.tick())
    await flushMicrotasks()
    assertNoLegacyScheduling(f)
    assert.equal(first?.code, 'UNSUPPORTED_OPERATION')
    assert.equal(second?.code, 'UNSUPPORTED_OPERATION')
    assertDisabledStatus(f.scheduler)
  })

  test('real sealed runner with observable fake Host sinks stays untouched across restart', async () => {
    const host = fakeHost()
    const config = legacyConfig()
    const runner = createModelSynchronizer(host.ctx, {
      getConfig: () => config, saveConfig: host.saveConfig, stateStore: host.stateStore,
      fetchImpl: host.fetchImpl, probeModel: host.probeModel,
    })
    const refusal = await captureError(() => runner.run({ dryRun: false, provider: 'global-legacy', forceNotify: true }))
    assert.equal(refusal?.code, 'UNSUPPORTED_OPERATION', 'the real runner is actually sealed')
    assertNoEffects(host)
    const calls = []
    const pricingCalls = []
    const rollbackCalls = []
    const schedulerFacingRunner = {
      async run(options) { calls.push(structuredClone(options)); return runner.run(options) },
      async syncPricing() { pricingCalls.push(true); host.pricing() },
      async rollbackHistory(...args) { rollbackCalls.push(args); return runner.rollbackHistory(...args) },
    }
    const clock = fakeTime()
    const scheduler = createSyncScheduler(schedulerFacingRunner, {
      getConfig: () => config, nowFn: clock.now,
      setIntervalFn: clock.setIntervalFn, clearIntervalFn: clock.clearIntervalFn,
      logger: host.ctx.logger, randomFn: () => 0,
    })
    scheduler.start()
    await flushMicrotasks()
    const first = await captureError(() => scheduler.tick())
    scheduler.stop()
    scheduler.start()
    await flushMicrotasks()
    await clock.advance(24 * 60 * 60_000)
    const second = await captureError(() => scheduler.tick())
    scheduler.stop()
    assert.ok(calls.every(options => options?.dryRun === true), `sealed runner received unsafe options: ${JSON.stringify(calls)}`)
    assert.deepEqual(pricingCalls, [], 'sealed runner must not hide attempted pricing')
    assert.deepEqual(rollbackCalls, [])
    assert.deepEqual(calls, [], 'unavailable preview must not be reported as successful discovery')
    assertNoEffects(host)
    assert.equal(first?.code, 'UNSUPPORTED_OPERATION')
    assert.equal(second?.code, 'UNSUPPORTED_OPERATION')
    assert.equal(clock.size(), 0)
    assertDisabledStatus(scheduler)
  })
}
