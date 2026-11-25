import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, lstatSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

function withOfflineNpm(run) {
  const temp = realpathSync(tmpdir())
  const owned = mkdtempSync(path.join(temp, 'dsh-package-test-'))
  try {
    assert.ok(path.isAbsolute(owned))
    assert.equal(realpathSync(owned), owned)
    assert.equal(path.dirname(owned), temp)
    assert.match(path.basename(owned), /^dsh-package-test-/)
    const mode = statSync(owned).mode
    assert.equal(mode & 0o077, 0, 'temporary package directory must be private')
    const home = path.join(owned, 'home')
    mkdirSync(home)
    return run({
      PATH: process.env.PATH,
      DSH_PACKAGE_FIXTURE_ROOT: owned,
      HOME: home,
      USERPROFILE: home,
      npm_config_offline: 'true',
      npm_config_ignore_scripts: 'true',
      npm_config_userconfig: path.join(owned, 'user.npmrc'),
      npm_config_globalconfig: path.join(owned, 'global.npmrc'),
      npm_config_cache: path.join(owned, 'cache'),
      npm_config_update_notifier: 'false',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    })
  } finally {
    assert.equal(realpathSync(owned), owned)
    assert.equal(path.dirname(owned), temp)
    assert.match(path.basename(owned), /^dsh-package-test-/)
    rmSync(owned, { recursive: true })
  }
}

function fixture(env) {
  const dir = path.join(env.DSH_PACKAGE_FIXTURE_ROOT, 'package')
  mkdirSync(dir)
  for (const name of ['package.json', 'cordis.patch.yml', 'LICENSE', 'icon.svg', 'README.md', 'README.zh.md', 'README.ru.md', 'lib', 'locale', 'scripts']) {
    cpSync(path.join(root, name), path.join(dir, name), { recursive: true })
  }
  mkdirSync(path.join(dir, 'test'))
  return dir
}

function runFixture(dir, env) {
  return spawnSync(process.execPath, ['scripts/check.mjs'], {
    cwd: dir, env, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  })
}

function assertSafePath(name) {
  assert.equal(typeof name, 'string')
  assert.ok(name && !path.posix.isAbsolute(name) && !name.includes('\\'), name)
  assert.ok(!name.split('/').some(part => !part || part === '.' || part === '..'), name)
  assert.doesNotMatch(name, /[\x00-\x1f\x7f]/)
  assert.doesNotMatch(name, /(?:^|\/)(?:\.git|\.npmrc|\.env(?:\.[^/]*)?|node_modules|\.dsh)(?:\/|$)/i)
  assert.doesNotMatch(name, /\.(?:pem|key|p12|pfx)$/i)
}

// The local CLI and actual npm file inventory are the public seams. These tests
// never execute a lifecycle script or contact a registry.
test('package commands do not refer to missing local scripts or npm tasks', () => {
  assert.equal(typeof manifest.scripts?.test, 'string')
  assert.equal(typeof manifest.scripts?.check, 'string')
  const missing = []
  for (const [name, command] of Object.entries(manifest.scripts)) {
    for (const match of command.matchAll(/(?:^|\s)(scripts\/[A-Za-z0-9._/-]+\.(?:m?js|cjs))\b/g)) {
      try { assert.ok(lstatSync(path.join(root, match[1])).isFile()) } catch { missing.push(`${name}: ${match[1]}`) }
    }
    for (const match of command.matchAll(/\bnpm\s+run\s+([\w:-]+)/g)) {
      if (!Object.hasOwn(manifest.scripts, match[1])) missing.push(`${name}: npm run ${match[1]}`)
    }
  }
  assert.deepEqual(missing, [], 'every declared npm command must refer to an existing task or script')
})

test('a named offline behavioral test actually executes nonzero cases', () => {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/identity.test.js'], {
    cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 30000,
  })
  assert.equal(result.error, undefined, String(result.error))
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /^# tests [1-9]\d*$/m)
  assert.match(result.stdout, /^# pass [1-9]\d*$/m)
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) assert.match(result.stdout, new RegExp(`^# ${key} 0$`, 'm'))
})

