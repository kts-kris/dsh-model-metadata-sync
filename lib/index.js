import Schema from '@deepseek-ai/schemastery'
import { createModelSynchronizer } from './synchronizer.js'
import { registerHttpApi } from './http.js'

// The fork is independently owned and must never provide the original
// modelSync/modelSyncRunner services. Preview is read-only; write authority
// remains a fail-closed HTTP reservation.
export const name = 'dsh-model-metadata-sync'
export const inject = ['webServer', 'webApp']

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  // The loader updates this volatile field in place. Read lazily for explicit
  // preview requests without starting background fetching.
  referenceEnabled: Schema.boolean().default(true).volatile(),
})

export function plainConfig(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(plainConfig)
  if (typeof value.get === 'function') return plainConfig(value.get())
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainConfig(item)]))
}

/**
 * Narrow seam for the future authenticated reference-settings authority.
 * It edits only this fiber's own loader entry, never a named original-plugin
 * namespace or a provider setting. No editor is consulted until explicitly
 * invoked; closing the owner makes retained callbacks unusable.
 */
export function createForkReferenceSettings(ctx, config = {}) {
  const entry = ctx?.fiber?.entry
  let active = true

  return Object.freeze({
    getReferenceEnabled() {
      const value = plainConfig(config?.referenceEnabled)
      return value === undefined ? true : value === true
    },
    async setReferenceEnabled(enabled, signal) {
      if (typeof enabled !== 'boolean') {
        throw Object.assign(new Error('Reference setting must be a boolean.'), { code: 'INVALID_CONFIG' })
      }
      if (!active || (signal !== undefined && signal?.aborted !== false) || entry === undefined || typeof ctx?.get !== 'function') {
        throw Object.assign(new Error('Fork configuration cannot be saved.'), { code: 'CONFIG_UNAVAILABLE' })
      }
      let editor
      try {
        editor = ctx.get('configEditor')
      } catch {
        throw Object.assign(new Error('Fork configuration cannot be saved.'), { code: 'CONFIG_UNAVAILABLE' })
      }
      if (!editor || typeof editor.edit !== 'function') {
        throw Object.assign(new Error('Fork configuration cannot be saved.'), { code: 'CONFIG_UNAVAILABLE' })
      }
      try {
        await editor.edit(entry, current => {
          if (!active || (signal !== undefined && signal?.aborted !== false)) throw new Error('Fork configuration cannot be saved.')
          return { ...current, referenceEnabled: enabled }
        })
      } catch {
        throw Object.assign(new Error('Fork configuration update was rejected.'), { code: 'WRITE_REJECTED' })
      }
    },
    dispose() { active = false },
  })
}

export function apply(ctx, config) {
  // The compatibility runner and registered routes explicitly refuse their
  // inherited operations; neither supplies a public Host service. In
  // particular, loading the plugin starts no scheduler, updater, state store,
  // provider discovery, inference, or other background I/O.
  const synchronizer = createModelSynchronizer(ctx)
  ctx.effect(() => {
    const referenceSettings = createForkReferenceSettings(ctx, config)
    let registrations
    try { registrations = registerHttpApi(ctx, synchronizer, { referenceSettings }) }
    catch (error) { referenceSettings.dispose(); throw error }
    return () => {
      referenceSettings.dispose()
      let cleanupFailed = false
      for (const dispose of registrations.reverse()) {
        try { if (typeof dispose === 'function') dispose() } catch { cleanupFailed = true }
      }
      if (cleanupFailed) throw Object.assign(new Error('Route cleanup could not be confirmed.'), {
        code: 'ROUTE_CLEANUP_UNCONFIRMED',
      })
    }
  }, 'dsh-model-metadata-sync: HTTP routes')
}
