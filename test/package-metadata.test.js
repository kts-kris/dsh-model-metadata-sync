import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)

test('bundle artwork is a self-contained, size-bounded SVG', async () => {
  const bytes = await readFile(new URL('icon.svg', root))
  const svg = bytes.toString('utf8')
  assert.ok(bytes.length > 0 && bytes.length <= 256 * 1024)
  assert.match(svg, /<svg\b[^>]*xmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/)
  assert.match(svg, /\bviewBox=["']0 0 36 36["']/)
  assert.match(svg, /<\/svg>\s*$/)
  assert.doesNotMatch(svg, /<(?:script|style|image|foreignObject|text|animate)\b|\bon\w+\s*=|(?:href|url)\s*=/i)
})

test('DSH package consumers can resolve icon and localized metadata exports', async () => {
  const require = createRequire(import.meta.url)
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  assert.equal(manifest.name, 'dsh-model-metadata-sync')
  assert.ok(manifest.icon === './icon.svg' || manifest.exports?.['./icon'] === './icon.svg')
  assert.equal(manifest.exports?.['./locale/*.json'], './locale/*.json')
  assert.ok(manifest.files?.some(entry => ['icon.svg', '*'].includes(entry)))
  assert.ok(manifest.files?.some(entry => ['locale', 'locale/', 'locale/*', 'locale/*.json', '*'].includes(entry)))
  assert.equal(require.resolve(`${manifest.name}/locale/en.json`), fileURLToPath(new URL('locale/en.json', root)))
  assert.equal(require.resolve(`${manifest.name}/locale/zh.json`), fileURLToPath(new URL('locale/zh.json', root)))
})

test('reference documentation treats future retrieval times as unknown', async () => {
  const cases = [
    ['README.md', /future (?:retrieval )?timestamps?[^.]*unknown/i],
    ['README.zh.md', /未来.{0,20}检索时间.{0,20}未知/],
    ['README.ru.md', /время получения в будущем[^.]*неизвест/i],
  ]
  for (const [path, rule] of cases) {
    assert.match(await readFile(new URL(path, root), 'utf8'), rule, path)
  }
})

test('English and Chinese plugin metadata are usable and accurately marked unfinished', async () => {
  for (const language of ['en', 'zh']) {
    const json = await readFile(new URL(`locale/${language}.json`, root), 'utf8')
    const { meta } = JSON.parse(json)
    assert.equal(typeof meta?.title, 'string')
    assert.ok(meta.title.trim())
    assert.equal(typeof meta?.description, 'string')
    assert.ok(meta.description.trim())
    assert.equal(meta.detail, undefined, 'README is the fallback detail document')
    assert.match(meta.description, language === 'en' ? /not (?:yet )?available/i : /尚未(?:实现|可用)/)
  }
})
