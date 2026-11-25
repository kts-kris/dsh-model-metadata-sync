import test from 'node:test'
import assert from 'node:assert/strict'
import { createDiagnosticsRoutes } from '../lib/routes/diagnostics.js'

// No snapshot bytes or user settings are read: unsafe snapshots are never
// replayable. Fixtures model both known historical data-loss modes.
for (const [name, before] of [
  ['field-reduced snapshot', [{ id: 'old-model' }]],
  ['snapshot over the 5,000-model historical bound', Array.from({ length: 5001 }, (_, i) => ({ id: `model-${i}` }))],
]) {
  test(`legacy rollback visibly refuses a ${name}`, async () => {
    const effects = []
    const synchronizer = {
      rollbackHistory() { effects.push('rollbackHistory'); throw new Error('snapshot must not be replayed') },
      listProviders() { effects.push('listProviders'); return [] },
    }
    const routes = createDiagnosticsRoutes(synchronizer)
    const request = { method: 'POST', snapshot: { before } }
    const response = { status: 0, body: '' }
    const res = {
      writeHead(status) { response.status = status; return this },
      end(body) { response.body = body; return this },
    }
    // A refusal must not consume or trust historical snapshot payloads.
    request.on = () => { effects.push('request body read'); throw new Error('snapshot must not be read') }
    await routes.rollback(request, res)
    assert.deepEqual(effects, [])
    assert.equal(response.status, 410)
    const body = JSON.parse(response.body)
    assert.equal(body.error.code, 'UNSUPPORTED_OPERATION')
    assert.match(body.error.message, /(?:omit|missing|incomplete).*(?:field)|field.*(?:omit|missing|incomplete)/i)
    assert.match(body.error.message, /truncat/i)
  })
}
