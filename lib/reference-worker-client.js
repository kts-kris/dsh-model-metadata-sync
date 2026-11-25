import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { Buffer } from 'node:buffer';

const WORKER_ENTRY = new URL('./reference-worker-entry.js', import.meta.url);
const DEADLINE_MS = 15_000;
const MAX_RECORDS = 20_000;
const MAX_RECORD_BYTES = 8 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 128;
const unknown = (reason) => ({ status: 'unknown', records: [], reason });
const isWhitespace = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t';

/*
 * Inspect the one IPC value BEFORE JSON.parse constructs any records. The only
 * accepted wire form is a JSON array string of objects. This scanner is not a
 * JSON validator: the bounded text is parsed after a clean exit. It identifies
 * exact record boundaries while respecting quoted/escaped braces and brackets.
 */
function scanResult(text) {
  if (typeof text !== 'string') return 'invalid-result';
  if (text.length > MAX_RESULT_BYTES || Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) return 'result-limit';
  let i = 0;
  const skip = () => { while (i < text.length && isWhitespace(text[i])) i++; };
  skip();
  if (text[i++] !== '[') return 'invalid-result';
  skip();
  if (text[i] === ']') return 'invalid-result';
  let count = 0;
  while (i < text.length) {
    skip();
    if (text[i] !== '{') return 'invalid-result';
    const start = i;
    const stack = [];
    let quoted = false;
    let escaped = false;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') {
        quoted = true;
      } else if (c === '{' || c === '[') {
        stack.push(c);
        if (stack.length > MAX_DEPTH) return 'result-limit';
      } else if (c === '}' || c === ']') {
        if (stack.pop() !== (c === '}' ? '{' : '[')) return 'invalid-result';
        if (stack.length === 0) { i++; break; }
      }
      if (i - start >= MAX_RECORD_BYTES) return 'result-limit';
    }
    if (quoted || stack.length !== 0) return 'invalid-result';
    if (Buffer.byteLength(text.slice(start, i), 'utf8') > MAX_RECORD_BYTES || ++count > MAX_RECORDS) return 'result-limit';
    skip();
    if (text[i] === ']') {
      i++;
      skip();
      return i === text.length ? null : 'invalid-result';
    }
    if (text[i++] !== ',') return 'invalid-result';
  }
  return 'invalid-result';
}

const snapshotProvenance = new WeakMap();
const controllerDomains = new WeakMap();
const snapshotReceipts = new WeakMap();
const freezeSnapshot = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
};

/** Internal, read-only brand test; test controllers cannot mint production records. */
export function referenceSnapshotMatchesController(snapshot, controller) {
  const domain = controllerDomains.get(controller);
  return !!domain && snapshotProvenance.get(snapshot) === domain;
}

/** The local controller's time, never a remote record's self-declared time. */
export function referenceSnapshotReceiptTime(snapshot) {
  return snapshotReceipts.get(snapshot) ?? null;
}

/** Production-domain check is intentionally separate from every test factory. */
export function isProductionReferenceSnapshot(snapshot) {
  return referenceSnapshotMatchesController(snapshot, production);
}

