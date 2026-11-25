import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Integration seam: the actual installed WebServer request listener, actual
// Connection source/authentication services, and this package's real route.
// Only the HTTP transport (no listening socket), WebApp advertised URL, and
// synthetic in-memory authentication provider are fixtures. This does not
// exercise Token's production cookie signing, expiration or exchange protocol.
const file = fileURLToPath(import.meta.url)
const repo = path.resolve(path.dirname(file), '..')
const CHILD = 'DSH_METADATA_REAL_CARRIER_CHILD'
const target = '/dsh-model-metadata-sync/preview'
const origin = 'http://127.0.0.1:31843'

if (process.env[CHILD] !== '1') {
  test('installed DSH WebServer/Connection admits the actual plugin route offline', (t) => {
    const executable = process.env.DSH_NODE_EXECUTABLE
    const installDir = process.env.DSH_INSTALL_DIR
    if (!executable || !installDir || !path.isAbsolute(executable) || !path.isAbsolute(installDir)) {
      t.skip('inconclusive: DSH_NODE_EXECUTABLE and DSH_INSTALL_DIR are required to locate the installed runtime')
      return
    }
    if (!fs.existsSync(executable)) {
      t.skip('inconclusive: the selected DSH runtime executable is unavailable')
      return
    }
    // A distinct owned directory, never a user profile. Explicitly bind every
    // home/config/data/temp variable and do not inherit the parent environment.
    const tmp = fs.realpathSync('/tmp')
    const owned = fs.mkdtempSync(path.join(tmp, 'dsh-real-carrier-'))
    assert.equal(path.dirname(owned), tmp)
    assert.match(path.basename(owned), /^dsh-real-carrier-/)
    try {
      const dirs = Object.fromEntries(['home', 'data', 'config', 'cache', 'temp'].map(name => {
        const dir = path.join(owned, name)
        fs.mkdirSync(dir)
        return [name, dir]
      }))
      const result = spawnSync(executable, ['--test', file], {
        cwd: repo,
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1',
          HOME: dirs.home, USERPROFILE: dirs.home, DSH_HOME: dirs.data,
          DSH_DATA_DIR: dirs.data, XDG_DATA_HOME: dirs.data,
          XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache,
          TMPDIR: dirs.temp, DSH_INSTALL_DIR: installDir, [CHILD]: '1',
        },
      })
      assert.equal(result.error, undefined, `isolated DSH process failed: ${result.error}`)
      assert.equal(result.signal, null, `isolated DSH process interrupted: ${result.signal}`)
      assert.equal(result.status, 0, `real carrier tests failed:\n${result.stdout}\n${result.stderr}`)
      const inconclusive = result.stdout.match(/REAL_CARRIER_INCONCLUSIVE=(.*)/)
      if (inconclusive) {
        t.skip(`inconclusive: ${inconclusive[1]}`)
        return
      }
      assert.match(result.stdout, /REAL_CARRIER_VERIFIED=9\b/, `no complete real-carrier evidence:\n${result.stdout}\n${result.stderr}`)
      console.log('Real installed WebServer + Connection: 9 offline carrier scenarios passed; synthetic provider, no production cookie claim.')
    } finally {
      // Never delete a computed path before rechecking its resolved identity.
      const resolved = fs.realpathSync(owned)
      assert.equal(resolved, owned)
      assert.equal(path.dirname(resolved), tmp)
      assert.match(path.basename(resolved), /^dsh-real-carrier-/)
      fs.rmSync(resolved, { recursive: true, force: true })
    }
  })
} else {
  test('real DSH carrier admission with a synthetic verifier', async (t) => {
    const sandbox = path.resolve(process.env.HOME || '', '..')
    const tmp = fs.realpathSync('/tmp')
    const inside = value => value && path.isAbsolute(value) && path.dirname(value) === sandbox
    if (path.dirname(sandbox) !== tmp || !/^dsh-real-carrier-/.test(path.basename(sandbox)) ||
        !['HOME', 'USERPROFILE', 'DSH_HOME', 'DSH_DATA_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR']
          .every(key => inside(process.env[key]))) {
      throw new Error('refusing to initialize without the disposable per-test home and data directories')
    }

    // Patch before loading any installed ESM packages. Synchronizing built-in
    // exports is essential: WebServer imports createServer as a named binding.
    // The real createServer still constructs the carrier and captures its real
    // request listener, but the listener is never bound to a socket.
    const http = await import('node:http').then(m => m.default)
    const https = await import('node:https').then(m => m.default)
    const net = await import('node:net').then(m => m.default)
    const tls = await import('node:tls').then(m => m.default)
    const dgram = await import('node:dgram').then(m => m.default)
    const { syncBuiltinESMExports, createRequire } = await import('node:module')
    const { pathToFileURL } = await import('node:url')
    const { EventEmitter } = await import('node:events')
    let listener
    let serverCreations = 0
    let forbiddenNetworkAttempts = 0
    const denyNetwork = () => { forbiddenNetworkAttempts++; throw new Error('offline test forbids network') }
    const createServer = http.createServer
    http.createServer = (...args) => {
      assert.equal(typeof args[0], 'function', 'expected WebServer to install the request listener')
      assert.equal(serverCreations++, 0, 'unexpected additional HTTP server')
      listener = args[0]
      const server = createServer(...args)
      server.listen = (_port, _host, cb) => { queueMicrotask(cb); return server }
      server.address = () => ({ address: '127.0.0.1', family: 'IPv4', port: 31843 })
      server.close = cb => { queueMicrotask(() => cb?.()); return server }
      server.closeAllConnections = () => {}
      return server
    }
    http.request = http.get = https.request = https.get = denyNetwork
    https.createServer = denyNetwork
    net.connect = net.createConnection = net.Socket.prototype.connect = denyNetwork
    net.Server.prototype.listen = denyNetwork
    tls.connect = dgram.createSocket = denyNetwork
    globalThis.fetch = denyNetwork
    syncBuiltinESMExports()

    const requireFromDsh = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'))
    let app
    let carrier
    let connection
    let registered
    try {
      const load = async name => import(pathToFileURL(requireFromDsh.resolve(name)).href)
      const [{ Context, Service }, webModule, connectionModule, { registerHttpApi }] = await Promise.all([
        load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-host-webserver'),
        load('@deepseek-ai/dsh-client-connection'), import('../lib/http.js'),
      ])
      const version = requireFromDsh('@deepseek-ai/dsh/package.json').version
      if (version !== '0.2.3-alpha.2') throw new Error(`requires installed DSH 0.2.3-alpha.2; found ${version}`)
      class FixtureWebApp extends Service {
        constructor(ctx) { super(ctx, 'webApp') }
        getAdvertisedUrl() { return origin }
      }
      app = new Context()
      await app.plugin(webModule.WebServer, { host: '127.0.0.1', port: 31843 })
      await app.plugin(FixtureWebApp)
      carrier = app.get('webServer')
      if (!carrier || typeof listener !== 'function' || serverCreations !== 1 || !app.get('webApp')) {
        throw new Error('real WebServer or captured listener did not initialize')
      }
      // Preserve these imports for the exercised phase outside the startup-only catch.
      connection = { module: connectionModule, registerHttpApi }
    } catch (error) {
      // A missing installed module or unsupported safe startup is not evidence.
      // Assertion failures after the listener was acquired are real failures.
      if (error instanceof assert.AssertionError) throw error
      console.log(`REAL_CARRIER_INCONCLUSIVE=${String(error?.message ?? error).replace(/[\r\n]/g, ' ')}`)
      t.skip('installed carrier/connection could not be safely initialized; see diagnostic')
      if (app) await app.fiber.dispose()
      return
    }

    const { module: connectionModule, registerHttpApi } = connection
    registered = registerHttpApi(app, {})
    assert.ok(Array.isArray(registered) && registered.length > 0, 'plugin routes not registered')
    // Required auth with no Connection authorization listener must fail closed.
    const unavailable = await request()
    assert.equal(unavailable.status, 503)
    assert.equal(unavailable.body, 'authentication unavailable')
    assert.equal(unavailable.headers['cache-control'], 'no-store')
    await app.plugin(connectionModule)
    connection = app.get('connection')
    assert.ok(connection && app.get('connection.authentication'), 'real Connection services did not initialize')
    assert.equal(typeof connection.createPeer, 'function')

    const owner = connection.createPeer({ principal: { kind: 'owner' } })
    const nonOwner = connection.createPeer({ principal: { kind: 'fixture-non-owner' } })
    let verificationCalls = 0
    const disposeProvider = connection.authentication.register({
      authenticate(request) {
        verificationCalls++
        switch (request.headers.authorization) {
          case 'Synthetic owner': return owner
          case 'Synthetic non-owner': return nonOwner
          case 'Synthetic throw': throw new Error('synthetic provider failure')
          default: return undefined
        }
      },
    })
    let verified = 1 // the no-Connection 503 above
    const check = async (description, options, expected, beforeVerify = false) => {
      await t.test(description, async () => {
        const previous = verificationCalls
        const response = await request(options)
        assert.equal(response.status, expected.status)
        assert.equal(response.headers['cache-control'], 'no-store')
        if (expected.body !== undefined) assert.equal(response.body, expected.body)
        if (expected.code !== undefined) assert.equal(JSON.parse(response.body).error.code, expected.code)
        if (beforeVerify) assert.equal(verificationCalls, previous, 'source fence must run before provider')
        verified++
      })
    }
    try {
      await check('missing credentials -> real Connection 401', {}, { status: 401, body: 'unauthorized' })
      await check('invalid synthetic credentials -> 401', { authorization: 'Synthetic wrong' }, { status: 401, body: 'unauthorized' })
      await check('cross-origin request rejected by source fence before provider', { authorization: 'Synthetic owner', origin: 'http://attacker.invalid' }, { status: 403, body: 'forbidden' }, true)
      await check('cross-site Fetch Metadata rejected before provider', { authorization: 'Synthetic owner', site: 'cross-site' }, { status: 403, body: 'forbidden' }, true)
      await check('untrusted Host rejected by source fence before provider', { authorization: 'Synthetic owner', host: 'attacker.invalid:31843' }, { status: 403, body: 'forbidden' }, true)
      await check('synthetic provider failure -> real Connection 503', { authorization: 'Synthetic throw' }, { status: 503, body: 'authentication unavailable' })
      await check('real non-owner Peer reaches plugin and is refused', { authorization: 'Synthetic non-owner' }, { status: 403, code: 'AUTH_REQUIRED' })
      await check('real owner Peer reaches plugin and missing Host wiring fails closed', { authorization: 'Synthetic owner' }, { status: 503, code: 'SETTINGS_UNAVAILABLE' })
      assert.equal(verified, 9)
      assert.equal(forbiddenNetworkAttempts, 0, 'the fixture or runtime attempted a network operation')
      console.log(`REAL_CARRIER_VERIFIED=${verified}`)
    } finally {
      await disposeProvider()
      await owner.dispose()
      await nonOwner.dispose()
      for (const dispose of registered) dispose()
      await app.fiber.dispose()
    }

    // Capture actual WebServer listener output, not direct route invocation.
    function request(options = {}) {
      const headers = {
        host: options.host ?? '127.0.0.1:31843',
        origin: options.origin ?? origin,
        'sec-fetch-site': options.site ?? 'same-origin',
      }
      if (options.authorization !== undefined) headers.authorization = options.authorization
      const req = new EventEmitter()
      Object.assign(req, { method: 'POST', url: target, headers, socket: { destroyed: false, remoteAddress: '127.0.0.1' } })
      const res = new EventEmitter()
      const response = { status: undefined, headers: {}, body: '' }
      Object.assign(res, {
        headersSent: false, writableEnded: false, destroyed: false,
        writeHead(status, headers = {}) {
          response.status = status
          response.headers = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
          this.headersSent = true
          return this
        },
        end(body = '') {
          response.body += Buffer.isBuffer(body) ? body.toString('utf8') : String(body)
          this.writableEnded = true
          this.emit('finish')
          resolveResponse(response)
          return this
        },
        destroy() { this.destroyed = true; this.emit('close'); rejectResponse(new Error('response destroyed')) },
      })
      let resolveResponse
      let rejectResponse
      const completed = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject })
      listener(req, res)
      return completed
    }
  })
}
