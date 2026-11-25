import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const valueExports = source => [...source.matchAll(/\bexport\s+declare\s+(?:const|function)\s+(\w+)/g)]
  .map(match => match[1]).sort()
const declaredInterface = (source, name) => {
  const match = source.match(new RegExp(`export\\s+interface\\s+${name}\\s*\\{([^}]*)\\}`, 's'))
  assert.ok(match, `missing interface ${name}`)
  return match[1]
}

// The shipped client is a browser module-loader factory, not a native ESM
// module. No DOM, Host, network, or user profile is involved in loading it.
function shippedClient() {
  let registration
  const window = { __ModuleLoader__: { load(value) { registration = value } } }
  vm.runInNewContext(read('lib/client.js'), { window })
  assert.equal(registration.id, 'dsh-model-metadata-sync')
  return registration.factory(name => {
    assert.equal(name, 'react')
    return { createElement() {} }
  })
}

// Exercise the real Host module exports without activating the plugin. When
// Schemastery is absent, a loader-only stub permits module evaluation, but is
// explicitly not evidence that the real runtime schema or types validate.
async function loadHost(t) {
  try {
    import.meta.resolve('@deepseek-ai/schemastery')
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
    const { registerHooks } = await import('node:module')
    if (!registerHooks) {
      t.diagnostic('INCONCLUSIVE: Host runtime export test needs Schemastery or node:module registerHooks; static checks still run')
      return null
    }
    t.diagnostic('INCONCLUSIVE: real Schemastery schema/types unavailable; loader stub used only to evaluate Host exports')
    const stub = `const field = () => ({ default() { return this }, volatile() { return this } }); export default { boolean: field, object: value => value }`
    const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === '@deepseek-ai/schemastery') return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
      return nextResolve(specifier, context)
    } })
    try { return await import('../lib/index.js') } finally { hooks.deregister() }
  }
  return import('../lib/index.js')
}

test('Host declarations match the independent runtime value exports, not inherited services', async t => {
  const declaration = read('lib/index.d.ts')
  const expected = ['Config', 'apply', 'createForkReferenceSettings', 'inject', 'name', 'plainConfig'].sort()
  assert.deepEqual(valueExports(declaration), expected)
  assert.match(declaration, /\bname\s*=\s*['"]dsh-model-metadata-sync['"]/)
  assert.match(declaration, /\binject\s*:\s*(?:readonly\s*)?\[\s*['"]webServer['"]\s*,\s*['"]webApp['"]\s*\]/)
  const config = declaredInterface(declaration, 'ModelSyncConfig')
  assert.match(config, /\benabled\??\s*:\s*boolean/)
  assert.match(config, /\breferenceEnabled\??\s*:\s*boolean/)
  assert.doesNotMatch(declaration, /@goodandready\/dsh-model-sync|declare\s+module\s+['"]@deepseek-ai\/cordis['"]|\b(?:ModelSynchronizer|ProviderService|RuntimeStateStore|modelSyncRunner|pricing|probing|ollama)\b/i)
  const host = await loadHost(t)
  if (host) {
    assert.deepEqual(Object.keys(host).sort(), expected)
    assert.equal(host.name, 'dsh-model-metadata-sync')
    assert.deepEqual(host.inject, ['webServer', 'webApp'])
  }
})

test('reference preference unwraps lazily and cannot write after disposal', async t => {
  const declaration = read('lib/index.d.ts')
  assert.match(declaration, /\bcreateForkReferenceSettings\s*\(/)
  assert.match(declaration, /\bgetReferenceEnabled\s*\(\)\s*:\s*boolean/)
  assert.match(declaration, /\bsetReferenceEnabled\s*\([^)]*boolean[^)]*\)\s*:\s*Promise<void>/)
  assert.match(declaration, /\bdispose\s*\(\)\s*:\s*void/)
  const host = await loadHost(t)
  if (!host) return
  let enabled = true
  let writes = 0
  const entry = {}
  const reference = host.createForkReferenceSettings({ fiber: { entry }, get: () => ({
    edit: async (target, change) => {
      assert.equal(target, entry)
      enabled = change({ referenceEnabled: enabled, extra: 1 }).referenceEnabled
      writes++
    },
  }) }, { referenceEnabled: { get: () => enabled } })
  assert.equal(reference.getReferenceEnabled(), true)
  await reference.setReferenceEnabled(false)
  assert.equal(reference.getReferenceEnabled(), false)
  assert.equal(host.plainConfig({ a: [{ get: () => 2 }] }).a[0], 2)
  await assert.rejects(reference.setReferenceEnabled('false'), error => error.code === 'INVALID_CONFIG')
  reference.dispose()
  await assert.rejects(reference.setReferenceEnabled(true), error => error.code === 'CONFIG_UNAVAILABLE')
  assert.equal(writes, 1)
})

test('Client declarations match the browser factory exports and inject tokens', () => {
  const declaration = read('lib/client.d.ts')
  const client = shippedClient()
  const expected = ['apply', 'createController', 'createModelSyncApiClient', 'dictionaries', 'inject', 'presentPreview'].sort()
  assert.deepEqual(Object.keys(client).sort(), expected)
  assert.deepEqual(valueExports(declaration), expected)
  assert.deepEqual(Array.from(client.inject), ['slots', 'locale'])
  assert.match(declaration, /\binject\s*:\s*(?:readonly\s*)?\[\s*['"]slots['"]\s*,\s*['"]locale['"]\s*\]/)
  assert.doesNotMatch(declaration, /@goodandready\/dsh-model-sync|\bmodelSyncRunner\b|@deepseek-ai\/dsh-client-ui-settings/)
})

test('Client API and controller describe only the observable fork-facing methods', async () => {
  const declaration = read('lib/client.d.ts')
  const client = shippedClient()
  const requests = []
  const api = client.createModelSyncApiClient({ fetchImpl: async (url, init) => {
    requests.push([url, init.method])
    return { ok: true, status: 200, text: async () => '{}' }
  } })
  const apiMethods = ['apply', 'cancel', 'getStatus', 'preview', 'setReferenceEnabled']
  assert.deepEqual(Object.keys(api).sort(), apiMethods)
  const apiDeclaration = declaredInterface(declaration, 'ModelSyncApiClient')
  for (const method of apiMethods) assert.match(apiDeclaration, new RegExp(`\\b${method}\\s*\\(`))
  await api.getStatus()
  assert.deepEqual(requests, [['/dsh-model-metadata-sync/status', 'GET']])
  const controller = client.createController(api)
  const methods = ['activate', 'back', 'cancelPreview', 'chooseProvider', 'chooseReference', 'confirmApply', 'dispose', 'loadStatus', 'preview', 'review', 'saveReference', 'selectNew', 'snapshot'].sort()
  assert.deepEqual(Object.keys(controller).sort(), methods)
  const controllerDeclaration = declaredInterface(declaration, 'ModelSyncController')
  for (const method of methods) assert.match(controllerDeclaration, new RegExp(`\\b${method}\\s*\\(`))
  assert.equal(client.presentPreview(null).canReview, false)
  assert.equal(typeof client.dictionaries.en.title, 'string')
  assert.equal(typeof client.dictionaries.zh.title, 'string')
})
