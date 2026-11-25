import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { createModelSyncApiClient } from '../lib/client/api.js'

function shippedClient(react = { createElement() {} }) {
  let registration
  const window = { __ModuleLoader__: { load(value) { registration = value } } }
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), { window })
  return { registration, exports: registration.factory(() => react) }
}

function applicablePreview(source) {
  return {
    provider: 'p', previewId: 'id', digest: 'digest', revision: 1, expiresAt: '2030-01-01T00:00:00Z', selectedNewIds: [], writeEnabled: true,
    items: [{ modelId: 'existing', existing: true, fields: [{ field: 'maxTokens', state: 'applicable', before: null, candidate: 1000, source }] }],
    changes: [{ type: 'set-field', modelId: 'existing', scope: 'models', index: 0, field: 'maxTokens', value: 1000 }], warnings: [],
  }
}

// Render the registered shipped component using the real controller and a fake
// React renderer; Host HTTP and clock are the only external boundaries below.
function renderPage(controller, locale = 'en') {
  const h = (type, props, ...children) => ({ type, props: props || {}, children })
  const react = {
    createElement: h,
    useState: initial => [typeof initial === 'function' ? controller : controller.snapshot(), () => {}],
    useEffect() {},
  }
  const { exports: client } = shippedClient(react)
  let Page
  client.apply({ effect() {}, slots: { inject(name, callback) { callback() }, register(options, component) { Page = component } } })
  const resolve = node => {
    if (Array.isArray(node)) return node.map(resolve)
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') return resolve(node.type(node.props))
    return { ...node, children: node.children.map(resolve) }
  }
  const tree = resolve(Page({ t: key => client.dictionaries[locale][key] || key }))
  const nodes = []
  const collect = node => {
    if (Array.isArray(node)) return node.forEach(collect)
    if (!node || typeof node !== 'object') return
    nodes.push(node)
    node.children.forEach(collect)
  }
  collect(tree)
  const visible = node => {
    if (Array.isArray(node)) return node.map(visible).join('')
    if (node == null || typeof node === 'boolean') return ''
    return typeof node === 'object' ? node.children.map(visible).join('') : String(node)
  }
  return { nodes, text: visible(tree), visible }
}

// Only a fake same-process HTTP boundary is used; no server/profile/network.
test('status uses only the independently named fork endpoint', async () => {
  const requests = []
  const api = createModelSyncApiClient({ fetchImpl: async (url, init) => {
    requests.push([url, init?.method ?? 'GET'])
    return { ok: true, status: 200, text: async () => '{"providers":[],"referenceEnabled":false}' }
  } })
  assert.deepEqual(await api.getStatus(), { providers: [], referenceEnabled: false })
  assert.deepEqual(requests, [['/dsh-model-metadata-sync/status', 'GET']])
})

test('manual operations have the exact contract bodies and no retired routes', async () => {
  const requests = []
  const api = createModelSyncApiClient({ fetchImpl: async (url, init) => {
    requests.push([url, init.method, init.body && JSON.parse(init.body)])
    return { ok: true, status: 200, text: async () => '{}' }
  } })
  await api.preview('sample', ['new-1'])
  await api.cancel('token')
  await api.apply('token', 'digest')
  await api.setReferenceEnabled(false)
  assert.deepEqual(requests, [
    ['/dsh-model-metadata-sync/preview', 'POST', { provider: 'sample', selectedNewIds: ['new-1'] }],
    ['/dsh-model-metadata-sync/preview/cancel', 'POST', { previewId: 'token' }],
    ['/dsh-model-metadata-sync/apply', 'POST', { previewId: 'token', digest: 'digest' }],
    ['/dsh-model-metadata-sync/reference-settings', 'POST', { enabled: false }],
  ])
  assert.deepEqual(Object.keys(api).sort(), ['apply', 'cancel', 'getStatus', 'preview', 'setReferenceEnabled'])
})

test('shipped client registers under the fork module identity and bundle row seat', () => {
  const { registration, exports: client } = shippedClient()
  assert.equal(registration.id, 'dsh-model-metadata-sync')
  const registrations = []
  const disposers = []
  const ctx = {
    locale: { register: () => () => {} },
    effect: (fn) => disposers.push(fn()),
    slots: {
      inject: (name, install) => { disposers.push(install()) },
      register: (options, component) => { registrations.push([options, component]); return () => {} },
    },
  }
  client.apply(ctx)
  assert.ok(registrations.some(([options]) => options.name === 'plugins.row.config' && options.key === 'dsh-model-metadata-sync#dsh-model-metadata-sync'))
  assert.ok(registrations.every(([options]) => options.name !== 'plugins.item'))
  disposers.forEach(dispose => typeof dispose === 'function' && dispose())
})

