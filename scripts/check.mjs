// Local, offline release gate. It does not publish or install anything.
// A successful syntax/pack run is not evidence of the real DSH lifecycle.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)))
const problems = []
const info = message => console.log(`[check] ${message}`)
const fail = message => { problems.push(message); console.error(`[check] FAIL: ${message}`) }
const required = [
  'package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/index.d.ts', 'lib/client.js', 'lib/client.d.ts',
  'README.md', 'README.zh.md', 'README.ru.md', 'LICENSE', 'icon.svg', 'locale/en.json', 'locale/zh.json',
  'scripts/check.mjs',
]
const inside = (parent, child) => child.startsWith(`${parent}${path.sep}`)
const safeName = name => typeof name === 'string' && !!name && !path.posix.isAbsolute(name) &&
  !name.includes('\\') && !/[\x00-\x1f\x7f]/.test(name) &&
  !name.split('/').some(part => !part || part === '.' || part === '..') &&
  !/(?:^|\/)(?:\.git|\.npmrc|\.env(?:\.[^/]*)?|node_modules|\.dsh)(?:\/|$)/i.test(name) &&
  !/\.(?:pem|key|p12|pfx)$/i.test(name)

function regularFile(name) {
  if (!safeName(name)) throw new Error(`unsafe package path ${JSON.stringify(name)}`)
  let current = root
  for (const part of name.split('/')) {
    current = path.join(current, part)
    if (lstatSync(current).isSymbolicLink()) throw new Error(`symlink in package path ${name}`)
  }
  if (!inside(root, realpathSync(current)) || !lstatSync(current).isFile()) {
    throw new Error(`package path is not a regular file inside the package: ${name}`)
  }
  return current
}

function command(label, executable, args, options) {
  const result = spawnSync(executable, args, {
    cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, ...options,
  })
  if (result.error || result.signal || result.status !== 0) {
    fail(`${label} did not complete successfully (status ${result.status}, signal ${result.signal ?? 'none'}): ${result.error?.message ?? ''}`)
    if (result.stderr) console.error(result.stderr)
    if (result.stdout) console.error(result.stdout)
  }
  return result
}

function checkManifest() {
  try {
    const pkg = JSON.parse(readFileSync(regularFile('package.json'), 'utf8'))
    if (pkg.name !== 'dsh-model-metadata-sync' || pkg.license !== 'MIT' || pkg.type !== 'module' ||
        pkg.main !== './lib/index.js' || pkg.types !== './lib/index.d.ts' ||
        pkg.exports?.['.']?.default !== './lib/index.js' || pkg.exports?.['.']?.types !== './lib/index.d.ts' ||
        pkg.exports?.['./client']?.default !== './lib/client.js' || pkg.exports?.['./client']?.types !== './lib/client.d.ts' ||
        pkg.exports?.['./icon'] !== './icon.svg' || pkg.icon !== './icon.svg' ||
        pkg.exports?.['./locale/*.json'] !== './locale/*.json' ||
        pkg.exports?.['./cordis.patch.yml'] !== './cordis.patch.yml' ||
        pkg.dsh?.bundle?.patch !== './cordis.patch.yml' || pkg.dsh?.client?.platform !== 'web') {
      throw new Error('package name, license, DSH manifest or entry/export differs from the contract')
    }
    for (const [name, value] of Object.entries(pkg.scripts ?? {})) {
      if (typeof value !== 'string') throw new Error(`invalid npm script ${name}`)
      for (const match of value.matchAll(/(?:^|\s)(scripts\/[A-Za-z0-9._/-]+\.(?:m?js|cjs))\b/g)) regularFile(match[1])
      for (const match of value.matchAll(/\bnpm\s+run\s+([\w:-]+)/g)) {
        if (!Object.hasOwn(pkg.scripts, match[1])) throw new Error(`missing npm script ${match[1]}`)
      }
    }
    if (typeof pkg.scripts?.test !== 'string' || typeof pkg.scripts?.check !== 'string') throw new Error('test/check commands are required')
    for (const name of required) {
      if (lstatSync(regularFile(name)).size === 0) throw new Error(`empty required resource ${name}`)
    }
    const license = readFileSync(regularFile('LICENSE'))
    if (createHash('sha256').update(license).digest('hex') !== 'dc6f2fbad994189e1e1466c51173363264826fc454f0cfccdafa91a9a41b6365') {
      throw new Error('upstream MIT license and attribution changed')
    }
    for (const locale of ['en', 'zh']) {
      const { meta } = JSON.parse(readFileSync(regularFile(`locale/${locale}.json`), 'utf8'))
      if (typeof meta?.title !== 'string' || !meta.title.trim() || typeof meta?.description !== 'string' || !meta.description.trim()) {
        throw new Error(`locale ${locale} is missing usable display metadata`)
      }
    }
    const icon = readFileSync(regularFile('icon.svg'), 'utf8')
    if (Buffer.byteLength(icon) > 256 * 1024 || !/<svg\b[^>]*xmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/.test(icon) ||
        !/<\/svg>\s*$/.test(icon) || /<(?:script|style|image|foreignObject|text|animate)\b|\bon\w+\s*=|(?:href|url)\s*=/i.test(icon)) {
      throw new Error('icon is not a bounded self-contained SVG')
    }
    info('manifest, license and local display resources verified')
  } catch (error) { fail(`manifest/resources: ${error.message}`) }
}

