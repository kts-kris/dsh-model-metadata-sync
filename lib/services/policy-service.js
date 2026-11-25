/**
 * Legacy selection, policy and webhook operations have no exact-diff consent
 * boundary. Refuse before reading Host state, persisting config or making any
 * network request. They can be reintroduced only through the preview authority.
 */
export function createPolicyService() {
  async function refuse() {
    throw Object.assign(new Error('Legacy policy, selection and webhook operations are disabled.'), {
      code: 'UNSUPPORTED_OPERATION',
    })
  }

  return Object.freeze({
    setModelPolicy: refuse,
    setModelSelection: refuse,
    testWebhook: refuse,
  })
}