test('presentation keeps hostile IDs as text and shows each exact field and source', () => {
  const { exports: client } = shippedClient()
  const hostile = '<img src=x onerror=alert(1)>'
  const preview = client.presentPreview({
    provider: 'sample', previewId: 'p', digest: 'd', revision: 4, expiresAt: '2026-11-25T03:05:00Z', selectedNewIds: [hostile], writeEnabled: true,
    items: [{ modelId: hostile, existing: false, reason: 'selected', fields: [
      { field: 'contextWindow', state: 'conflict', reason: 'explicit-value', before: 32000, candidate: 64000, source: { kind: 'reference', origin: 'https://models.dev/api.json', fetchedAt: '2026-11-25T03:00:00Z' } },
      { field: 'reasoningEfforts', state: 'applicable', before: null, candidate: { off: null, low: 'quick', high: 'deep' }, source: { kind: 'upstream', fetchedAt: '2026-11-25T03:00:00Z' } },
      { field: 'maxTokens', state: 'unknown', reason: 'candidate-unknown' },
    ] }],
    changes: [{ type: 'add-model', modelId: hostile }, { type: 'set-field', modelId: hostile, scope: 'models', index: 1, field: 'reasoningEfforts', value: { off: null, low: 'quick', high: 'deep' } }], warnings: [],
  })
  assert.equal(preview.items[0].modelId, hostile)
  assert.equal(preview.items[0].fields[0].before, '32000')
  assert.equal(preview.items[0].fields[0].candidate, '64000')
  assert.equal(preview.items[0].fields[0].state, 'conflict')
  assert.equal(preview.items[0].fields[0].source.kind, 'reference')
  assert.equal(preview.items[0].fields[0].source.origin, 'https://models.dev/api.json')
  assert.equal(preview.items[0].fields.find(field => field.field === 'reasoningEfforts').after, '{"off":null,"low":"quick","high":"deep"}')
  assert.equal(preview.items[0].fields.find(field => field.field === 'maxTokens').state, 'unknown')
  assert.equal(preview.changes[0].modelId, hostile)
  assert.equal(preview.canReview, true)
})

test('an explicitly read-only preview cannot enable confirmation', () => {
  const { exports: client } = shippedClient()
  const source = { kind: 'upstream', fetchedAt: '2026-11-25T03:00:00Z' }
  const preview = { ...applicablePreview(source), authority: 'unavailable', writeEnabled: false }
  assert.equal(client.presentPreview(preview).canReview, false)
})

test('unknown inherited catalog identities remain visible but cannot be selected', async () => {
  const { exports: client } = shippedClient()
  const raw = { ...applicablePreview({ kind: 'upstream', fetchedAt: '2026-11-25T03:00:00Z' }),
    authority: 'unavailable', writeEnabled: false,
    items: [{ modelId: 'unresolved-model', existing: null, reason: 'inventory-unknown', fields: [] }],
    changes: [], selectedNewIds: [] }
  const projected = client.presentPreview(raw)
  assert.equal(projected.items[0].modelId, 'unresolved-model')
  assert.equal(projected.items[0].existing, null)
  assert.equal(projected.canReview, false)
  const controller = client.createController({
    getStatus: async () => ({ providers: [{ id: 'p', status: 'unknown', lastAttemptAt: null }], referenceEnabled: true }),
    preview: async () => raw,
  }, () => {}, () => Date.parse('2026-11-25T03:00:00Z'))
  await controller.loadStatus(); controller.chooseProvider('p'); await controller.preview()
  controller.selectNew('unresolved-model', true)
  assert.deepEqual(Array.from(controller.snapshot().selected), [])
})

