// Public transport seam. Only fork-owned, same-origin routes are addressable.
export const API = '/dsh-model-metadata-sync'

const messages = Object.freeze({
  AUTHORITY_UNAVAILABLE: 'Metadata preview and confirmation authority is not yet available.',
  AUTH_REQUIRED: 'Authentication is required.',
  ORIGIN_REFUSED: 'This request was refused by the origin policy.',
  SETTINGS_UNAVAILABLE: 'Settings are unavailable.',
  UNKNOWN_SOURCE: 'The configured source is unavailable.',
  UNSUPPORTED_PROTOCOL: 'The provider protocol is unsupported.',
  INVALID_RESPONSE: 'The response was invalid.',
  INCOMPLETE_RESPONSE: 'Discovery did not complete.',
  REFERENCE_STALE: 'Reference data is stale.',
  AMBIGUOUS_IDENTITY: 'The model identity is ambiguous.',
  UNSUPPORTED_EFFORT: 'The reasoning map is unsupported.',
  REVISION_CONFLICT: 'Settings changed; request a new preview.',
  REPREVIEW_REQUIRED: 'A fresh preview is required.',
  ORIGINAL_WRITER_ACTIVE: 'The original plugin may write this provider; pause it before applying.',
  WRITE_REJECTED: 'The change was refused.',
})

export async function safeJson(response) {
  let data
  try { data = JSON.parse(await response.text()) } catch {
    if (!response.ok) throw new Error(`Request failed (HTTP ${response.status}).`)
    throw new Error('Invalid JSON response.')
  }
  if (!response.ok || data?.error) {
    const code = typeof data?.error?.code === 'string' ? data.error.code : ''
    const error = new Error(messages[code] ?? `Request failed (HTTP ${response.status}).`)
    error.code = code
    error.status = response.status
    throw error
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid JSON response.')
  return data
}

export function createModelSyncApiClient({ fetchImpl = typeof fetch === 'function' ? fetch : null } = {}) {
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