function createController({ createWorker, clock, deadlineMs, receiptClock }) {
  const domain = Object.freeze({});
  let active = false;
  let poisoned = false;
  const controller = Object.freeze({
    fetch(...args) {
      // Do not accept an endpoint, headers, credentials, request body or any
      // other per-request data, even if a future caller accidentally supplies it.
      if (args.length !== 0) return Promise.resolve(unknown('invalid-request'));
      if (active || poisoned) return Promise.resolve(unknown('busy'));
      active = true;
      return new Promise((resolve) => {
        let worker;
        let timer;
        let start;
        let lastTime;
        let staged;
        let received = false;
        let settled = false;
        let exitSeen = false;
        let exitCode;
        let terminationPending = false;
        let terminationCode;
        let terminating = false;

        const finish = (value) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) {
            try { clock.clearTimeout(timer); } catch { /* cleanup must not expose Host errors */ }
          }
          resolve(value);
        };
        const releaseAfterExit = () => {
          if (!exitSeen || terminationPending || poisoned) return;
          if (terminating && terminationCode !== exitCode) { poisoned = true; return; }
          active = false;
        };
        const terminate = () => {
          if (!worker || exitSeen || terminating) return;
          terminating = true;
          terminationPending = true;
          try {
            const result = worker.terminate();
            if (!result || typeof result.then !== 'function') throw new Error('invalid termination');
            Promise.resolve(result).then((code) => {
              terminationPending = false;
              if (!Number.isInteger(code) || code < 0) poisoned = true;
              else terminationCode = code;
              releaseAfterExit();
            }, () => { terminationPending = false; poisoned = true; }).catch(() => { poisoned = true; });
          } catch {
            terminationPending = false;
            poisoned = true;
          }
        };
        const fail = (reason) => { finish(unknown(reason)); terminate(); };
        const timeLeft = () => {
          try {
            const now = clock.now();
            if (!Number.isFinite(now) || (lastTime !== undefined && now < lastTime)) return NaN;
            lastTime = now;
            return start + deadlineMs - now;
          } catch { return NaN; }
        };
        const checkTime = () => {
          const left = timeLeft();
          if (!Number.isFinite(left)) { fail('clock'); return false; }
          if (left <= 0) { fail('deadline'); return false; }
          return true;
        };
        const onTimer = () => {
          if (settled) return;
          const left = timeLeft();
          if (!Number.isFinite(left)) return fail('clock');
          if (left <= 0) return fail('deadline');
          try { timer = clock.setTimeout(onTimer, left); } catch { fail('clock'); }
        };

        try {
          start = clock.now();
          if (!Number.isFinite(start)) throw new Error('invalid clock');
          lastTime = start;
          timer = clock.setTimeout(onTimer, deadlineMs);
        } catch {
          active = false;
          finish(unknown('clock'));
          return;
        }
        try {
          worker = createWorker(new URL(WORKER_ENTRY.href), {
            resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
            env: {}, execArgv: [], stdin: false, stdout: true, stderr: true,
          });
          worker.on('message', (message) => {
            if (settled || exitSeen) return;
            if (!checkTime()) return;
            if (received) return fail('protocol-violation');
            received = true;
            const problem = scanResult(message);
            if (!checkTime()) return;
            if (problem) return fail(problem);
            staged = message;
          });
          worker.on('messageerror', () => { if (!settled && !exitSeen) fail('protocol-violation'); });
          worker.on('error', () => { if (!settled && !exitSeen) fail('worker-error'); });
          worker.on('exit', (code) => {
            if (exitSeen) { poisoned = true; return; }
            exitSeen = true;
            exitCode = code;
            if (!Number.isInteger(code) || code < 0) poisoned = true;
            if (!settled) {
              if (checkTime()) {
                if (code !== 0) finish(unknown('worker-exit'));
                else if (!received || staged === undefined) finish(unknown('invalid-result'));
                else {
                  try {
                    const records = JSON.parse(staged);
                    if (!Array.isArray(records) || !records.length || records.length > MAX_RECORDS ||
                        records.some((record) => !record || typeof record !== 'object' || Array.isArray(record))) {
                      finish(unknown('invalid-result'));
                    } else if (checkTime()) {
                      let receipt;
                      try { receipt = receiptClock(); } catch { /* unavailable Host clock */ }
                      if (typeof receipt !== 'string' || !Number.isFinite(Date.parse(receipt)) ||
                          new Date(Date.parse(receipt)).toISOString() !== receipt) {
                        finish(unknown('clock'));
                      } else {
                        const snapshot = freezeSnapshot({ status: 'complete', records });
                        snapshotProvenance.set(snapshot, domain);
                        snapshotReceipts.set(snapshot, receipt);
                        finish(snapshot);
                      }
                    }
                  } catch { finish(unknown('invalid-result')); }
                }
              }
            }
            releaseAfterExit();
          });
          // Never forward worker output to Host logs. Drain rather than buffer it.
          worker.stdout?.resume();
          worker.stderr?.resume();
          checkTime(); // includes synchronous Worker construction and listener setup
        } catch {
          if (worker) fail('worker-start');
          else { active = false; finish(unknown('worker-start')); }
        }
      });
    },
  });
  controllerDomains.set(controller, domain);
  return controller;
}

const systemClock = Object.freeze({
  now: () => performance.now(),
  setTimeout: (fn, delay) => setTimeout(fn, delay),
  clearTimeout: (id) => clearTimeout(id),
});
const production = createController({
  createWorker: (entry, options) => new Worker(entry, options),
  clock: systemClock,
  deadlineMs: DEADLINE_MS,
  receiptClock: () => new Date().toISOString(),
});

/**
 * HOST ONLY. Starts the fixed ./reference-worker-entry.js, with no workerData or
 * incoming messages, empty environment and fixed resource limits. Never bind
 * this API to HTTP or pass it a user URL, private endpoint, credential or
 * options. It accepts no arguments and caches nothing. Returns a sanitized
 * {status:'complete', records} or {status:'unknown', records:[], reason}.
 * Worker records are untrusted projections, not authority to modify settings;
 * the private Host bridge must still establish identity, source and applicability.
 * The sole IPC value is a string containing one JSON array of record objects;
 * 20,000 records, 8 KiB per record and 8 MiB for the array are maximum UTF-8
 * sizes. The worker must not send progress, diagnostics or a second message.
 * Worker threads/resourceLimits are not an OS filesystem/network sandbox, and
 * Node structured-clones a message before the Host can enforce these bounds;
 * this is not a hard cap on transport-queue memory or peak process RSS.
 * The fixed entry implements transport and projection; a clean bounded exit is
 * necessary but not sufficient for source or target applicability.
 */
export function fetchReferenceSnapshot(...args) {
  return production.fetch(...args);
}

/**
 * TESTS ONLY, trusted Host code: dependency injection for controlled Worker and
 * monotonic clock. Never expose this factory to HTTP or user configuration.
 * A shorter deadline is permitted to test real isolation; never a longer one.
 * `createWorker` receives only the fixed entry and fixed options; `clock` is
 * {now,setTimeout,clearTimeout}. No network/parser implementation lives here.
 */
export function createReferenceWorkerControllerForTest({ createWorker, clock = systemClock, deadlineMs = DEADLINE_MS,
  receiptClock = () => new Date().toISOString() } = {}) {
  if (typeof createWorker !== 'function' || typeof receiptClock !== 'function' || !clock || typeof clock.now !== 'function' ||
      typeof clock.setTimeout !== 'function' || typeof clock.clearTimeout !== 'function' ||
      !Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > DEADLINE_MS) {
    throw new TypeError('Invalid trusted test dependencies');
  }
  return createController({ createWorker, clock, deadlineMs, receiptClock });
}