test('a changed field requires its exact source class and a canonical valid UTC retrieval time', () => {
  const { exports: client } = shippedClient()
  const validSources = [
    { kind: 'upstream', fetchedAt: '2026-11-25T03:00:00Z' },
    { kind: 'upstream', fetchedAt: '2026-11-25T03:00:00.123Z' },
    { kind: 'reference', origin: 'https://models.dev/api.json', fetchedAt: '2026-11-25T03:00:00Z' },
  ]
  for (const source of validSources) {
    const preview = client.presentPreview(applicablePreview(source))
    assert.equal(preview.canReview, true, JSON.stringify(source))
    assert.equal(preview.items[0].fields.find(field => field.field === 'maxTokens').source.kind, source.kind)
  }
  for (const source of [undefined, null, {}, { kind: 'unknown', fetchedAt: '2026-11-25T03:00:00Z' },
    { kind: 'upstream' }, { kind: 'upstream', fetchedAt: '2026-02-30T03:00:00Z' },
    { kind: 'upstream', fetchedAt: '2026-11-25T03:00:00+00:00' },
    { kind: 'upstream', fetchedAt: '2026-11-25T03:00:00.12Z' },
    { kind: 'reference', fetchedAt: '2026-11-25T03:00:00Z' },
    { kind: 'reference', origin: 'https://models.dev/api.json?x=1', fetchedAt: '2026-11-25T03:00:00Z' },
    { kind: 'reference', origin: 'https://models.dev/api.json', fetchedAt: 'not-a-time' },
  ]) assert.equal(client.presentPreview(applicablePreview(source)).canReview, false, JSON.stringify(source))
})

