/**
 * The inherited transfer and alias helpers could mutate plugin configuration
 * and enable unattended actions. Retain the surface only as an explicit
 * refusal until a separately authorized replacement is designed.
 */
export function createConfigTransfer() {
  function unsupported() {
    throw Object.assign(new Error(
      'Legacy configuration transfer and aliases are disabled and unsupported by the metadata sync fork.',
    ), { code: 'UNSUPPORTED_OPERATION' })
  }

  return Object.freeze({
    exportConfig: unsupported,
    importConfig: unsupported,
    getAliases: unsupported,
    setAlias: unsupported,
    deleteAlias: unsupported,
    resolveAlias: unsupported,
  })
}
