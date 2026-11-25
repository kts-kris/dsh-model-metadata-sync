import { parentPort } from 'node:worker_threads';
import { encodeReferenceRecords, fetchReferenceWorker } from './reference-worker.js';

// Only this explicit Worker entry initiates a request. It has no input channel:
// workerData, environment, private selectors and headers are never read. The
// parent enforces the absolute deadline and publishes only after normal exit.
if (!parentPort) throw new Error('Reference worker requires a parent port');
const result = await fetchReferenceWorker();
let message = '[]';
if (result.status === 'complete') {
  try { message = encodeReferenceRecords(result.records); } catch { /* unknown */ }
}
parentPort.postMessage(message);
parentPort.close();