test('dangerous Unicode format controls cannot authorize a preview and appear escaped in the actual UI', async () => {
  const dangerous = '\u202e'
  const upstream = { kind: 'upstream', fetchedAt: '2026-11-25T03:00:00Z' }
  const base = () => applicablePreview(upstream)
  const mutations = [
    preview => { preview.provider += dangerous },
    preview => { preview.items[0].modelId += dangerous; preview.changes[0].modelId += dangerous },
    preview => { preview.warnings = ['look' + dangerous + 'out'] },
    preview => { preview.sources = { upstream: { kind: 'upstream', reason: 'look' + dangerous + 'out' } } },
    preview => { preview.items[0].fields[0].reason = 'look' + dangerous + 'out' },
    preview => {
      preview.items[0].fields[0].field = 'reasoningEfforts'
      preview.items[0].fields[0].candidate = { high: 'wire' + dangerous }
      preview.changes[0].field = 'reasoningEfforts'
      preview.changes[0].value = { high: 'wire' + dangerous }
    },
  ]
  const { exports: client } = shippedClient()
  for (const mutate of mutations) {
    const preview = base(); mutate(preview)
    assert.equal(client.presentPreview(preview).canReview, false)
  }
  for (const code of [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
    const preview = base(); preview.warnings = ['warning' + String.fromCodePoint(code)]
    assert.equal(client.presentPreview(preview).canReview, false, `U+${code.toString(16)}`)
  }

  // Render the registered component tree, not a duplicate of its presentation rules.
  let renderState
  const h = (type, props, ...children) => ({ type, props: props || {}, children })
  const react = { createElement: h, useState: initial => [typeof initial === 'function' ? initial() : (renderState ?? initial), () => {}], useEffect() {} }
  const shipped = shippedClient(react)
  let Page
  shipped.exports.apply({ effect() {}, slots: { inject(name, callback) { callback() }, register(options, component) { Page = component } } })
  const preview = base()
  mutations[1](preview); mutations[2](preview); mutations[5](preview)
  const api = shipped.exports.createModelSyncApiClient({ fetchImpl: async url => ({ ok: true, status: 200, text: async () => JSON.stringify(
    url.endsWith('/status') ? { providers: [{ id: 'p' }], referenceEnabled: true } : preview) }) })
  const controller = shipped.exports.createController(api, () => {}, () => Date.parse('2026-11-25T03:00:00Z'))
  await controller.loadStatus(); controller.chooseProvider('p'); await controller.preview()
  renderState = controller.snapshot()
  const walk = node => {
    if (node == null || typeof node === 'boolean') return ''
    if (Array.isArray(node)) return node.map(walk).join('')
    if (typeof node !== 'object') return String(node)
    if (typeof node.type === 'function') return walk(node.type(node.props))
    return node.children.map(walk).join('')
  }
  const visible = walk(Page({}))
  assert.equal(visible.includes(dangerous), false)
  assert.match(visible, /\\u202e/i)
})

test('an unselected model containing ZWJ is visibly escaped without blocking an unrelated review', async () => {
  const { exports: client } = shippedClient()
  const requests = []
  const id = 'new\u200dmodel'
  const literalEscapeId = 'new\\u200dmodel'
  const preview = applicablePreview({ kind: 'upstream', fetchedAt: '2026-11-25T03:00:00Z' })
  preview.items.push({ modelId: id, existing: false, reason: 'not-selected', fields: [] })
  preview.items.push({ modelId: literalEscapeId, existing: false, reason: 'not-selected', fields: [] })
  const api = client.createModelSyncApiClient({ fetchImpl: async (url, init) => {
    requests.push({ url, body: init.body && JSON.parse(init.body) })
    const data = url.endsWith('/status') ? { providers: [{ id: 'p' }], referenceEnabled: true }
      : url.endsWith('/preview') ? preview : { status: 'applied' }
    return { ok: true, status: 200, text: async () => JSON.stringify(data) }
  } })
  const controller = client.createController(api, () => {}, () => Date.parse('2026-11-25T03:00:00Z'))
  await controller.loadStatus(); controller.chooseProvider('p'); await controller.preview()
  assert.equal(controller.snapshot().preview.items[1].modelId, id)
  assert.equal(controller.snapshot().preview.canReview, true, 'an unrelated discovery must not veto the diff')
  const rendered = renderPage(controller)
  const modelLabels = rendered.nodes.filter(node => node.type === 'strong').map(rendered.visible)
  assert.equal(modelLabels.includes('new\\u200dmodel'), true, 'ZWJ is explicitly escaped on screen')
  assert.equal(modelLabels.includes('new\\\\u200dmodel'), true, 'a literal backslash is distinguishable from an escaped ZWJ')
  assert.equal(rendered.text.includes(id), false, 'the invisible raw ZWJ never appears in displayed text')
  const review = rendered.nodes.find(node => node.type === 'button' && rendered.visible(node) === 'Review confirmation')
  assert.equal(review.props.disabled, false)
  review.props.onClick()
  assert.equal(controller.snapshot().confirming, true)
  await controller.confirmApply()
  assert.deepEqual(requests.at(-1), { url: '/dsh-model-metadata-sync/apply', body: { previewId: 'id', digest: 'digest' } })
})

test('selected ZWJ model and reasoning wire values remain exact while shown escaped', async () => {
  const { exports: client } = shippedClient()
  const calls = []
  const id = 'new\u200dmodel'
  const wire = 'wire\u200dhigh'
  const source = { kind: 'upstream', fetchedAt: '2026-11-25T03:00:00Z' }
  const api = client.createModelSyncApiClient({ fetchImpl: async (url, init) => {
    const body = init.body && JSON.parse(init.body)
    calls.push({ url, body })
    const data = url.endsWith('/status') ? { providers: [{ id: 'p' }], referenceEnabled: true }
      : url.endsWith('/preview') ? {
        ...applicablePreview(source), selectedNewIds: body.selectedNewIds,
        items: [{ modelId: id, existing: false, reason: body.selectedNewIds.length ? 'selected' : 'not-selected', fields: body.selectedNewIds.length
          ? [{ field: 'reasoningEfforts', state: 'applicable', before: null, candidate: { high: wire }, source }] : [] }],
        changes: body.selectedNewIds.length ? [{ type: 'add-model', modelId: id },
          { type: 'set-field', modelId: id, field: 'reasoningEfforts', scope: 'models', index: 1, value: { high: wire } }] : [],
      } : { status: 'applied' }
    return { ok: true, status: 200, text: async () => JSON.stringify(data) }
  } })
  const controller = client.createController(api, () => {}, () => Date.parse('2026-11-25T03:00:00Z'))
  await controller.loadStatus(); controller.chooseProvider('p'); await controller.preview()
  const initial = renderPage(controller)
  const checkbox = initial.nodes.find(node => node.type === 'input' && node.props.type === 'checkbox' && node.props.onChange && node.props.checked === false && !node.props.disabled)
  checkbox.props.onChange({ target: { checked: true } })
  await controller.preview()
  assert.deepEqual(calls.at(-1).body, { provider: 'p', selectedNewIds: [id] }, 'selection request uses raw ID, never a display escape')
  assert.equal(controller.snapshot().preview.canReview, true)
  assert.equal(controller.snapshot().preview.items[0].modelId, id)
  assert.equal(controller.snapshot().preview.changes[0].modelId, id)
  assert.equal(JSON.parse(controller.snapshot().preview.changes[1].value).high, wire)
  const page = renderPage(controller)
  assert.match(page.text, /new\\u200dmodel/)
  assert.match(page.text, /wire\\u200dhigh/)
  assert.equal(page.text.includes(id), false)
  assert.equal(page.text.includes(wire), false)
  controller.review()
  assert.equal(controller.snapshot().confirming, true)
  const confirmation = renderPage(controller)
  assert.match(confirmation.text, /new\\u200dmodel/)
  await controller.confirmApply()
  assert.deepEqual(calls.at(-1), { url: '/dsh-model-metadata-sync/apply', body: { previewId: 'id', digest: 'digest' } })
})

test('expired review or confirm shows localized stale feedback and never sends apply', async () => {
  for (const stage of ['review', 'confirm']) {
    const { exports: client } = shippedClient()
    let now = Date.parse('2026-11-25T03:00:00Z')
    const calls = []
    const preview = { ...applicablePreview({ kind: 'upstream', fetchedAt: '2026-11-25T03:00:00Z' }), expiresAt: '2026-11-25T03:01:00Z' }
    const api = client.createModelSyncApiClient({ fetchImpl: async (url, init) => {
      calls.push(url)
      const data = url.endsWith('/status') ? { providers: [{ id: 'p' }], referenceEnabled: true } : preview
      return { ok: true, status: 200, text: async () => JSON.stringify(data) }
    } })
    const controller = client.createController(api, () => {}, () => now)
    await controller.loadStatus(); controller.chooseProvider('p'); await controller.preview()
    if (stage === 'confirm') { controller.review(); assert.equal(controller.snapshot().confirming, true) }
    now = Date.parse('2026-11-25T03:01:00Z')
    const beforeClick = renderPage(controller)
    const action = beforeClick.nodes.find(node => node.type === 'button' && beforeClick.visible(node) === (stage === 'review' ? 'Review confirmation' : 'Confirm and apply'))
    assert.equal(action.props.disabled, false)
    await action.props.onClick()
    assert.equal(controller.snapshot().stale, true, `${stage} visibly marks the expired preview stale`)
    assert.equal(controller.snapshot().confirming, false)
    assert.match(renderPage(controller).text, /expired.*(?:preview|again)/i)
    assert.match(renderPage(controller, 'zh').text, /过期.*重新预览/)
    assert.equal(calls.some(url => url.endsWith('/apply')), false)
  }
})

test('malformed lone-surrogate provider, model ID or wire cannot be reviewed or applied', async () => {
  for (const malformed of ['\ud800', '\udc00']) for (const target of ['provider', 'model', 'wire']) {
    const { exports: client } = shippedClient()
    const calls = []
    const preview = applicablePreview({ kind: 'upstream', fetchedAt: '2026-11-25T03:00:00Z' })
    if (target === 'provider') preview.provider += malformed
    if (target === 'model') { preview.items[0].modelId += malformed; preview.changes[0].modelId += malformed }
    if (target === 'wire') {
      preview.items[0].fields[0].field = 'reasoningEfforts'
      preview.items[0].fields[0].candidate = { high: 'wire' + malformed }
      preview.changes[0].field = 'reasoningEfforts'; preview.changes[0].value = { high: 'wire' + malformed }
    }
    const api = client.createModelSyncApiClient({ fetchImpl: async url => {
      calls.push(url)
      const data = url.endsWith('/status') ? { providers: [{ id: preview.provider }], referenceEnabled: true } : preview
      return { ok: true, status: 200, text: async () => JSON.stringify(data) }
    } })
    const controller = client.createController(api, () => {}, () => Date.parse('2026-11-25T03:00:00Z'))
    await controller.loadStatus(); controller.chooseProvider(preview.provider); await controller.preview()
    assert.equal(controller.snapshot().preview.canReview, false, `${target} ${JSON.stringify(malformed)} must fail closed`)
    const page = renderPage(controller)
    assert.equal(page.text.includes(malformed), false)
    assert.equal(page.nodes.find(node => node.type === 'button' && page.visible(node) === 'Review confirmation').props.disabled, true)
    controller.review(); await controller.confirmApply()
    assert.equal(controller.snapshot().confirming, false)
    assert.equal(calls.some(url => url.endsWith('/apply')), false)
  }
})

test('unreviewable or incomplete preview cannot proceed to confirmation', () => {
  const { exports: client } = shippedClient()
  const minimal = { provider: 'p', previewId: 'id', digest: 'digest', revision: 1, expiresAt: '2030-01-01T00:00:00Z', items: [], selectedNewIds: [] }
  assert.equal(client.presentPreview(minimal).canReview, false)
  assert.equal(client.presentPreview({ ...minimal, changes: [] }).canReview, false)
  assert.equal(client.presentPreview({ ...minimal, changes: [{ type: 'surprise', modelId: 'm' }] }).canReview, false)
})

test('shipped client never loads or writes until explicit actions and confirms the exact reviewed preview', async () => {
  const { exports: client } = shippedClient()
  const calls = []
  const api = client.createModelSyncApiClient({ fetchImpl: async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ url, method: init.method, body })
    const response = url.endsWith('/status') ? { providers: [{ id: 'provider-a', status: 'success', lastAttemptAt: '2026-11-25T03:00:00Z' }], referenceEnabled: true }
      : url.endsWith('/preview') ? {
        provider: 'provider-a', previewId: 'preview-token', digest: 'diff-digest', revision: 1, expiresAt: '2030-01-01T00:00:00Z', writeEnabled: true,
        selectedNewIds: body.selectedNewIds, items: [{ modelId: 'm', existing: false, reason: body.selectedNewIds.length ? 'selected' : 'not-selected', fields: [] }],
        changes: body.selectedNewIds.map(modelId => ({ type: 'add-model', modelId })), warnings: [],
      } : url.endsWith('/apply') ? { status: 'applied' } : { referenceEnabled: false }
    return { ok: true, status: 200, text: async () => JSON.stringify(response) }
  } })
  const model = client.createController(api, () => {}, () => Date.parse('2026-11-25T03:00:00Z'))
  assert.deepEqual(calls, [])
  await model.confirmApply()
  assert.deepEqual(calls, [])
  await model.loadStatus()
  model.chooseProvider('provider-a')
  await model.preview()
  model.selectNew('m', true)
  model.review()
  await model.confirmApply()
  assert.equal(calls.length, 2, 'selection changes cannot apply an old preview')
  await model.preview()
  await model.confirmApply()
  assert.equal(calls.length, 3, 'preview alone is not confirmation')
  model.review()
  assert.equal(model.snapshot().confirming, true)
  await model.confirmApply()
  assert.deepEqual(calls[3], { url: '/dsh-model-metadata-sync/apply', method: 'POST', body: { previewId: 'preview-token', digest: 'diff-digest' } })
  await model.confirmApply()
  assert.equal(calls.length, 4, 'preview must not be reused')
})