function checkPackedTree(env) {
  const result = command('npm offline pack --dry-run', 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--offline'], { env })
  if (result.error || result.signal || result.status !== 0) return []
  try {
    const reports = JSON.parse(result.stdout)
    if (!Array.isArray(reports) || reports.length !== 1 || reports[0].name !== 'dsh-model-metadata-sync' || !Array.isArray(reports[0].files)) {
      throw new Error('npm returned an unexpected package inventory')
    }
    const names = reports[0].files.map(file => file.path)
    if (new Set(names).size !== names.length) throw new Error('duplicate packed paths')
    for (const name of names) regularFile(name)
    for (const name of required) if (!names.includes(name)) throw new Error(`missing packed file ${name}`)
    info(`actual npm dry-run inventory: ${names.length} safe files, including shipped Host and Client entries`)
    return names
  } catch (error) { fail(`packed tree: ${error.message}`); return [] }
}

function checkSyntax(packed, env) {
  const files = new Set(packed.filter(name => /\.(?:cjs|mjs|js)$/.test(name)))
  try {
    const walk = dirname => {
      for (const entry of readdirSync(path.join(root, dirname), { withFileTypes: true })) {
        const name = `${dirname}/${entry.name}`
        if (entry.isSymbolicLink()) throw new Error(`symlink in source tree: ${name}`)
        if (entry.isDirectory()) walk(name)
        else if (entry.isFile() && /\.(?:cjs|mjs|js)$/.test(name)) files.add(name)
      }
    }
    for (const dir of ['lib', 'scripts', 'test']) walk(dir)
    if (!files.has('lib/client.js')) throw new Error('shipped Client is not included in syntax checks')
    let invalid = 0
    for (const name of [...files].sort()) {
      const result = command(`syntax ${name}`, process.execPath, ['--check', regularFile(name)], { env })
      if (result.error || result.signal || result.status !== 0) invalid++
    }
    if (!invalid) info(`parsed ${files.size} local/packaged JavaScript files including shipped Client`)
  } catch (error) { fail(`JavaScript syntax inventory: ${error.message}`) }
}

function checkTests(env) {
  try {
    const tests = readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.test.js')).sort().map(name => `test/${name}`)
    if (!tests.length) throw new Error('zero test files selected')
    for (const name of tests) regularFile(name)
    // Explicit reporter and files prevent a successful empty default discovery.
    const result = command('offline test suite', process.execPath, ['--test', '--test-reporter=tap', ...tests], { env, timeout: 240000 })
    const output = result.stdout ?? ''
    const counts = {}
    for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
      const matches = [...output.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))]
      if (!matches.length) throw new Error(`test runner omitted ${key} summary`)
      counts[key] = Number(matches.at(-1)[1])
    }
    info(`offline suite: ${Object.entries(counts).map(([key, count]) => `${key}=${count}`).join(' ')}`)
    const unresolvedChildren = [...output.matchAll(/^# .*?(\d+)\s+skipped\b.*$/gim)].map(match => match[0]).filter(line => !/^# skipped \d+$/i.test(line) && !/\b0\s+skipped\b/i.test(line))
    for (const line of unresolvedChildren) fail(`nested test coverage inconclusive: ${line.slice(2)}`)
    // Node counts a successfully loaded but empty test file as one passing case.
    // Explicit test declarations produce this TAP marker; a file wrapper does not.
    // Fail closed when only empty/misdiscovered files appear, even if the final
    // numerical Node summary claims a pass.
    const fileLabels = new Set(tests.flatMap(name => [name, path.join(root, name), path.basename(name)]))
    const actualCases = [...output.matchAll(/^\s*# Subtest:\s+(.+)$/gm)]
      .filter(match => !fileLabels.has(match[1].trim())).length
    if (counts.tests === 0 || counts.pass === 0 || actualCases === 0) fail('zero executed passing tests is not release evidence')
    else info(`${actualCases} named behavioral test declarations observed`)
    if (counts.fail || counts.cancelled || counts.skipped || counts.todo) {
      fail(`unresolved test outcomes: failed=${counts.fail}, cancelled=${counts.cancelled}, skipped=${counts.skipped}, TODO=${counts.todo}`)
    }
  } catch (error) { fail(`test evidence: ${error.message}`) }
}

async function checkAuthority() {
  try {
    const { registerHttpApi } = await import(pathToFileURL(regularFile('lib/http.js')).href)
    const routes = []
    registerHttpApi({ webServer: { register: route => { routes.push(route); return () => {} } },
      webApp: { getAdvertisedUrl: () => 'http://127.0.0.1:31843' } }, {})
    const unavailable = []
    for (const suffix of ['/preview', '/apply', '/preview/cancel', '/status', '/reference-settings']) {
      const route = routes.find(item => item.path === `/dsh-model-metadata-sync${suffix}`)
      if (!route) { unavailable.push(`${suffix}:missing`); continue }
      let code = 0
      let body = ''
      const res = { writeHead(status) { code = status; return this }, end(value = '') { body += value; return this } }
      await route.handler({ method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res,
        { principal: { kind: 'owner' }, signal: { aborted: false } })
      let parsed
      try { parsed = JSON.parse(body) } catch { parsed = null }
      if (code === 503 && parsed?.error?.code === 'AUTHORITY_UNAVAILABLE') unavailable.push(suffix)
    }
    if (unavailable.length) fail(`T40 metadata authority unavailable (actual registered routes): ${unavailable.join(', ')}`)
    else info('T40 route stubs were not observed; a probe alone is not end-to-end proof')
  } catch (error) { fail(`T40 route probe inconclusive: ${error.message}`) }
}

const temporaryRoot = realpathSync(tmpdir())
const temporary = mkdtempSync(path.join(temporaryRoot, 'dsh-release-check-'))
try {
  const home = path.join(temporary, 'home')
  mkdirSync(home)
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, USERPROFILE: home,
    npm_config_offline: 'true', npm_config_ignore_scripts: 'true',
    npm_config_userconfig: path.join(temporary, 'user.npmrc'),
    npm_config_globalconfig: path.join(temporary, 'global.npmrc'),
    npm_config_cache: path.join(temporary, 'npm-cache'), npm_config_update_notifier: 'false',
    npm_config_audit: 'false', npm_config_fund: 'false',
  }
  checkManifest()
  const packed = checkPackedTree(env)
  checkSyntax(packed, env)
  checkTests(env)
  await checkAuthority()
  // T49/T50 require a separate disposable real DSH installation and a checked
  // evidence review. A fake Host or a skipped carrier test cannot replace that.
  fail('T49 real DSH install/enable/load/unload/restart: INCONCLUSIVE; not run by this offline check; no release authorized')
} finally {
  // Remove only this freshly created, revalidated directory.
  if (realpathSync(temporary) === temporary && path.dirname(temporary) === temporaryRoot && /^dsh-release-check-/.test(path.basename(temporary))) {
    rmSync(temporary, { recursive: true })
  } else fail('temporary-directory identity changed; refusing cleanup')
}
if (problems.length) {
  console.error(`[check] ${problems.length} release prerequisite(s) failed or inconclusive`)
  process.exitCode = 1
} else info('local checks passed; publishing is not performed automatically')