test('release check refuses a zero-test suite in an offline package fixture', () => withOfflineNpm(env => {
  const dir = fixture(env)
  writeFileSync(path.join(dir, 'test', 'empty.test.js'), '')
  const result = runFixture(dir, env)
  const output = result.stdout + result.stderr
  assert.notEqual(result.status, 0, output)
  assert.match(output, /zero (?:executed passing )?tests/i)
}))

test('release check rejects a skipped test even when another test ran and no TODO exists', () => withOfflineNpm(env => {
  const dir = fixture(env)
  writeFileSync(path.join(dir, 'test', 'skipped.test.js'), `import test from 'node:test'\ntest('executed', () => {})\ntest.skip('unverified', () => {})\n`)
  const result = runFixture(dir, env)
  const output = result.stdout + result.stderr
  assert.notEqual(result.status, 0, output)
  assert.match(output, /skipped=1/)
  assert.match(output, /TODO=0/)
}))

test('release check rejects TODO even when another test ran and no test is skipped', () => withOfflineNpm(env => {
  const dir = fixture(env)
  writeFileSync(path.join(dir, 'test', 'todo.test.js'), `import test from 'node:test'\ntest('executed', () => {})\ntest.todo('not implemented', () => {})\n`)
  const result = runFixture(dir, env)
  const output = result.stdout + result.stderr
  assert.notEqual(result.status, 0, output)
  assert.match(output, /skipped=0/)
  assert.match(output, /TODO=1/)
}))

test('release check treats TODO and skipped tests as unfinished, not passing release evidence', () => withOfflineNpm(env => {
  const dir = fixture(env)
  writeFileSync(path.join(dir, 'test', 'unfinished.test.js'), `import test from 'node:test'\ntest('executed', () => {})\ntest.skip('unverified', () => {})\ntest.todo('not implemented', () => {})\n`)
  const result = runFixture(dir, env)
  const output = result.stdout + result.stderr
  assert.notEqual(result.status, 0, output)
  assert.match(output, /skipped=1/)
  assert.match(output, /TODO=1/)
}))