test('inherited additions cannot be selected and preference changes invalidate consent', async () => {
  const { exports: client } = shippedClient()
  const calls = []
  const api = client.createModelSyncApiClient({ fetchImpl: async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push([url, body])
    const data = url.endsWith('/status') ? { providers: [{ id: 'p', status: 'ok' }], referenceEnabled: true }
      : url.endsWith('/reference-settings') ? { referenceEnabled: body.enabled }
      : { provider: 'p', previewId: 'id', digest: 'digest', revision: 3, expiresAt: '2030-01-01T00:00:00Z', selectedNewIds: [], writeEnabled: true,
        items: [{ modelId: 'inherited-new', existing: false, reason: 'inherited-add-unsupported' }], changes: [], warnings: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(data) }
  } })
  const state = client.createController(api, () => {}, () => Date.parse('2026-11-25T03:00:00Z'))
  await state.loadStatus(); state.chooseProvider('p'); await state.preview()
  state.selectNew('inherited-new', true)
  assert.equal(state.snapshot().selected.length, 0)
  state.review(); await state.confirmApply()
  assert.equal(calls.length, 2)
  state.chooseReference(false); await state.saveReference()
  assert.equal(state.snapshot().status.referenceEnabled, false)
  assert.equal(state.snapshot().preview, null)
  assert.deepEqual(calls[2], ['/dsh-model-metadata-sync/reference-settings', { enabled: false }])
})

