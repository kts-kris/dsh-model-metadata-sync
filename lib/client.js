// Standalone browser artifact. The matching public ESM transport/dictionaries are
// kept at client/api.js and client/locales.js and checked against this artifact.
window.__ModuleLoader__.load({
  id: 'dsh-model-metadata-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-model-metadata-sync'
    const API = '/dsh-model-metadata-sync'
    const dictionaries = {
      en: {
        title: 'Model metadata sync', summary: 'Preview source-attributed model metadata and manually confirm each change.',
        intro: 'Discover metadata for one configured provider. Nothing is applied without a separate confirmation.',
        authority: 'Only selected new IDs can be applied after confirmation. Metadata fields are not yet applied; some sources are display-only.',
        load: 'Load provider status', refresh: 'Refresh provider status', loading: 'Working…', noProviders: 'No providers were returned.',
        provider: 'Provider', chooseProvider: 'Choose a provider', lastAttempt: 'Last attempt (UTC)', status: 'Status', unknown: 'Unknown', none: 'None',
        reference: 'Nonofficial reference lookup', enabled: 'Enabled', disabled: 'Off',
        disclosure: 'If enabled, the nonofficial reference may use provider, model ID and request protocol identifiers. It must never receive upstream credentials or the private upstream URL. Fetch age is not proof that source data is current.',
        changeReference: 'Save reference preference', referenceChoice: 'Allow nonofficial reference lookup', discover: 'Discover and preview', updatePreview: 'Preview selected IDs',
        selectionNote: 'Select new IDs to add, then preview again. Existing models are never removed.', selectedIds: 'Selected new IDs', noSelection: 'No new IDs selected',
        preview: 'Preview', stale: 'Selection changed. Preview again before confirming.', newModel: 'New model', existingModel: 'Existing model', select: 'Select new model',
        inherited: 'Cannot safely add to an inherited catalog.', field: 'Field', before: 'Before / effective', candidate: 'Candidate', after: 'After if applied',
        reason: 'Reason', source: 'Source', sourceKind: 'Source class', fetchedAt: 'Fetched at (UTC)', warning: 'Warning',
        maxWarning: 'Setting maxTokens changes DSH’s default request output limit.', noChanges: 'No applicable changes were reported.', changes: 'Exact proposed changes',
        revision: 'Settings revision', digest: 'Preview digest', expires: 'Expires (UTC)', review: 'Review confirmation', confirmation: 'Confirm this exact preview',
        displayOnly: 'Display-only preview: these proposed changes cannot be applied.',
        confirmExplanation: 'Only this provider, this selection, and the exact displayed diff will be submitted. Confirming is a separate action.',
        confirmApply: 'Confirm and apply', back: 'Back', cancel: 'Cancel preview', applied: 'The Host reported the result', repreview: 'Request a fresh preview before applying.',
        escapeNotice: 'Backslashes and invisible characters are escaped for display; original identities and wire values are preserved. Not all look-alike characters can be identified.',
        expired: 'This preview expired. Request a fresh preview before confirming.',
      },
      zh: {
        title: '模型元数据同步', summary: '预览带来源的模型元数据，并逐次手动确认变更。', intro: '为一个已配置的服务商发现元数据。没有单独确认就不会应用。',
        authority: '仅所选新模型 ID 可在确认后写入；元数据字段尚不能应用，部分来源仅供查看。', load: '加载服务商状态', refresh: '刷新服务商状态', loading: '处理中…',
        noProviders: '未返回服务商。', provider: '服务商', chooseProvider: '选择服务商', lastAttempt: '最近尝试时间（UTC）', status: '状态', unknown: '未知', none: '无',
        reference: '非官方参考数据查询', enabled: '已开启', disabled: '已关闭',
        disclosure: '开启时，非官方参考源可能使用服务商、模型 ID 和请求协议标识；不得接收上游凭据或私有上游地址。获取时间不代表来源数据本身是最新的。',
        changeReference: '保存参考查询偏好', referenceChoice: '允许查询非官方参考数据', discover: '发现并预览', updatePreview: '预览所选 ID',
        selectionNote: '选择要添加的新 ID 后必须再次预览；不会移除现有模型。', selectedIds: '已选择的新 ID', noSelection: '未选择新 ID',
        preview: '预览', stale: '选择已变化，请先重新预览再确认。', newModel: '新模型', existingModel: '现有模型', select: '选择新模型',
        inherited: '无法安全地向继承的目录添加模型。', field: '字段', before: '变更前 / 有效值', candidate: '候选值', after: '应用后的值',
        reason: '原因', source: '来源', sourceKind: '来源类别', fetchedAt: '获取时间（UTC）', warning: '警告',
        maxWarning: '设置 maxTokens 会改变 DSH 请求的默认输出上限。', noChanges: '未报告可应用的变更。', changes: '准确的拟议变更',
        revision: '设置修订版本', digest: '预览摘要', expires: '过期时间（UTC）', review: '检查确认内容', confirmation: '确认此准确预览',
        displayOnly: '仅供查看：这些拟议变更不能应用。',
        confirmExplanation: '只会提交当前服务商、已选 ID 和所展示的准确差异。确认是单独的操作。',
        confirmApply: '确认并应用', back: '返回', cancel: '取消预览', applied: 'Host 返回结果', repreview: '请先重新预览再应用。',
        escapeNotice: '反斜杠和不可见字符已转义显示；实际标识和传输值保持原样。无法识别所有外观相似的字符。',
        expired: '此预览已过期，请先重新预览再确认。',
      },
    }

    const errorMessages = Object.freeze({
      AUTHORITY_UNAVAILABLE: 'Metadata preview and confirmation authority is not yet available.',
      AUTH_REQUIRED: 'Authentication is required.', ORIGIN_REFUSED: 'This request was refused by the origin policy.',
      SETTINGS_UNAVAILABLE: 'Settings are unavailable.', UNKNOWN_SOURCE: 'The configured source is unavailable.',
      UNSUPPORTED_PROTOCOL: 'The provider protocol is unsupported.', INVALID_RESPONSE: 'The response was invalid.',
      INCOMPLETE_RESPONSE: 'Discovery did not complete.', REFERENCE_STALE: 'Reference data is stale.',
      AMBIGUOUS_IDENTITY: 'The model identity is ambiguous.', UNSUPPORTED_EFFORT: 'The reasoning map is unsupported.',
      REVISION_CONFLICT: 'Settings changed; request a new preview.', REPREVIEW_REQUIRED: 'A fresh preview is required.',
      ORIGINAL_WRITER_ACTIVE: 'The original plugin may write this provider; pause it before applying.', WRITE_REJECTED: 'The change was refused.',
      OUTCOME_UNKNOWN: 'The write outcome is unknown. Check the settings before retrying.',
    })
    async function safeJson(response) {
      let data
      try { data = JSON.parse(await response.text()) } catch {
        if (!response.ok) throw new Error(`Request failed (HTTP ${response.status}).`)
        throw new Error('Invalid JSON response.')
      }
      if (!response.ok || data?.error) {
        const code = typeof data?.error?.code === 'string' ? data.error.code : ''
        const error = new Error(errorMessages[code] ?? `Request failed (HTTP ${response.status}).`)
        error.code = code
        error.status = response.status
        throw error
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid JSON response.')
      return data
    }
    function createModelSyncApiClient({ fetchImpl = typeof fetch === 'function' ? fetch : null } = {}) {
      const request = async (path, body) => {
        if (typeof fetchImpl !== 'function') throw new Error('HTTP transport is unavailable.')
        const init = body === undefined
          ? { method: 'GET', credentials: 'same-origin' }
          : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        let response
        try { response = await fetchImpl(API + path, init) } catch { throw new Error('The request could not be completed.') }
        return safeJson(response)
      }
      return Object.freeze({
        getStatus: () => request('/status'),
        preview: (provider, selectedNewIds) => request('/preview', { provider, selectedNewIds }),
        cancel: (previewId) => request('/preview/cancel', { previewId }),
        apply: (previewId, digest) => request('/apply', { previewId, digest }),
        setReferenceEnabled: (enabled) => request('/reference-settings', { enabled }),
      })
    }

    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    const string = value => typeof value === 'string' ? value : ''
    // Keep raw values for comparisons and requests. Display escapes also escape
    // literal backslashes, so an original "\\u200d" cannot impersonate a ZWJ.
    const displayCharacters = /[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}\ud800-\udfff]/gu
    const forbiddenCharacters = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u
    const escapeText = value => string(value).replace(displayCharacters, character => {
      if (character === '\\') return '\\\\'
      const code = character.codePointAt(0)
      return code <= 0xffff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\u{${code.toString(16)}}`
    })
    function hasUnsafeText(value) {
      const stack = [value]
      const seen = new WeakSet()
      while (stack.length) {
        const next = stack.pop()
        if (typeof next === 'string') {
          if (forbiddenCharacters.test(next)) return true
        } else if (next && typeof next === 'object' && !seen.has(next)) {
          seen.add(next)
          for (const [key, child] of Object.entries(next)) stack.push(key, child)
        }
      }
      return false
    }
    const fields = ['contextWindow', 'maxTokens', 'reasoningEfforts']
    const effortKeys = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    function validValue(field, value) {
      if (field !== 'reasoningEfforts') return Number.isSafeInteger(value) && value > 0
      return record(value) && Object.keys(value).some(key => key !== 'off') && Object.entries(value).every(([key, wire]) =>
        effortKeys.includes(key) && ((typeof wire === 'string' && wire.length > 0) || (key === 'off' && wire === null)))
    }
    const onlyKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key))
    function validUtcTimestamp(value) {
      if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return false
      const time = Date.parse(value)
      return Number.isFinite(time) && new Date(time).toISOString() === (value.length === 20 ? value.replace('Z', '.000Z') : value)
    }
    function validSource(source) {
      return record(source) && validUtcTimestamp(source.fetchedAt) &&
        (source.kind === 'upstream' || (source.kind === 'reference' && source.origin === 'https://models.dev/api.json'))
    }
    function showValue(value) {
      if (value === undefined) return 'Unknown'
      try {
        const encoded = JSON.stringify(value)
        return typeof encoded === 'string' ? encoded : 'Unknown'
      } catch { return 'Unknown' }
    }
    function presentPreview(preview) {
      const input = record(preview) ? preview : {}
      const inputItems = Array.isArray(input.items) ? input.items : []
      const inputChanges = Array.isArray(input.changes) ? input.changes : []
      const selected = Array.isArray(input.selectedNewIds) ? input.selectedNewIds : []
      let valid = input.writeEnabled === true && typeof input.provider === 'string' && !!input.provider && typeof input.previewId === 'string' && !!input.previewId &&
        typeof input.digest === 'string' && !!input.digest && Number.isSafeInteger(input.revision) &&
        typeof input.expiresAt === 'string' && Number.isFinite(Date.parse(input.expiresAt)) && Array.isArray(input.items) &&
        Array.isArray(input.selectedNewIds) && Array.isArray(input.changes) && inputChanges.length > 0 &&
        selected.every(id => typeof id === 'string' && !!id) && new Set(selected).size === selected.length && !hasUnsafeText(input)
      const changes = []
      const seenModels = new Set()
      const seenChanges = new Set()
      for (const change of inputChanges) {
        if (!record(change) || typeof change.modelId !== 'string' || !change.modelId) { valid = false; continue }
        if (change.type === 'add-model') {
          if (!onlyKeys(change, ['type', 'modelId'])) valid = false
          const key = `add:${change.modelId}`
          if (seenChanges.has(key) || !selected.includes(change.modelId)) valid = false
          seenChanges.add(key)
          changes.push({ type: 'add-model', modelId: change.modelId })
        } else if (change.type === 'set-field' && fields.includes(change.field) && ['models', 'modelOverrides'].includes(change.scope) && validValue(change.field, change.value)) {
          if (!onlyKeys(change, ['type', 'modelId', 'field', 'scope', 'value', 'index']) ||
              (change.scope === 'models' && (!Number.isSafeInteger(change.index) || change.index < 0)) ||
              (change.scope === 'modelOverrides' && Object.hasOwn(change, 'index'))) valid = false
          const key = `field:${change.modelId}:${change.field}`
          if (seenChanges.has(key)) valid = false
          seenChanges.add(key)
          changes.push({ type: 'set-field', modelId: change.modelId, field: change.field, scope: change.scope,
            ...(Number.isSafeInteger(change.index) ? { index: change.index } : {}), value: showValue(change.value) })
        } else valid = false
      }
      const items = inputItems.map(item => {
        if (!record(item) || typeof item.modelId !== 'string' || !item.modelId ||
            ![true, false, null].includes(item.existing) || seenModels.has(item.modelId)) {
          valid = false
          return { modelId: '', existing: null, reason: 'unknown', fields: [] }
        }
        if (item.existing === null && item.reason !== 'inventory-unknown') valid = false
        seenModels.add(item.modelId)
        const incomingFields = Array.isArray(item.fields) ? item.fields : []
        const displayed = fields.map(name => {
          const candidates = incomingFields.filter(field => record(field) && field.field === name)
          if (candidates.length > 1) valid = false
          const field = candidates[0] || {}
          const change = changes.find(entry => entry.type === 'set-field' && entry.modelId === item.modelId && entry.field === name)
          if (change && (field.state !== 'applicable' || showValue(field.candidate) !== change.value)) valid = false
          if (field.state === 'applicable' && (!change || !validSource(field.source))) valid = false
          const source = record(field.source) ? {
            kind: string(field.source.kind), origin: string(field.source.origin), fetchedAt: string(field.source.fetchedAt),
          } : {}
          return { field: name, state: string(field.state) || 'unknown', reason: string(field.reason),
            before: showValue(field.before), candidate: showValue(field.candidate),
            after: change ? change.value : showValue(field.before), source }
        })
        return { modelId: item.modelId, existing: item.existing, reason: string(item.reason), fields: displayed }
      })
      for (const id of selected) if (!seenChanges.has(`add:${id}`) || !items.some(item => item.modelId === id && item.existing === false && item.reason !== 'inherited-add-unsupported')) valid = false
      for (const change of changes) {
        const item = items.find(row => row.modelId === change.modelId)
        if (!item || item.existing === null || (change.type === 'add-model' && item.existing !== false) ||
            (change.type === 'set-field' && item.existing === false && !selected.includes(item.modelId))) valid = false
      }
      const sources = record(input.sources) ? Object.entries(input.sources).map(([name, source]) => ({
        name, kind: string(source?.kind), status: string(source?.status), reason: string(source?.reason),
        lastAttemptAt: string(source?.lastAttemptAt), origin: string(source?.origin), fetchedAt: string(source?.fetchedAt),
      })) : []
      return { provider: string(input.provider), previewId: string(input.previewId), digest: string(input.digest),
        revision: input.revision, expiresAt: string(input.expiresAt), selectedNewIds: selected.filter(id => typeof id === 'string'),
        items, changes, warnings: Array.isArray(input.warnings) ? input.warnings.filter(value => typeof value === 'string') : [],
        sources, displayOnly: input.writeEnabled === false, canReview: valid }
    }

    // This is a UI state machine, not a Host authorization or an agent tool.
    // Host authentication, CSRF, token ownership, revalidation and one-use
    // semantics remain mandatory and are NOT implemented by this Client.
    function createController(api, notify = () => {}, clock = Date.now) {
      let active = true
      let epoch = 0
      let state = { status: null, provider: '', selected: [], preview: null, stale: false, expired: false, confirming: false, busy: false, referenceDirty: false, error: '', result: '' }
      const emit = patch => { if (active) { state = { ...state, ...patch }; notify(state) } }
      const current = request => active && request === epoch
      const idle = () => active && !state.busy
      const start = () => { if (!idle()) return null; const request = ++epoch; emit({ busy: true, error: '', result: '' }); return request }
      const failure = (request, error) => { if (current(request)) emit({ error: typeof error?.message === 'string' ? error.message : 'Request failed.' }) }
      const end = request => { if (current(request)) emit({ busy: false }) }
      const expired = () => state.preview && Number.isFinite(Date.parse(state.preview.expiresAt)) && clock() >= Date.parse(state.preview.expiresAt)
      const fresh = () => state.preview && !state.stale && !state.referenceDirty && state.preview.canReview &&
        state.preview.provider === state.provider && Number.isFinite(Date.parse(state.preview.expiresAt)) && clock() < Date.parse(state.preview.expiresAt)
      const markExpired = () => { if (expired()) { emit({ stale: true, expired: true, confirming: false }); return true } return false }
      return Object.freeze({
        snapshot: () => state,
        activate: () => { if (!active) { active = true; notify(state) } },
        dispose: () => { if (active) { active = false; epoch++; state = { ...state, busy: false } } },
        async loadStatus() {
          const request = start()
          if (request === null) return
          emit({ status: null, provider: '', preview: null, selected: [], stale: false, confirming: false })
          try {
            const result = await api.getStatus()
            if (!current(request)) return
            if (!Array.isArray(result.providers) || typeof result.referenceEnabled !== 'boolean') throw new Error('Invalid status response.')
            const providers = result.providers.filter(row => record(row) && typeof row.id === 'string' && !!row.id)
              .map(row => ({ id: row.id, status: string(row.status), lastAttemptAt: string(row.lastAttemptAt) }))
            emit({ status: { providers, referenceEnabled: result.referenceEnabled },
              referenceDraft: state.referenceDirty ? state.referenceDraft : result.referenceEnabled,
              provider: providers.some(row => row.id === state.provider) ? state.provider : '', preview: null, selected: [], stale: false, confirming: false })
          } catch (error) { failure(request, error) } finally { end(request) }
        },
        chooseProvider(provider) {
          if (!idle() || !state.status?.providers.some(row => row.id === provider)) return
          emit({ provider, selected: [], preview: null, stale: false, confirming: false, error: '', result: '' })
        },
        chooseReference(enabled) {
          if (idle() && typeof enabled === 'boolean' && enabled !== state.referenceDraft) {
            emit({ referenceDraft: enabled, referenceDirty: true, stale: !!state.preview, confirming: false })
          }
        },
        async saveReference() {
          if (typeof state.referenceDraft !== 'boolean' || !state.status) return
          const request = start()
          if (request === null) return
          const referenceDraft = state.referenceDraft
          emit({ preview: null, selected: [], stale: false, confirming: false })
          try {
            const result = await api.setReferenceEnabled(referenceDraft)
            if (!current(request)) return
            if (typeof result.referenceEnabled !== 'boolean' || result.referenceEnabled !== referenceDraft) throw new Error('Invalid reference setting response.')
            emit({ status: { ...state.status, referenceEnabled: result.referenceEnabled }, referenceDraft: result.referenceEnabled, referenceDirty: false })
          } catch (error) { failure(request, error) } finally { end(request) }
        },
        async preview() {
          if (!state.provider || state.referenceDirty) return
          const request = start()
          if (request === null) return
          emit({ preview: null, stale: false, expired: false, confirming: false })
          try {
            const response = await api.preview(state.provider, [...state.selected])
            if (!current(request)) return
            const result = presentPreview(response)
            if (result.provider !== state.provider) throw new Error('Invalid preview response.')
            const chosen = result.selectedNewIds
            if (chosen.length !== state.selected.length || chosen.some(id => !state.selected.includes(id))) {
              throw new Error('Preview selection mismatch; request a new preview.')
            }
            emit({ preview: result })
          } catch (error) { failure(request, error) } finally { end(request) }
        },
        selectNew(modelId, checked) {
          if (!idle() || !state.preview || typeof checked !== 'boolean') return
          const item = state.preview.items.find(row => row.modelId === modelId)
          if (!item || item.existing !== false || item.reason === 'inherited-add-unsupported') return
          const selected = checked ? [...new Set([...state.selected, modelId])] : state.selected.filter(id => id !== modelId)
          const approved = state.preview.selectedNewIds
          const stale = state.referenceDirty || selected.length !== approved.length || selected.some(id => !approved.includes(id))
          emit({ selected, stale, confirming: false })
        },
        review() { if (!idle() || markExpired()) return; if (fresh()) emit({ confirming: true, error: '' }) },
        back() { if (idle()) emit({ confirming: false }) },
        async confirmApply() {
          if (!idle() || !state.confirming || markExpired() || !fresh()) return
          const { previewId, digest } = state.preview
          const request = start()
          if (request === null) return
          // Invalidate locally before dispatch; concurrent clicks cannot reuse it.
          emit({ confirming: false, preview: null, selected: [], stale: false })
          try {
            const result = await api.apply(previewId, digest)
            if (!current(request)) return
            if (!['applied', 'unchanged'].includes(result.status)) throw new Error('Invalid apply response.')
            emit({ result: result.status })
          } catch (error) { failure(request, error) } finally { end(request) }
        },
        async cancelPreview() {
          if (!state.preview) return
          const request = start()
          if (request === null) return
          const previewId = state.preview.previewId
          emit({ preview: null, selected: [], stale: false, confirming: false })
          try { if (previewId) await api.cancel(previewId) } catch (error) { failure(request, error) } finally { end(request) }
        },
      })
    }

    const style = {
      page: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 880, color: 'var(--dsw-alias-label-primary)' },
      block: { display: 'flex', flexDirection: 'column', gap: 8, padding: 14, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)', overflowWrap: 'anywhere' },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13 },
      row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
      button: { padding: '7px 10px', font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, cursor: 'pointer' },
      warning: { color: 'var(--dsw-alias-state-warn-primary)' },
      error: { color: 'var(--dsw-alias-state-error-primary)' },
      value: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'monospace' },
    }
    const text = value => typeof value === 'string' && value ? escapeText(value) : 'Unknown'
    function MetadataPage({ t }) {
      const [state, setState] = React.useState({ status: null, provider: '', selected: [], preview: null, stale: false, confirming: false, busy: false, error: '', result: '' })
      const [controller] = React.useState(() => createController(createModelSyncApiClient(), setState))
      React.useEffect(() => { controller.activate(); return () => controller.dispose() }, [controller])
      const button = (label, action, disabled = false) => h('button', { type: 'button', style: style.button, disabled: state.busy || disabled, onClick: action }, label)
      const labelValue = (label, value) => h('div', null, h('strong', null, label + ': '), h('span', { style: style.value }, escapeText(value)))
      const sources = state.preview?.sources ?? []
      const selectedProvider = state.status?.providers.find(row => row.id === state.provider)
      return h('div', { style: style.page },
        h('p', { style: style.muted }, t('intro')),
        h('p', { style: style.warning }, t('authority')),
        h('div', { style: style.block },
          button(state.status ? t('refresh') : t('load'), () => controller.loadStatus()),
          state.status ? h('label', null, t('provider'), ' ', h('select', { value: state.provider, disabled: state.busy,
            onChange: event => controller.chooseProvider(event.target.value) },
          h('option', { value: '' }, t('chooseProvider')),
          state.status.providers.map(row => h('option', { key: row.id, value: row.id }, escapeText(row.id))))) : null,
          state.status && !state.status.providers.length ? h('span', { style: style.muted }, t('noProviders')) : null,
          selectedProvider ? h('div', { style: style.muted }, t('status'), ': ', text(selectedProvider.status), ' · ', t('lastAttempt'), ': ', text(selectedProvider.lastAttemptAt)) : null,
          state.provider ? button(state.preview ? t('updatePreview') : t('discover'), () => controller.preview(), state.referenceDirty) : null),
        h('div', { style: style.block }, h('strong', null, t('reference')),
          h('span', null, state.status ? (state.status.referenceEnabled ? t('enabled') : t('disabled')) : t('unknown')),
          h('p', { style: style.muted }, t('disclosure')),
          state.status ? h('label', null, h('input', { type: 'checkbox', checked: state.referenceDraft === true, disabled: state.busy,
            onChange: event => controller.chooseReference(event.target.checked) }), ' ', t('referenceChoice')) : null,
          state.status ? button(t('changeReference'), () => controller.saveReference(), !state.referenceDirty) : null),
        state.busy ? h('span', { role: 'status' }, t('loading')) : null,
        state.error ? h('div', { role: 'alert', style: style.error }, escapeText(state.error)) : null,
        state.result ? h('div', { role: 'status' }, t('applied'), ': ', escapeText(state.result)) : null,
        state.preview ? h('section', { style: style.block },
          h('h2', null, t('preview')), labelValue(t('provider'), state.preview.provider),
          labelValue(t('revision'), String(state.preview.revision)), labelValue(t('expires'), state.preview.expiresAt),
          labelValue(t('digest'), state.preview.digest),
          h('p', { style: style.muted }, t('selectionNote')),
          h('p', { style: style.muted }, t('escapeNotice')),
          labelValue(t('selectedIds'), state.selected.length ? state.selected.join(', ') : t('noSelection')),
          state.stale ? h('p', { role: 'status', style: style.warning }, t(state.expired ? 'expired' : 'stale')) : null,
          sources.map((source, index) => h('div', { key: `${source.name}:${index}`, style: style.muted },
            t('source'), ': ', text(source.name), ' · ', t('sourceKind'), ': ', text(source.kind),
            ' · ', t('status'), ': ', text(source.status), ' · ', t('lastAttempt'), ': ', text(source.lastAttemptAt),
            source.reason ? ` · ${escapeText(source.reason)}` : '', source.origin ? ` · ${escapeText(source.origin)}` : '', source.fetchedAt ? ` · ${escapeText(source.fetchedAt)}` : '')),
          state.preview.items.map((item, index) => h('div', { key: `${item.modelId}:${index}`, style: style.block },
            h('strong', null, escapeText(item.modelId)), h('span', null, item.existing === null ? t('unknown') : item.existing ? t('existingModel') : t('newModel')),
            item.existing === false ? h('label', null, h('input', { type: 'checkbox', checked: state.selected.includes(item.modelId),
              disabled: state.busy || item.reason === 'inherited-add-unsupported',
              onChange: event => controller.selectNew(item.modelId, event.target.checked) }), ' ', t('select')) : null,
            item.reason === 'inherited-add-unsupported' ? h('span', { style: style.warning }, t('inherited')) : null,
            item.reason ? h('span', { style: style.muted }, t('reason'), ': ', escapeText(item.reason)) : null,
            item.fields.map(field => h('div', { key: field.field, style: style.block },
              h('strong', null, field.field), labelValue(t('status'), field.state), labelValue(t('reason'), field.reason || 'Unknown'),
              labelValue(t('before'), field.before), labelValue(t('candidate'), field.candidate), labelValue(t('after'), field.after),
              labelValue(t('sourceKind'), field.source.kind || 'Unknown'), labelValue(t('source'), field.source.origin || 'Unknown'),
              labelValue(t('fetchedAt'), field.source.fetchedAt || 'Unknown'))))),
          h('h3', null, t('changes')),
          state.preview.changes.length ? state.preview.changes.map((change, index) => h('div', { key: index, style: style.value },
            escapeText(change.type === 'add-model' ? `add-model: ${change.modelId}` : `set-field: ${change.modelId} / ${change.scope}${change.index === undefined ? '' : '[' + change.index + ']'} / ${change.field} → ${change.value}`))) : h('span', null, t('noChanges')),
          state.preview.warnings.map((warning, index) => h('p', { key: index, style: style.warning }, t('warning'), ': ', escapeText(warning))),
          state.preview.changes.some(change => change.field === 'maxTokens') ? h('p', { style: style.warning }, t('maxWarning')) : null,
          state.preview.displayOnly ? h('p', { style: style.warning }, t('displayOnly')) :
            !state.preview.canReview && state.preview.changes.length ? h('p', { style: style.warning }, t('repreview')) : null,
          state.confirming ? h('div', { style: style.block }, h('h3', null, t('confirmation')),
            h('p', null, t('confirmExplanation')), labelValue(t('provider'), state.preview.provider),
            labelValue(t('selectedIds'), state.preview.selectedNewIds.length ? state.preview.selectedNewIds.join(', ') : t('noSelection')),
            labelValue(t('digest'), state.preview.digest),
            button(t('confirmApply'), () => controller.confirmApply()), button(t('back'), () => controller.back()))
            : button(t('review'), () => controller.review(), !state.preview.canReview || state.stale),
          button(t('cancel'), () => controller.cancelPreview())) : null)
    }
    function Page(props) {
      const t = typeof props.t === 'function' ? props.t : key => dictionaries.en[key] || key
      return props.view === 'summary' ? h('span', null, t('summary')) : h(MetadataPage, { t })
    }
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-model-metadata-sync: locale')
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config', key: 'dsh-model-metadata-sync#dsh-model-metadata-sync', locale: NS,
      }, Page))
    }
    return { inject: ['slots', 'locale'], apply, createModelSyncApiClient, presentPreview, createController, dictionaries }
  },
})
