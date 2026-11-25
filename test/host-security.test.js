import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// All fixtures run in a newly owned HOME, data and temp tree with an explicit,
// minimal environment. No installed user profile or real credentials are used.
const filename = fileURLToPath(import.meta.url)
const repo = path.resolve(path.dirname(filename), '..')
const within = (parent, child) => {
  const relative = path.relative(parent, child)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

if (process.env.METADATA_SECURITY_CHILD !== '1') {
  test('registered route security in a disposable Host environment', () => {
    const parent = fs.realpathSync(os.tmpdir())
    const owned = fs.mkdtempSync(path.join(parent, 'dsh-metadata-security-'))
    let realHome
    if (process.env.HOME) {
      try { realHome = fs.realpathSync(process.env.HOME) }
      catch (error) {
        if (error?.code !== 'ENOENT') throw error
        realHome = path.resolve(process.env.HOME)
      }
    }
    assert.equal(path.dirname(owned), parent)
    assert.ok(!within(repo, owned) && (!realHome || !within(realHome, owned)))
    try {
      const home = path.join(owned, 'home')
      const data = path.join(owned, 'data')
      const temp = path.join(owned, 'temp')
      for (const dir of [home, data, temp]) fs.mkdirSync(dir)
      const child = spawnSync(process.execPath, ['--test', filename], {
        cwd: repo,
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          PATH: '/usr/bin:/bin', HOME: home, USERPROFILE: home, TMPDIR: temp,
          DSH_HOME: data, DSH_DATA_DIR: data, METADATA_SECURITY_CHILD: '1',
        },
      })
      assert.equal(child.error, undefined, `isolated test failed to start: ${child.error}`)
      assert.equal(child.signal, null, `isolated test interrupted: ${child.signal}`)
      assert.equal(child.status, 0, `isolated tests failed:\n${child.stdout}\n${child.stderr}`)
      assert.match(child.stdout, /(?:#|ℹ)\s+tests [1-9]\d*/, 'zero executed tests are not evidence')
      console.log(`isolated registered-route security: ${child.stdout.match(/(?:#|ℹ)\s+tests (\d+)/)?.[1]} tests`)
      console.log('actual DSH Host carrier authentication 401/403/503: inconclusive; not exercised')
    } finally {
      // Cleanup is limited to this exact newly created temporary directory.
      assert.equal(path.dirname(owned), parent)
      assert.match(path.basename(owned), /^dsh-metadata-security-/)
      fs.rmSync(owned, { recursive: true, force: true })
    }
  })
} else {
  const owned = path.dirname(process.env.HOME || '')
  if (!path.isAbsolute(owned) || !/^dsh-metadata-security-/.test(path.basename(owned)) ||
      ![process.env.HOME, process.env.DSH_HOME, process.env.DSH_DATA_DIR, process.env.TMPDIR]
        .every(value => value && within(owned, value)) || within(repo, owned)) {
    throw new Error('refusing to run without an isolated temporary Host environment')
  }
  const { registerHttpApi } = await import('../lib/http.js')
  const peer = { principal: { kind: 'owner' }, signal: new AbortController().signal }

  function routes(advertised = 'http://127.0.0.1:3000') {
    const registrations = []
    const ctx = {
      webServer: { register(route) { registrations.push(route); return () => {} } },
      webApp: { getAdvertisedUrl: () => advertised },
      logger: { error() {} },
    }
    registerHttpApi(ctx, {})
    return registrations
  }

  async function invoke(route, { origin = 'http://127.0.0.1:3000', method = 'POST', site = 'same-origin', admitted = peer, headers: extra = {} } = {}) {
    const headers = { host: '127.0.0.1:3000', ...extra }
    if (origin !== null) headers.origin = origin
    if (site !== null) headers['sec-fetch-site'] = site
    const req = { method, headers, socket: { remoteAddress: '127.0.0.1' } }
    const result = { data: '' }
    const res = {
      writeHead(status, headers) { result.status = status; result.headers = headers; return this },
      end(data = '') { result.data += data; return this },
    }
    await route.handler(req, res, admitted)
    result.body = JSON.parse(result.data)
    return result
  }

  test('authenticated same-authority cross-scheme write is refused', async () => {
    const route = routes().find(value => value.path.endsWith('/preview'))
    assert.ok(route)
    assert.equal(route.auth, 'required')
    const response = await invoke(route, { origin: 'https://127.0.0.1:3000' })
    assert.equal(response.status, 403)
    assert.equal(response.body.error.code, 'ORIGIN_REFUSED')
  })

  test('cross-site Fetch Metadata is refused even when Origin matches on reads', async () => {
    const route = routes().find(value => value.path.endsWith('/status'))
    const response = await invoke(route, { method: 'GET', origin: 'http://127.0.0.1:3000', site: 'cross-site' })
    assert.equal(response.status, 403)
    assert.equal(response.body.error.code, 'ORIGIN_REFUSED')
  })

  const cases = [
    ['missing Origin', { origin: null }],
    ['null Origin', { origin: 'null' }],
    ['malformed Origin', { origin: 'not a url' }],
    ['origin with trailing slash', { origin: 'http://127.0.0.1:3000/' }],
    ['origin with path', { origin: 'http://127.0.0.1:3000/attack' }],
    ['origin with credentials', { origin: 'http://attacker@127.0.0.1:3000' }],
    ['origin with fragment', { origin: 'http://127.0.0.1:3000#x' }],
    ['different host', { origin: 'http://evil.example:3000' }],
    ['different port', { origin: 'http://127.0.0.1:3001' }],
    ['same authority different scheme', { origin: 'https://127.0.0.1:3000' }],
    ['missing Fetch Metadata', { site: null }],
    ['cross-site Fetch Metadata', { site: 'cross-site' }],
    ['same-site Fetch Metadata', { site: 'same-site' }],
    ['ambiguous Fetch Metadata', { site: ['same-origin', 'cross-site'] }],
  ]
  for (const [description, request] of cases) {
    test(`state-changing request rejects ${description}`, async () => {
      const route = routes().find(value => value.path.endsWith('/apply'))
      const response = await invoke(route, request)
      assert.equal(response.status, 403)
      assert.equal(response.body.error.code, 'ORIGIN_REFUSED')
      assert.equal(response.headers['cache-control'], 'no-store')
    })
  }

  test('all named routes require DSH authentication and origin checks precede business handlers', async () => {
    const registered = routes()
    assert.ok(registered.length > 5)
    for (const route of registered) {
      assert.equal(route.auth, 'required', route.path)
      const valid = await invoke(route)
      const authorityPaths = ['/preview', '/apply', '/preview/cancel', '/status', '/reference-settings']
        .map(suffix => `/dsh-model-metadata-sync${suffix}`)
      assert.equal(valid.status, authorityPaths.includes(route.path) ? 503 : 410, route.path)
      const invalid = await invoke(route, { origin: 'https://attacker.invalid' })
      assert.equal(invalid.status, 403, route.path)
      assert.equal(invalid.body.error.code, 'ORIGIN_REFUSED', route.path)
    }
  })

  for (const [description, admitted, expected] of [
    ['missing', null, 401],
    ['aborted', { principal: { kind: 'owner' }, signal: AbortSignal.abort() }, 401],
    ['non-owner', { principal: { kind: 'untrusted' }, signal: new AbortController().signal }, 403],
  ]) {
    test(`${description} Host admission cannot be replaced by loopback or cookie spelling`, async () => {
      const route = routes().find(value => value.path.endsWith('/preview'))
      const response = await invoke(route, { admitted, headers: { cookie: 'dsh_token=pretend; dsh_lan_pin=pretend; dsh-auth-spoof=pretend' } })
      assert.equal(response.status, expected)
      assert.equal(response.body.error.code, 'AUTH_REQUIRED')
    })
  }

  test('unproven forwarding metadata cannot authorize a state change even if origin matches', async () => {
    const route = routes('https://portal.example:9443/ui/').find(value => value.path.endsWith('/reference-settings'))
    const response = await invoke(route, {
      origin: 'https://portal.example:9443',
      headers: { host: 'portal.example:9443', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'attacker.invalid' },
    })
    assert.equal(response.status, 403)
    assert.equal(response.body.error.code, 'ORIGIN_REFUSED')
  })

  test('forwarding metadata blocks a write even when Origin equals the listener fallback', async () => {
    const route = routes().find(value => value.path.endsWith('/preview'))
    const response = await invoke(route, {
      origin: 'http://127.0.0.1:3000',
      headers: { forwarded: 'proto=https;host=portal.invalid', 'x-forwarded-host': 'portal.invalid', 'x-forwarded-proto': 'https' },
    })
    assert.equal(response.status, 403)
    assert.equal(response.body.error.code, 'ORIGIN_REFUSED')
  })

  test('client Host and Forwarded headers cannot establish an unconfigured public origin', async () => {
    const route = routes().find(value => value.path.endsWith('/preview'))
    const response = await invoke(route, {
      origin: 'https://portal.example:9443',
      headers: { host: 'portal.example:9443', 'x-forwarded-host': 'portal.example:9443',
        'x-forwarded-proto': 'https', forwarded: 'proto=https;host=portal.example:9443' },
    })
    assert.equal(response.status, 403)
    assert.equal(response.body.error.code, 'ORIGIN_REFUSED')
  })

  for (const [description, value] of [
    ['missing', undefined], ['not a URL', 'not a URL'], ['opaque', 'file:///tmp/index'],
    ['credentials', 'http://user:pass@127.0.0.1:3000'], ['query', 'http://127.0.0.1:3000/?token=secret'],
  ]) {
    test(`unproven Host public origin (${description}) fails closed`, async () => {
      const registered = []
      const ctx = { webServer: { register(route) { registered.push(route) } } }
      if (value !== undefined) ctx.webApp = { getAdvertisedUrl: () => value }
      registerHttpApi(ctx, {})
      const route = registered.find(item => item.path.endsWith('/preview'))
      const response = await invoke(route)
      assert.equal(response.status, 403)
      assert.equal(response.body.error.code, 'ORIGIN_REFUSED')
    })
  }
}