test('changing reference draft immediately revokes review until save succeeds and a fresh preview is obtained', async () => {
  const { exports: client } = shippedClient()
  const calls = []
  let saves = 0
  const api = client.createModelSyncApiClient({ fetchImpl: async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push([url, body])
    if (url.endsWith('/reference-settings') && ++saves === 1) return { ok: false, status: 503, text: async () => '{}' }
    const result = url.endsWith('/status') ? { providers: [{ id: 'p' }], referenceEnabled: true }
      : url.endsWith('/reference-settings') ? { referenceEnabled: body.enabled }
      : url.endsWith('/apply') ? { status: 'applied' }
      : applicablePreview({ kind: 'upstream', fetchedAt: '2026-11-25T03:00:00Z' })
    return { ok: true, status: 200, text: async () => JSON.stringify(result) }
  } })
  const controller = client.createController(api, () => {}, () => Date.parse('2026-11-25T03:00:00Z'))
  await controller.loadStatus(); controller.chooseProvider('p'); await controller.preview(); controller.review()
  assert.equal(controller.snapshot().confirming, true)
  controller.chooseReference(false)
  assert.equal(controller.snapshot().confirming, false)
  assert.equal(controller.snapshot().stale, true)
  controller.review(); await controller.confirmApply(); await controller.preview()
  assert.equal(calls.length, 2, 'neither applying nor previewing is allowed while the draft is unsaved')
  controller.chooseReference(true) // Reverting the checkbox is not a successful save.
  await controller.loadStatus(); controller.chooseProvider('p'); await controller.preview()
  assert.equal(calls.length, 3, 'refreshing status must not clear the unsaved draft requirement')
  await controller.saveReference()
  await controller.preview()
  assert.equal(calls.length, 4, 'a failed save cannot authorize a new preview')
  await controller.saveReference()
  await controller.preview(); controller.review()
  assert.equal(controller.snapshot().confirming, true)
  await controller.confirmApply()
  assert.equal(calls.filter(([url]) => url.endsWith('/apply')).length, 1)
})

