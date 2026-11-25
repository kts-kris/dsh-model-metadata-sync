import { createPolicyService } from './services/policy-service.js'
import { performHistoryRollback } from './synchronizer-helpers.js'

/**
 * Fail-closed compatibility surface for the retired synchronizer.
 *
 * The legacy runner rebuilt provider lists and could write, emit notifications,
 * probe endpoints, or dispatch webhooks without approval of an exact diff. Its
 * array-based discovery also cannot consume the new identity-bound catalog.
 * Until a separate preview-and-confirm authority is wired, neither write nor
 * dry-run discovery is safe to offer here. Construction deliberately does not
 * create a state store, adapter registry, or any legacy remote-effect service.
 */
export function createModelSynchronizer(_ctx, _options = {}) {
  const policy = createPolicyService()

  async function run() {
    throw Object.assign(new Error(
      'Legacy synchronization, including dry-run discovery, is disabled until a safe preview authority is available.',
    ), { code: 'UNSUPPORTED_OPERATION' })
  }

  return Object.freeze({
    services: Object.freeze({ policy }),
    run,
    setModelSelection: policy.setModelSelection,
    setModelPolicy: policy.setModelPolicy,
    rollbackHistory: performHistoryRollback,
  })
}
