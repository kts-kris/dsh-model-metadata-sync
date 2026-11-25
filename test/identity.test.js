import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const readProjectFile = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const readPackage = () => JSON.parse(readProjectFile('package.json'));

// The checked-in patch uses the small, literal YAML subset below. Fail closed
// on any other patch shape instead of silently ignoring an override or a row.
function readSingleInsert() {
  const lines = readProjectFile('cordis.patch.yml').split(/\r?\n/)
    .filter((line) => line.trim() && !line.trimStart().startsWith('#'));
  assert.equal(lines.length, 3, 'patch must contain exactly one insert and one row');
  assert.match(lines[0], /^- insert:\s*$/);
  const id = lines[1].match(/^ {4}- id:\s*(['"]?)([A-Za-z0-9@_./-]+)\1\s*$/);
  const name = lines[2].match(/^ {6}name:\s*(['"]?)([A-Za-z0-9@_./-]+)\1\s*$/);
  assert.ok(id, 'inserted row must have a literal id');
  assert.ok(name, 'inserted row must have a literal package name');
  return { id: id[2], name: name[2] };
}

test('package manifest has a new, independent identity', () => {
  const pkg = readPackage();
  assert.equal(pkg.name, 'dsh-model-metadata-sync');
  assert.notEqual(pkg.name, '@goodandready/dsh-model-sync');
  assert.equal(pkg.version, '0.1.0');
});

test('bundle patch appends only the fork without replacing the original row', () => {
  const pkg = readPackage();
  const inserted = readSingleInsert();
  const original = {
    id: 'dsh-model-sync',
    name: '@goodandready/dsh-model-sync',
    config: { sentinel: 'original settings' },
  };
  // Cordis insert appends entries; the strict parser rejects non-insert edits.
  const composed = [original, inserted];
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.deepEqual(composed, [
    { id: 'dsh-model-sync', name: '@goodandready/dsh-model-sync', config: { sentinel: 'original settings' } },
    { id: 'dsh-model-metadata-sync', name: 'dsh-model-metadata-sync' },
  ]);
  assert.equal(inserted.name, pkg.name);
  assert.notEqual(inserted.id, original.id);
  assert.notEqual(inserted.name, original.name);
});

test('manifest states the intended target DSH range without inherited compatibility claims', () => {
  const pkg = readPackage();
  assert.equal(pkg.engines.dsh, '>=0.2.3-alpha.2 <0.3.0');
  if (pkg.dsh.compatibility) {
    assert.equal(pkg.dsh.compatibility.dsh, '>=0.2.3-alpha.2 <0.3.0');
    for (const release of Object.keys(pkg.dsh.compatibility.dshReleases ?? {})) {
      assert.match(release, /^0\.2\.(?:[3-9]|[1-9]\d+)(?:[-+.]|$)/, `outdated compatibility claim: ${release}`);
    }
  }
});

test('fork metadata points at the intended repository without claiming automatic behavior', () => {
  const pkg = readPackage();
  assert.equal(pkg.repository.type, 'git');
  assert.equal(pkg.repository.url, 'https://github.com/kts-kris/dsh-model-metadata-sync.git');
  assert.equal(pkg.homepage, 'https://github.com/kts-kris/dsh-model-metadata-sync');
  assert.equal(pkg.bugs.url, 'https://github.com/kts-kris/dsh-model-metadata-sync/issues');
  assert.match(pkg.description, /fork/i);
  assert.doesNotMatch(pkg.description, /automatic/i);
});

test('distribution includes the unchanged upstream MIT license and attribution', () => {
  const pkg = readPackage();
  const license = readProjectFile('LICENSE');
  assert.equal(pkg.license, 'MIT');
  assert.ok(pkg.files.includes('LICENSE'));
  assert.match(license, /^MIT License\n\nCopyright \(c\) 2026 GooDAnDReaDY\n/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.equal(
    createHash('sha256').update(license).digest('hex'),
    'dc6f2fbad994189e1e1466c51173363264826fc454f0cfccdafa91a9a41b6365',
    'upstream LICENSE bytes must remain unchanged',
  );
});