test('dispose and reactivation isolate old asynchronous completions and allow a new request', async () => {
  const { exports: client } = shippedClient()
  const deferred = () => {
    let resolve
    const promise = new Promise(done => { resolve = done })
    return { promise, resolve }
  }
  const responses = [deferred(), deferred()]
  let calls = 0
  const api = client.createModelSyncApiClient({ fetchImpl: async () => {
    const next = responses[calls++]
    const body = await next.promise
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  } })
  const states = []
  const controller = client.createController(api, state => states.push(state))
  const old = controller.loadStatus()
  assert.equal(controller.snapshot().busy, true)
  controller.dispose(); controller.activate()
  assert.equal(controller.snapshot().busy, false)
  const current = controller.loadStatus()
  const doubleClick = controller.loadStatus()
  assert.equal(calls, 2, 'same-tick requests dispatch only once per activation')
  responses[0].resolve({ providers: [{ id: 'old' }], referenceEnabled: false })
  await old
  assert.equal(controller.snapshot().busy, true, 'old finally must not end a newer request')
  assert.equal(controller.snapshot().status, null, 'late data must not overwrite the reactivated instance')
  responses[1].resolve({ providers: [{ id: 'new' }], referenceEnabled: true })
  await Promise.all([current, doubleClick])
  assert.equal(controller.snapshot().busy, false)
  assert.equal(controller.snapshot().status.providers[0].id, 'new')
  assert.equal(states.some(state => state.status?.providers.some(row => row.id === 'old')), false)
})

test('a request that settles while disposed cannot keep the reactivated UI busy or inject stale state', async () => {
  const { exports: client } = shippedClient()
  let resolve
  let calls = 0
  const pending = new Promise(done => { resolve = done })
  const api = client.createModelSyncApiClient({ fetchImpl: async () => {
    calls++
    const body = calls === 1 ? await pending : { providers: [{ id: 'fresh' }], referenceEnabled: true }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  } })
  const controller = client.createController(api)
  const old = controller.loadStatus()
  controller.dispose()
  resolve({ providers: [{ id: 'stale' }], referenceEnabled: false })
  await old
  controller.activate()
  assert.equal(controller.snapshot().busy, false)
  assert.equal(controller.snapshot().status, null)
  await controller.loadStatus()
  assert.equal(controller.snapshot().status.providers[0].id, 'fresh')
})

test('cancelling a preview completes and releases busy state', async () => {
  const { exports: client } = shippedClient()
  const api = client.createModelSyncApiClient({ fetchImpl: async url => {
    const result = url.endsWith('/status') ? { providers: [{ id: 'p' }], referenceEnabled: true }
      : url.endsWith('/preview/cancel') ? { status: 'cancelled' }
      : applicablePreview({ kind: 'upstream', fetchedAt: '2026-11-25T03:00:00Z' })
    return { ok: true, status: 200, text: async () => JSON.stringify(result) }
  } })
  const controller = client.createController(api)
  await controller.loadStatus(); controller.chooseProvider('p'); await controller.preview(); await controller.cancelPreview()
  assert.equal(controller.snapshot().busy, false)
  assert.equal(controller.snapshot().preview, null)
})

