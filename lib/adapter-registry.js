import { createGenericAdapter } from './generic-adapter.js'

/**
 * Host-only registry for the supported OpenAI Chat Completions discovery lane.
 * The registry's dependencies and independent documentation proof must be
 * selected by the Host, never by an HTTP body or an upstream response. A
 * configured gateway's exact models endpoint takes precedence over all vendor
 * names; unproven legacy vendor, declarative and injected adapters are refused.
 */
export function createProviderAdapterRegistry({ resolveCredential, fetchImpl = globalThis.fetch, trustedRegistry = [] } = {}) {
  const generic = createGenericAdapter({ resolveCredential, fetchImpl, trustedRegistry })
  return Object.freeze({
    // Retain the old method name but never expose arbitrary executable adapters.
    register() {
      throw Object.assign(new Error('Custom adapters are disabled.'), { code: 'UNSUPPORTED_OPERATION' })
    },
    select(profile) {
      return profile?.baseURL ? generic : null
    },
  })
}