test('release check rejects a nonexistent declared npm script', () => withOfflineNpm(env => {
  const dir = fixture(env)
  const pkgPath = path.join(dir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.scripts.bad = 'node scripts/absent.mjs'
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
  writeFileSync(path.join(dir, 'test', 'passes.test.js'), `import test from 'node:test'\ntest('executed', () => {})\n`)
  const result = runFixture(dir, env)
  const output = result.stdout + result.stderr
  assert.notEqual(result.status, 0, output)
  assert.match(output, /manifest\/resources:.*absent\.mjs/i)
}))

test('release check rejects invalid JavaScript in a packed module', () => withOfflineNpm(env => {
  const dir = fixture(env)
  writeFileSync(path.join(dir, 'test', 'passes.test.js'), `import test from 'node:test'\ntest('executed', () => {})\n`)
  writeFileSync(path.join(dir, 'lib', 'client.js'), 'const = broken')
  const result = runFixture(dir, env)
  const output = result.stdout + result.stderr
  assert.notEqual(result.status, 0, output)
  assert.match(output, /syntax lib\/client\.js.*did not complete successfully/i)
}))

test('release check rejects a package omitting a required locale', () => withOfflineNpm(env => {
  const dir = fixture(env)
  const pkgPath = path.join(dir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.files = pkg.files.filter(entry => entry !== 'locale')
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
  writeFileSync(path.join(dir, 'test', 'passes.test.js'), `import test from 'node:test'\ntest('executed', () => {})\n`)
  const result = runFixture(dir, env)
  const output = result.stdout + result.stderr
  assert.notEqual(result.status, 0, output)
  assert.match(output, /packed tree: missing packed file locale\/(?:en|zh)\.json/i)
}))

test('a syntactically valid client still cannot bypass unfinished authority or isolated lifecycle', () => withOfflineNpm(env => {
  const dir = fixture(env)
  writeFileSync(path.join(dir, 'test', 'passes.test.js'), `import test from 'node:test'\ntest('executed', () => {})\n`)
  const result = runFixture(dir, env)
  const output = result.stdout + result.stderr
  assert.notEqual(result.status, 0, output)
  assert.match(output, /T40 metadata authority unavailable/i)
  assert.match(output, /T49 real DSH.*INCONCLUSIVE/i)
}))

test('the locally packed tarball contains executable named behavioral tests', () => withOfflineNpm(env => {
  const owned = env.DSH_PACKAGE_FIXTURE_ROOT
  const result = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', owned], {
    cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  })
  assert.equal(result.error, undefined, String(result.error))
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const reports = JSON.parse(result.stdout)
  assert.equal(reports.length, 1)
  assert.equal(reports[0].name, 'dsh-model-metadata-sync')
  const archiveName = reports[0].filename
  assert.match(archiveName, /^dsh-model-metadata-sync-[A-Za-z0-9.+-]+\.tgz$/)
  const archive = path.join(owned, archiveName)
  assert.equal(lstatSync(archive).isFile(), true)
  assert.equal(path.dirname(realpathSync(archive)), owned)
  const listing = spawnSync('tar', ['-tzf', archive], { cwd: owned, env, encoding: 'utf8', timeout: 30000 })
  assert.equal(listing.error, undefined, String(listing.error))
  assert.equal(listing.status, 0, listing.stderr)
  const entries = listing.stdout.trim().split('\n')
  assert.ok(entries.length > 0)
  for (const entry of entries) {
    assert.ok(entry.startsWith('package/'), `archive outside package root: ${entry}`)
    assertSafePath(entry.slice('package/'.length))
  }
  assert.ok(entries.includes('package/test/identity.test.js'))
  const extraction = spawnSync('tar', ['-xzf', archive, '-C', owned], { cwd: owned, env, encoding: 'utf8', timeout: 30000 })
  assert.equal(extraction.error, undefined, String(extraction.error))
  assert.equal(extraction.status, 0, extraction.stderr)
  const packedRoot = realpathSync(path.join(owned, 'package'))
  assert.equal(path.dirname(packedRoot), owned)
  const verified = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/identity.test.js'], {
    cwd: packedRoot, env, encoding: 'utf8', timeout: 30000,
  })
  assert.equal(verified.error, undefined, String(verified.error))
  assert.equal(verified.status, 0, verified.stdout + verified.stderr)
  assert.match(verified.stdout, /^# tests [1-9]\d*$/m)
  assert.match(verified.stdout, /^# pass [1-9]\d*$/m)
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) assert.match(verified.stdout, new RegExp(`^# ${key} 0$`, 'm'))
}))

test('offline npm pack contains the independent DSH bundle and only safe paths', () => withOfflineNpm(env => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  })
  assert.equal(result.error, undefined, String(result.error))
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const reports = JSON.parse(result.stdout)
  assert.equal(reports.length, 1)
  assert.equal(reports[0].name, 'dsh-model-metadata-sync')
  const files = reports[0].files.map(file => file.path)
  assert.equal(new Set(files).size, files.length)
  for (const name of files) assertSafePath(name)
  for (const name of [
    'package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/index.d.ts', 'lib/client.js', 'lib/client.d.ts',
    'README.md', 'README.zh.md', 'README.ru.md', 'LICENSE', 'icon.svg', 'locale/en.json', 'locale/zh.json',
    'scripts/check.mjs', 'test/identity.test.js', 'test/package.test.js',
  ]) assert.ok(files.includes(name), `packed file missing: ${name}`)
  assert.equal(manifest.name, 'dsh-model-metadata-sync')
  assert.equal(manifest.main, './lib/index.js')
  assert.equal(manifest.exports['./client'].default, './lib/client.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  for (const name of files.filter(file => /\.(?:cjs|mjs|js)$/.test(file))) {
    const target = path.join(root, name)
    assert.equal(lstatSync(target).isFile(), true, `packed path must be a regular file: ${name}`)
    assert.ok(realpathSync(target).startsWith(`${realpathSync(root)}${path.sep}`), `packed path escapes package: ${name}`)
    const checked = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8', timeout: 10000 })
    assert.equal(checked.status, 0, `invalid JavaScript ${name}: ${checked.stderr}`)
  }
}))