test('same-tick confirmation cannot send two apply requests', async () => {
  const { exports: client } = shippedClient()
  let applyCalls = 0
  let resolveApply
  const pending = new Promise(done => { resolveApply = done })
  const api = client.createModelSyncApiClient({ fetchImpl: async url => {
    let result
    if (url.endsWith('/status')) result = { providers: [{ id: 'p' }], referenceEnabled: true }
    else if (url.endsWith('/preview')) result = applicablePreview({ kind: 'upstream', fetchedAt: '2026-11-25T03:00:00Z' })
    else { applyCalls++; result = await pending }
    return { ok: true, status: 200, text: async () => JSON.stringify(result) }
  } })
  const controller = client.createController(api, () => {}, () => Date.parse('2026-11-25T03:00:00Z'))
  await controller.loadStatus(); controller.chooseProvider('p'); await controller.preview(); controller.review()
  const first = controller.confirmApply()
  const second = controller.confirmApply()
  assert.equal(applyCalls, 1)
  resolveApply({ status: 'applied' })
  await Promise.all([first, second])
  assert.equal(controller.snapshot().busy, false)
  assert.equal(controller.snapshot().result, 'applied')
})

test('shipped browser artifact and public helpers agree on HTTP contract and locale labels', async () => {
  const { exports: client } = shippedClient()
  const { dictionaries } = await import('../lib/client/locales.js')
  for (const locale of ['en', 'zh']) {
    assert.deepEqual(Object.keys(client.dictionaries[locale]).sort(), Object.keys(dictionaries[locale]).sort(), `${locale}: complete locale keys`)
    for (const [key, value] of Object.entries(dictionaries[locale])) assert.equal(client.dictionaries[locale][key], value, `${locale}.${key}`)
    assert.ok(client.dictionaries[locale].escapeNotice)
    assert.ok(client.dictionaries[locale].expired)
  }
  for (const make of [createModelSyncApiClient, client.createModelSyncApiClient]) {
    const calls = []
    const api = make({ fetchImpl: async (url, init) => {
      calls.push([url, init.method, init.credentials, init.body ? JSON.parse(init.body) : null])
      return { ok: true, status: 200, text: async () => '{}' }
    } })
    await api.getStatus(); await api.preview('p', ['m']); await api.cancel('id'); await api.apply('id', 'digest'); await api.setReferenceEnabled(false)
    assert.deepEqual(calls, [
      ['/dsh-model-metadata-sync/status', 'GET', 'same-origin', null],
      ['/dsh-model-metadata-sync/preview', 'POST', 'same-origin', { provider: 'p', selectedNewIds: ['m'] }],
      ['/dsh-model-metadata-sync/preview/cancel', 'POST', 'same-origin', { previewId: 'id' }],
      ['/dsh-model-metadata-sync/apply', 'POST', 'same-origin', { previewId: 'id', digest: 'digest' }],
      ['/dsh-model-metadata-sync/reference-settings', 'POST', 'same-origin', { enabled: false }],
    ])
  }
})

test('failed status refresh clears the prior preview and confirmation', async () => {
  const { exports: client } = shippedClient()
  let statusLoads = 0
  const api = client.createModelSyncApiClient({ fetchImpl: async url => {
    if (url.endsWith('/status') && ++statusLoads > 1) return { ok: false, status: 503, text: async () => '{}' }
    const result = url.endsWith('/status') ? { providers: [{ id: 'p' }], referenceEnabled: true } : {
      provider: 'p', previewId: 'token', digest: 'digest', revision: 1, expiresAt: '2030-01-01T00:00:00Z', writeEnabled: true, selectedNewIds: [],
      items: [{ modelId: 'existing', existing: true, fields: [{ field: 'maxTokens', state: 'applicable', before: null, candidate: 1000, source: { kind: 'upstream', fetchedAt: '2026-11-25T03:00:00Z' } }] }],
      changes: [{ type: 'set-field', modelId: 'existing', scope: 'models', index: 0, field: 'maxTokens', value: 1000 }], warnings: [],
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(result) }
  } })
  const model = client.createController(api, () => {}, () => Date.parse('2026-11-25T03:00:00Z'))
  await model.loadStatus(); model.chooseProvider('p'); await model.preview(); model.review()
  assert.equal(model.snapshot().confirming, true)
  await model.loadStatus()
  assert.equal(model.snapshot().preview, null)
  assert.equal(model.snapshot().confirming, false)
  assert.equal(model.snapshot().status, null)
})

test('Host admission and unavailable errors remain failures without leaking response text', async () => {
  for (const [status, text] of [[401, 'unauthorized'], [403, 'forbidden'], [503, '{"error":{"code":"AUTHORITY_UNAVAILABLE","message":"secret"}}']]) {
    const api = createModelSyncApiClient({ fetchImpl: async () => ({ ok: false, status, text: async () => text }) })
    await assert.rejects(api.getStatus(), error => {
      assert.doesNotMatch(error.message, /secret|unauthorized|forbidden/i)
      assert.ok(error.message.includes('HTTP') || error.message.includes('authority'))
      return true
    })
  }
})
