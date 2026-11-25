import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'

// This file never loads the synchronizer in the calling process. Each run uses
// a newly owned /tmp tree, an environment with no inherited secrets/profile,
// fake Host settings and credentials, and recording transports instead of I/O.
const filename = fileURLToPath(import.meta.url)
const repo = path.resolve(path.dirname(filename), '..')
const inside = (parent, child) => {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

if (process.env.SYNC_HOST_SEAL_CHILD !== '1') {
  test('legacy Host paths fail closed in an isolated fake Host process', () => {
    const tmp = fs.realpathSync('/tmp')
    const owned = fs.mkdtempSync(path.join(tmp, 'dsh-host-seal-'))
    const realHome = process.env.HOME ? path.resolve(process.env.HOME) : null
    assert.equal(path.dirname(owned), tmp)
    assert.ok(!inside(repo, owned) && (!realHome || !inside(realHome, owned)), 'test directory must be outside workspace and inherited HOME')
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
          DSH_MODEL_SYNC_STATE_PATH: path.join(data, 'state.json'),
          SYNC_HOST_SEAL_CHILD: '1',
        },
      })
      assert.equal(child.error, undefined, `isolated child could not start: ${child.error}`)
      assert.equal(child.signal, null, `isolated child signalled: ${child.signal}`)
      assert.equal(child.status, 0, `isolated behavioral tests failed:\n${child.stdout}\n${child.stderr}`)
      assert.match(child.stdout, /(?:#|ℹ)\s+tests [1-9]\d*/, 'a zero-test run is not evidence')
      const count = child.stdout.match(/(?:#|ℹ)\s+tests (\d+)/)?.[1]
      console.log(`isolated fake Host: ${count} behavioral tests passed`)
    } finally {
      // Delete only the exact absolute directory just created above.
      assert.equal(path.dirname(owned), tmp)
      assert.match(path.basename(owned), /^dsh-host-seal-/)
      fs.rmSync(owned, { recursive: true, force: true })
    }
  })
} else {
  const home = process.env.HOME
  const data = process.env.DSH_DATA_DIR
  const temporary = process.env.TMPDIR
  const owned = path.dirname(home || '')
  if (!home || !data || !temporary || !path.isAbsolute(owned) ||
      !/^dsh-host-seal-/.test(path.basename(owned)) ||
      ![home, data, temporary, process.env.DSH_MODEL_SYNC_STATE_PATH].every(value => value && inside(owned, value)) ||
      inside(repo, owned)) {
    throw new Error('refusing to load the Host without an isolated test environment')
  }

  const globalRequests = []
  globalThis.fetch = async (url, options) => {
    globalRequests.push({ url: String(url), method: options?.method ?? 'GET' })
    return new Response(JSON.stringify({ data: [{ id: 'new-model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  // Block actual sockets as well as fetch. Any attempted network activity is a
  // failure, not a successful mock response, and cannot reach a real host.
  const blockedNetwork = []
  for (const [moduleName, methods] of [
    ['node:http', ['request', 'get']], ['node:https', ['request', 'get']],
    ['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']],
    ['node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6']],
  ]) {
    const module = (await import(moduleName)).default
    for (const method of methods) {
      module[method] = () => {
        blockedNetwork.push(`${moduleName}.${method}`)
        throw new Error('actual network forbidden by isolated test')
      }
    }
  }
  syncBuiltinESMExports()
  const { Readable } = await import('node:stream')
  const { registerHttpApi } = await import('../lib/http.js')
  const { createConfigTransfer } = await import('../lib/synchronizer-transfer.js')
  const { createModelSynchronizer } = await import('../lib/synchronizer.js')
  const { createPolicyService } = await import('../lib/services/policy-service.js')
  const { replaceWithRetry, performHistoryRollback } = await import('../lib/synchronizer-helpers.js')

  function fakeHost() {
    globalRequests.length = 0
    const effects = []
    const stateStore = Object.freeze({
      getState: () => ({}),
      get: () => undefined,
      update: () => { effects.push('stateStore.update') },
      reset: () => { effects.push('stateStore.reset') },
    })
    let section = { providers: {
      openai: {
        baseURL: 'https://gateway.example.invalid/v1', api: 'openai-completions',
        credentialRef: 'SYNTHETIC_KEY', models: [{ id: 'old-model', reasoningEfforts: { high: 'high' }, custom: null }],
      },
    } }
    let commandcode = { apiBase: 'https://command.example.invalid/v1', apiKeyEnv: 'SYNTHETIC_KEY', visibleModels: ['old-model'] }
    const config = {
      autoApply: true, scheduleEnabled: true, diffWebhookUrl: 'https://notify.example.invalid/webhook',
      modelSelections: { openai: ['new-model'], commandcode: ['new-model'] },
      modelCatalogs: { openai: [{ id: 'old-model' }, { id: 'new-model' }], commandcode: [{ id: 'old-model' }, { id: 'new-model' }] },
      history: [{ id: 'legacy', version: 1, providers: [{ provider: 'openai', before: [{ id: 'older-model' }] }] }],
    }
    const settings = {
      describe: () => [
        { ns: 'llm-pi-ai', value: structuredClone(section), revision: 1 },
        { ns: 'llm-commandcode', value: structuredClone(commandcode), revision: 1 },
      ],
      get: (ns) => ns === 'llm-pi-ai' ? structuredClone(section) : ns === 'llm-commandcode' ? structuredClone(commandcode) : undefined,
      replace: async (ns, value) => { effects.push(`settings.replace:${ns}`); section = structuredClone(value) },
      update: async (ns) => { effects.push(`settings.update:${ns}`) },
      mutate: async (ns) => { effects.push(`settings.mutate:${ns}`); commandcode = {} },
    }
    const credentials = { resolve: async () => { effects.push('credentials.resolve'); return 'synthetic-key' } }
    const llm = {
      listProviders: () => [],
      listConfigurableProviders: () => [
        { provider: 'openai', declared: true, settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
        { provider: 'commandcode', declared: true, settingsNs: 'llm-commandcode', settingsPath: [] },
      ],
      stream: async () => { effects.push('llm.stream'); throw new Error('network/inference forbidden by test') },
    }
    const ctx = {
      settings, credentials, llm,
      get: (name) => ({ settings, credentials, llm })[name],
      emit: () => { effects.push('ctx.emit') },
      pluginNotify: { send: async () => { effects.push('pluginNotify.send') } },
      logger: { warn() {}, debug() {} },
    }
    const saveConfig = async (patch) => { effects.push('saveConfig'); Object.assign(config, structuredClone(patch)) }
    const runner = createModelSynchronizer(ctx, {
      getConfig: () => config, saveConfig, stateStore,
      fetchImpl: globalThis.fetch,
      probeModel: async () => { effects.push('probeModel'); throw new Error('paid probing forbidden by test') },
    })
    return { runner, ctx, config, effects, saveConfig, settings }
  }

  async function refusesWithoutEffects(label, invoke, effects) {
    let error
    try { await invoke() } catch (caught) { error = caught }
    assert.deepEqual(effects, [], `${label} must refuse before Host effects`)
    assert.deepEqual(globalRequests, [], `${label} must not request a network resource`)
    assert.ok(error, `${label} must explicitly refuse rather than return empty success`)
    assert.ok(['UNSUPPORTED_OPERATION', 'WRITE_REJECTED'].includes(error.code), `${label}: expected unsupported/refused error, got ${error.code}`)
    return error
  }

  test('constructing the runner never reads legacy probing state', () => {
    const original = fs.existsSync
    const reads = []
    fs.existsSync = (value) => {
      if (String(value).endsWith('verified-capabilities.json')) {
        reads.push(String(value))
        return false
      }
      return original(value)
    }
    syncBuiltinESMExports()
    try { fakeHost() } finally {
      fs.existsSync = original
      syncBuiltinESMExports()
    }
    assert.deepEqual(reads, [], 'capability prober must not be instantiated')
  })

  for (const provider of ['openai', 'commandcode']) {
    test(`non-dry runner refuses ${provider} before discovery, settings or callbacks`, async () => {
      const { runner, effects } = fakeHost()
      await refusesWithoutEffects(`run:${provider}`, () => runner.run({ dryRun: false, removeMissing: true, provider, forceNotify: true }), effects)
    })
    test(`direct runner selection refuses ${provider} before saving or mutating visibleModels`, async () => {
      const { runner, effects } = fakeHost()
      await refusesWithoutEffects(`selection:${provider}`, () => runner.setModelSelection(provider, ['new-model']), effects)
    })
  }

  test('runner policy and standalone policy service refuse legacy writes', async () => {
    for (const surface of ['runner', 'services.policy', 'standalone']) {
      for (const method of ['setModelPolicy', 'setModelSelection']) {
        const { runner, ctx, config, effects, saveConfig } = fakeHost()
        const service = surface === 'standalone'
          ? createPolicyService({ ctx, getConfig: () => config, saveConfig, providers: () => [{ provider: 'openai', configured: true, models: [{ id: 'new-model' }] }] })
          : surface === 'runner' ? runner : runner.services?.policy
        if (!service || typeof service[method] !== 'function') continue
        const argument = method === 'setModelPolicy' ? { include: ['new-model'] } : ['new-model']
        await refusesWithoutEffects(`${surface}.${method}`, () => service[method]('openai', argument), effects)
      }
    }
  })

  for (const surface of ['runner', 'helper', 'replace']) {
    test(`legacy ${surface} refuses before reading or replaying snapshots`, async () => {
      const { runner, ctx, config, settings, effects } = fakeHost()
      const invoke = surface === 'runner'
        ? () => runner.rollbackHistory({ historyId: 'legacy', provider: 'openai' })
        : surface === 'helper'
          ? () => performHistoryRollback({ ctx, config, providers: [{ provider: 'openai', configured: true }], historyId: 'legacy', provider: 'openai' })
          : () => replaceWithRetry(settings, 'llm-pi-ai', section => { effects.push('patch callback'); return section })
      const error = await refusesWithoutEffects(surface, invoke, effects)
      if (surface !== 'replace') assert.match(error.message, /incomplete|truncat|omit/i, 'rollback explains missing or truncated historical fields')
    })
  }

  test('dry-run forceNotify cannot send callbacks or fabricate an empty catalog', async () => {
    const { runner, effects } = fakeHost()
    await refusesWithoutEffects('dry-run forceNotify', () => runner.run({ dryRun: true, forceNotify: true, provider: 'openai' }), effects)
  })

  test('runner does not expose state, adapter registry or raw provider discovery', () => {
    const { runner } = fakeHost()
    for (const key of ['stateStore', 'adapterRegistry', 'registerAdapter', 'discover', 'getProvider', 'listProviders']) {
      assert.equal(runner[key], undefined, `runner.${key} must not expose an unrestricted Host capability`)
    }
    for (const key of ['stateStore', 'pricing', 'ollama', 'probing', 'history']) {
      assert.equal(runner.services?.[key], undefined, `services.${key} must not expose an unrestricted Host capability`)
    }
  })

  const LEGACY_HTTP_PATHS = [
    '/run', '/try', '/batch-try', '/export', '/import', '/aliases', '/aliases/resolve',
    '/health', '/selection', '/policy', '/history', '/history/rollback', '/credentials',
    '/credentials/check', '/report', '/notifications', '/notifications/read',
    '/notifications/acknowledge', '/webhook/test', '/health/latency', '/pricing',
    '/probe/provider', '/probe/all', '/probe/status', '/probe/verified', '/ollama/ps',
    '/ollama/tags', '/ollama/info', '/ollama/pull', '/ollama/pull/status',
    '/ollama/unload', '/ollama/delete',
  ]
  const CONTRACT_HTTP_PATHS = ['/preview', '/apply', '/preview/cancel', '/status', '/reference-settings']
  const UNWIRED_HTTP_PATHS = ['/apply', '/preview/cancel']
  const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
  const FORK_BASE = '/dsh-model-metadata-sync'
  const OLD_BASE = '/dsh-model-sync'

  function registeredHttp() {
    const fixture = fakeHost()
    const registrations = []
    fixture.ctx.webServer = { register(route) { registrations.push(route); return () => {} } }
    fixture.ctx.webApp = { getAdvertisedUrl: () => 'http://127.0.0.1:3000' }
    registerHttpApi(fixture.ctx, fixture.runner)
    return { ...fixture, registrations }
  }

  async function invokeHttp(route, method, body = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    Object.assign(req, {
      method, url: `${route.path}?provider=openai&model=new-model&alias=example`,
      headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-origin' },
      socket: { remoteAddress: '127.0.0.1' },
    })
    const response = { status: undefined, headers: undefined, data: '' }
    const res = {
      writeHead(status, headers) { response.status = status; response.headers = headers; return this },
      end(data = '') { response.data += data; return this },
    }
    // This fixture exercises the post-admission handler only. Real Host-carrier
    // admission remains unverified and is not proved by this synthetic peer.
    await route.handler(req, res, { principal: { kind: 'owner' }, signal: { aborted: false } })
    assert.ok(Number.isInteger(response.status), `${method} ${route.path} did not finish`)
    try { response.body = JSON.parse(response.data) } catch { response.body = null }
    return response
  }

  test('fork registrations never claim the original HTTP namespace and reserve each authority route', () => {
    const { registrations } = registeredHttp()
    const paths = registrations.map(route => route.path)
    assert.equal(new Set(paths).size, paths.length, 'fork must not register a path twice')
    assert.equal(paths.filter(value => value === OLD_BASE || value.startsWith(`${OLD_BASE}/`)).length, 0,
      `original plugin namespace was registered: ${paths.filter(value => value.startsWith(OLD_BASE)).join(', ')}`)
    assert.ok(paths.every(value => value.startsWith(`${FORK_BASE}/`)), 'all registrations must belong to the fork')
    for (const suffix of CONTRACT_HTTP_PATHS) {
      assert.ok(paths.includes(`${FORK_BASE}${suffix}`), `missing future authority route ${suffix}`)
    }
    assert.deepEqual(paths.slice().sort(), [...CONTRACT_HTTP_PATHS, ...LEGACY_HTTP_PATHS].map(suffix => `${FORK_BASE}${suffix}`).sort(),
      'test must exercise every registered path')
    assert.ok(registrations.every(route => route.auth === 'required'), 'fork paths must request the Host authentication boundary')
  })

  test('unwired apply and cancellation paths remain explicitly unavailable', async () => {
    const fixture = registeredHttp()
    for (const suffix of UNWIRED_HTTP_PATHS) {
      const route = fixture.registrations.find(item => item.path === `${FORK_BASE}${suffix}`)
      assert.ok(route, `missing future authority route ${suffix}`)
      for (const method of METHODS) {
        const response = await invokeHttp(route, method, { provider: 'openai', previewId: 'unissued', digest: 'unissued' })
        assert.equal(response.status, 503, `${method} ${suffix}: ${response.data}`)
        assert.equal(response.body?.error?.code, 'AUTHORITY_UNAVAILABLE')
        assert.match(response.body.error.message, /unavailable|not yet/i)
      }
    }
    assert.deepEqual(fixture.effects, [])
    assert.deepEqual(globalRequests, [])
    assert.deepEqual(blockedNetwork, [])
  })

  for (const [name, before] of [
    ['omitted fields', [{ id: 'old-model' }]],
    ['over 5,000 models', Array.from({ length: 5001 }, (_, i) => ({ id: `model-${i}` }))],
  ]) {
    test(`registered rollback refuses legacy snapshot with ${name}`, async () => {
      const fixture = registeredHttp()
      fixture.config.history = [{ id: 'legacy', providers: [{ provider: 'openai', before }] }]
      const route = fixture.registrations.find(item => item.path === `${FORK_BASE}/history/rollback`)
        ?? fixture.registrations.find(item => item.path === `${OLD_BASE}/history/rollback`)
      assert.ok(route)
      const response = await invokeHttp(route, 'POST', { historyId: 'legacy', provider: 'openai' })
      assert.deepEqual(fixture.effects, [])
      assert.deepEqual(globalRequests, [])
      assert.deepEqual(blockedNetwork, [])
      assert.equal(response.status, 410, `${name}: ${response.data}`)
      assert.equal(response.body?.error?.code, 'UNSUPPORTED_OPERATION')
      assert.match(response.body.error.message, /omit.*field/i)
      assert.match(response.body.error.message, /truncat/i)
    })
  }

  for (const suffix of LEGACY_HTTP_PATHS) {
    test(`registered legacy ${suffix} refuses every HTTP method without side effects`, async () => {
      const fixture = registeredHttp()
      // Before the namespace fix, exercise the actual old registration, not a
      // fictitious 404, so RED captures inherited handler behavior.
      const route = fixture.registrations.find(item => item.path === `${FORK_BASE}${suffix}`)
        ?? fixture.registrations.find(item => item.path === `${OLD_BASE}${suffix}`)
      assert.ok(route, `legacy route ${suffix} must be an explicit refusal while supported as a compatibility endpoint`)
      const violations = []
      for (const method of METHODS) {
        fixture.effects.length = 0
        globalRequests.length = 0
        blockedNetwork.length = 0
        const response = await invokeHttp(route, method, {
          provider: 'openai', model: 'new-model', models: ['new-model'], alias: 'example',
          historyId: 'legacy', url: 'https://notify.example.invalid/webhook',
          providers: { openai: { selectedModels: ['new-model'] } }, scheduler: { autoApply: true },
          dryRun: false, forceNotify: true, include: ['new-model'],
        })
        if (fixture.effects.length || globalRequests.length || blockedNetwork.length) {
          violations.push(`${method}: effects=${JSON.stringify(fixture.effects)} fetch=${globalRequests.length} sockets=${JSON.stringify(blockedNetwork)}`)
        }
        if (response.status !== 410 || response.body?.error?.code !== 'UNSUPPORTED_OPERATION' ||
            !/unsupported|retired|disabled/i.test(response.body?.error?.message ?? '')) {
          violations.push(`${method}: ${response.status} ${response.data}`)
        }
      }
      assert.deepEqual(violations, [], `${suffix} must visibly refuse every method without Host or network effects`)
    })
  }

  test('standalone legacy config transfer and alias operations refuse before reading or saving', async () => {
    const effects = []
    const transfer = createConfigTransfer({
      getConfig() { effects.push('getConfig'); return {} },
      saveConfig() { effects.push('saveConfig') },
      listProviders() { effects.push('listProviders'); return [] },
      validatePolicy() { effects.push('validatePolicy'); return {} },
    })
    const violations = []
    for (const [method, args] of [
      ['exportConfig', []],
      ['importConfig', [{ providers: { openai: { selectedModels: ['new-model'] } }, scheduler: { autoApply: true } }]],
      ['getAliases', []],
      ['setAlias', [{ alias: 'example', provider: 'openai', model: 'new-model' }]],
      ['deleteAlias', [{ alias: 'example' }]],
      ['resolveAlias', ['example']],
    ]) {
      effects.length = 0
      let error
      try { await transfer[method](...args) } catch (caught) { error = caught }
      if (effects.length || error?.code !== 'UNSUPPORTED_OPERATION') {
        violations.push(`${method}: effects=${JSON.stringify(effects)}, error=${error?.code ?? 'none'}`)
      }
    }
    assert.deepEqual(violations, [], 'direct transfer must visibly refuse before interacting with Host state')
  })

  test('remote-effect and transfer entry points are unavailable or explicitly refuse', async () => {
    const cases = [
      ['health', { provider: 'openai' }], ['tryModel', { provider: 'openai', model: 'new-model' }],
      ['batchTryModels', { provider: 'openai', models: ['new-model'] }],
      ['probeModelCapabilities', { provider: 'openai', model: 'new-model' }],
      ['probeProviderCapabilities', { provider: 'openai' }], ['probeAllCapabilities', {}],
      ['syncPricing', {}], ['ollamaPs', {}], ['ollamaTags', {}], ['ollamaPull', { model: 'new-model' }],
      ['testWebhook', { url: 'https://notify.example.invalid/webhook' }],
      ['importConfig', { providers: { openai: { selectedModels: ['new-model'] } }, scheduler: { autoApply: true } }],
      ['setAlias', { alias: 'example', provider: 'openai', model: 'new-model' }],
      ['deleteAlias', { alias: 'example' }],
    ]
    for (const [method, argument] of cases) {
      const { runner, effects } = fakeHost()
      if (typeof runner[method] !== 'function') continue
      await refusesWithoutEffects(method, () => runner[method](argument), effects)
    }
    const { runner, effects } = fakeHost()
    if (typeof runner.services?.policy?.testWebhook === 'function') {
      await refusesWithoutEffects('services.policy.testWebhook', () => runner.services.policy.testWebhook({ url: 'https://notify.example.invalid' }), effects)
    }
  })
}
