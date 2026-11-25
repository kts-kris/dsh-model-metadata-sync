/**
 * The legacy synchronizer cannot perform even read-only discovery safely yet.
 * Keep the scheduler lifecycle callable, but refuse scheduling rather than
 * passing legacy auto-apply flags, calling pricing, or inventing a successful
 * discovery. Re-enable it only against a separate safe preview authority.
 */
export function createSyncScheduler(_sync, _options = {}) {
  const reason = 'Background scheduling is disabled until a safe preview authority is available.'

  function start() {
    return false
  }

  function stop() {}

  async function tick() {
    throw Object.assign(new Error(reason), { code: 'UNSUPPORTED_OPERATION' })
  }

  function status() {
    return {
      active: false,
      running: false,
      lastRunAt: null,
      nextRunAt: null,
      providers: {},
      status: 'unsupported',
      reason,
    }
  }

  return Object.freeze({ start, stop, reconfigure: start, tick, status })
}
