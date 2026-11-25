import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { Worker } from 'node:worker_threads';
import { createReferenceWorkerControllerForTest, fetchReferenceSnapshot,
  fetchReferenceSnapshotWithSignal } from '../lib/reference-worker-client.js';

class FakeClock {
  nowMs = 0;
  nextId = 1;
  timers = new Map();
  now = () => this.nowMs;
  setTimeout = (fn, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { fn, at: this.nowMs + delay });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  advance(ms) {
    this.nowMs += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.nowMs && this.timers.delete(id)) timer.fn();
    }
  }
}

class FakeWorker extends EventEmitter {
  terminations = 0;
  terminate() {
    this.terminations++;
    return new Promise((resolve, reject) => { this.finishTermination = resolve; this.failTermination = reject; });
  }
}

function harness() {
  const clock = new FakeClock();
  const workers = [];
  const starts = [];
  const controller = createReferenceWorkerControllerForTest({
    clock,
    createWorker(entry, options) {
      starts.push({ entry, options });
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  return { clock, workers, starts, controller };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const good = '[{"provider":"synthetic","modelId":"fixture"}]';

test('a previously cancelled owner cannot start a reference worker', async () => {
  const { controller, workers, clock } = harness();
  const owner = new AbortController();
  owner.abort('synthetic-private-reason');
  assert.equal(typeof controller.fetchWithSignal, 'function', 'trusted Host cancellation seam is available');
  assert.deepEqual(await controller.fetchWithSignal(owner.signal), { status: 'unknown', records: [], reason: 'aborted' });
  assert.equal(workers.length, 0);
  assert.equal(clock.timers.size, 0);
});

async function fakeExchange(message, exitCode = 0) {
  const { controller, workers } = harness();
  const pending = controller.fetch();
  workers[0].emit('message', message);
  workers[0].emit('exit', exitCode);
  workers[0].finishTermination?.(exitCode);
  return pending;
}

test('owner abort terminates its worker and blocks retry until exit and termination agree', async () => {
  for (const first of ['exit', 'termination']) {
    const { controller, workers, clock } = harness();
    const owner = new AbortController();
    const pending = controller.fetchWithSignal(owner.signal);
    workers[0].emit('message', good); // staged is not yet published
    owner.abort('synthetic-secret');
    owner.abort('again');
    assert.equal(workers[0].terminations, 1, 'owner cancellation must immediately terminate its worker');
    assert.deepEqual(await pending, { status: 'unknown', records: [], reason: 'aborted' });
    assert.equal(clock.timers.size, 0);
    workers[0].emit('message', '[{"leak":"late"}]');
    if (first === 'exit') workers[0].emit('exit', 1);
    else workers[0].finishTermination(1);
    await tick();
    assert.equal((await controller.fetch()).reason, 'busy');
    if (first === 'exit') workers[0].finishTermination(1);
    else workers[0].emit('exit', 1);
    await tick();
    const retry = controller.fetch();
    workers[0].emit('message', '[{"leak":"stale"}]');
    workers[1].emit('message', good);
    workers[1].emit('exit', 0);
    assert.deepEqual((await retry).records, [{ provider: 'synthetic', modelId: 'fixture' }]);
  }
});

test('startup cancellation terminates after construction, not a later owner', async () => {
  const clock = new FakeClock();
  const owner = new AbortController();
  let worker;
  const controller = createReferenceWorkerControllerForTest({ clock, createWorker() {
    owner.abort('disposed');
    return (worker = new FakeWorker());
  } });
  const pending = controller.fetchWithSignal(owner.signal);
  assert.equal(worker.terminations, 1);
  assert.equal((await pending).reason, 'aborted');
  assert.equal((await controller.fetch()).reason, 'busy');
  worker.emit('message', good);
  worker.emit('exit', 1);
  worker.finishTermination(1);
  await tick();
  assert.equal(getEventListeners(owner.signal, 'abort').length, 0);
});

test('signal listeners are cleared when work succeeds, fails or is cancelled', async () => {
  for (const outcome of ['success', 'error', 'abort']) {
    const { controller, workers } = harness();
    const owner = new AbortController();
    const pending = controller.fetchWithSignal(owner.signal);
    assert.equal(getEventListeners(owner.signal, 'abort').length, 1);
    if (outcome === 'success') { workers[0].emit('message', good); workers[0].emit('exit', 0); }
    if (outcome === 'error') { workers[0].emit('error', new Error('private')); }
    if (outcome === 'abort') owner.abort();
    assert.equal((await pending).status, outcome === 'success' ? 'complete' : 'unknown');
    assert.equal(getEventListeners(owner.signal, 'abort').length, 0);
    if (outcome !== 'success') { workers[0].emit('exit', 1); workers[0].finishTermination(1); await tick(); }
    const retry = controller.fetch();
    owner.abort(); // a disposed/old owner must not terminate a later request
    assert.equal(workers[1].terminations, 0);
    workers[1].emit('message', good);
    workers[1].emit('exit', 0);
    assert.equal((await retry).status, 'complete');
  }
});

test('cancellation accepts only one genuine signal and never forwards it or request data', async () => {
  const { controller, starts, workers } = harness();
  const owner = new AbortController();
  const secret = 'synthetic-secret';
  const url = 'http://private.example.invalid';
  for (const args of [[], [undefined], [null], [{}], [{ signal: owner.signal, endpoint: url, authorization: secret }],
    [new Proxy(owner.signal, {})], [owner.signal, { endpoint: url, authorization: secret }]]) {
    assert.equal((await controller.fetchWithSignal(...args)).reason, 'invalid-request');
    assert.equal((await fetchReferenceSnapshotWithSignal(...args)).reason, 'invalid-request');
  }
  assert.equal(starts.length, 0);
  const pending = controller.fetchWithSignal(owner.signal);
  assert.equal(starts.length, 1);
  assert.deepEqual(Reflect.ownKeys(starts[0].options).sort(),
    ['env', 'execArgv', 'resourceLimits', 'stderr', 'stdin', 'stdout'].sort());
  assert.equal(JSON.stringify(starts).includes(secret), false);
  assert.equal(JSON.stringify(starts).includes(url), false);
  owner.abort(secret);
  assert.equal(JSON.stringify(await pending).includes(secret), false);
  workers[0].emit('exit', 1); workers[0].finishTermination(1);
  await tick();
});

test('only the owner of an admitted flight can cancel it', async () => {
  const { controller, workers } = harness();
  const owner = new AbortController();
  const other = new AbortController();
  const pending = controller.fetchWithSignal(owner.signal);
  assert.equal((await controller.fetchWithSignal(other.signal)).reason, 'busy');
  assert.equal(getEventListeners(other.signal, 'abort').length, 0);
  other.abort();
  assert.equal(workers[0].terminations, 0);
  workers[0].emit('message', good);
  workers[0].emit('exit', 0);
  assert.equal((await pending).status, 'complete');
});

test('abort cannot be suppressed by an earlier signal listener', async () => {
  const { controller, workers } = harness();
  const owner = new AbortController();
  owner.signal.addEventListener('abort', event => event.stopImmediatePropagation());
  const pending = controller.fetchWithSignal(owner.signal);
  owner.abort();
  assert.equal(workers[0].terminations, 1, 'trusted owner must terminate despite stopImmediatePropagation');
  assert.equal((await pending).reason, 'aborted');
  workers[0].emit('exit', 1); workers[0].finishTermination(1);
});

test('abort during final receipt cannot publish a completed snapshot', async () => {
  const owner = new AbortController();
  let worker;
  const controller = createReferenceWorkerControllerForTest({
    createWorker: () => (worker = new FakeWorker()),
    receiptClock() { owner.abort('disposed during exit'); throw new Error('private clock failure'); },
  });
  const pending = controller.fetchWithSignal(owner.signal);
  worker.emit('message', good);
  worker.emit('exit', 0);
  const result = await pending;
  assert.deepEqual(result, { status: 'unknown', records: [], reason: 'aborted' });
  const { referenceSnapshotMatchesController } = await import('../lib/reference-worker-client.js');
  assert.equal(referenceSnapshotMatchesController(result, controller), false, 'cancelled results never gain authority');
});

test('publishes one projected JSON result only after clean worker exit', async () => {
  const { controller, workers } = harness();
  const pending = controller.fetch();
  workers[0].emit('message', good);
  workers[0].emit('exit', 0);
  assert.deepEqual(await pending, { status: 'complete', records: [{ provider: 'synthetic', modelId: 'fixture' }] });
});

test('stages a result without publishing it while the worker remains alive', async () => {
  const { controller, workers } = harness();
  let settled = false;
  const pending = controller.fetch().then((result) => { settled = true; return result; });
  workers[0].emit('message', good);
  await tick();
  assert.equal(settled, false, 'a message is not a committed result');
  workers[0].emit('exit', 0);
  assert.equal((await pending).status, 'complete');
});

test('an extra message invalidates the staged result and is not accepted', async () => {
  const { controller, workers } = harness();
  const pending = controller.fetch();
  workers[0].emit('message', good);
  workers[0].emit('message', good);
  assert.equal((await pending).reason, 'protocol-violation');
  assert.equal(workers[0].terminations, 1);
  workers[0].emit('exit', 1);
  workers[0].finishTermination(1);
});

test('a valid result followed by a crash is unknown', async () => {
  const { controller, workers } = harness();
  const pending = controller.fetch();
  workers[0].emit('message', good);
  workers[0].emit('exit', 1);
  assert.equal((await pending).reason, 'worker-exit');
});

test('timeout kills the worker and retains single-flight until observed exit', async () => {
  const { controller, workers, clock } = harness();
  const pending = controller.fetch();
  clock.advance(15_000);
  assert.equal((await pending).reason, 'deadline');
  assert.equal(workers[0].terminations, 1);
  workers[0].emit('message', good);
  assert.equal((await controller.fetch()).reason, 'busy');
  workers[0].emit('exit', 1);
  workers[0].finishTermination(1);
  await tick();
  const retry = controller.fetch();
  workers[1].emit('message', good);
  workers[1].emit('exit', 0);
  assert.equal((await retry).status, 'complete');
});

test('only a fixed entry and isolated 128/16/4 MiB worker options are started', async () => {
  const { controller, starts, workers } = harness();
  const pending = controller.fetch();
  workers[0].emit('exit', 1);
  await pending;
  assert.equal(starts.length, 1);
  assert.equal(starts[0].entry.href, new URL('../lib/reference-worker-entry.js', import.meta.url).href);
  assert.deepEqual(starts[0].options.resourceLimits, {
    maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4,
  });
  assert.deepEqual(starts[0].options.env, {});
  assert.equal(Object.hasOwn(starts[0].options, 'workerData'), false);
  assert.deepEqual(starts[0].options.execArgv, []);
  assert.equal(starts[0].options.stdin, false, 'worker cannot inherit process input');
});

test('rejects more than 20,000 projected records instead of publishing a prefix', async () => {
  const exact = `[${Array(20_000).fill('{}').join(',')}]`;
  const tooMany = `[${Array(20_001).fill('{}').join(',')}]`;
  assert.equal((await fakeExchange(exact)).records.length, 20_000);
  const result = await fakeExchange(tooMany);
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'result-limit');
  assert.deepEqual(result.records, []);
});

test('deadline wins races even when a timer callback has not run', async () => {
  for (const event of ['message', 'exit']) {
    const { controller, workers, clock } = harness();
    const pending = controller.fetch();
    if (event === 'exit') workers[0].emit('message', good);
    clock.nowMs = 15_000; // Deliberately do not run any timer callback.
    workers[0].emit(event, event === 'message' ? good : 0);
    assert.deepEqual(await pending, { status: 'unknown', records: [], reason: 'deadline' });
    if (event === 'message') { workers[0].emit('exit', 1); workers[0].finishTermination(1); }
  }
});

test('deadline includes synchronous worker construction and rechecks parsing', async () => {
  const clock = new FakeClock();
  let worker;
  const controller = createReferenceWorkerControllerForTest({ clock, createWorker() {
    clock.nowMs = 15_000;
    return (worker = new FakeWorker());
  } });
  assert.equal((await controller.fetch()).reason, 'deadline');
  assert.equal(worker.terminations, 1);
  worker.emit('exit', 1);
  worker.finishTermination(1);

  const secondClock = new FakeClock();
  let calls = 0;
  secondClock.now = () => {
    if (++calls === 6) secondClock.nowMs = 15_000; // after bounded JSON.parse
    return secondClock.nowMs;
  };
  let second;
  const other = createReferenceWorkerControllerForTest({ clock: secondClock, createWorker: () => (second = new FakeWorker()) });
  const pending = other.fetch();
  second.emit('message', good);
  second.emit('exit', 0);
  assert.equal((await pending).reason, 'deadline');
});

test('a rejected or contradictory termination permanently fails closed', async () => {
  for (const mode of ['reject', 'different-exit']) {
    const { controller, workers, clock } = harness();
    const pending = controller.fetch();
    clock.advance(15_000);
    assert.equal((await pending).reason, 'deadline');
    workers[0].emit('exit', 1);
    if (mode === 'reject') workers[0].failTermination(new Error('synthetic-secret'));
    else workers[0].finishTermination(0);
    await tick();
    assert.equal((await controller.fetch()).reason, 'busy');
    assert.equal(workers.length, 1);
  }
});

test('an untrustworthy exit status keeps the slot closed', async () => {
  const { controller, workers } = harness();
  const pending = controller.fetch();
  workers[0].emit('message', good);
  workers[0].emit('exit', undefined);
  assert.equal((await pending).status, 'unknown');
  const retry = controller.fetch();
  if (workers[1]) workers[1].emit('exit', 0);
  assert.equal((await retry).reason, 'busy');
  assert.equal(workers.length, 1);
});

test('an exit event alone or a termination resolution alone cannot release a slot', async () => {
  for (const first of ['exit', 'resolve']) {
    const { controller, workers, clock } = harness();
    const pending = controller.fetch();
    clock.advance(15_000);
    assert.equal((await pending).reason, 'deadline');
    if (first === 'exit') workers[0].emit('exit', 1);
    else workers[0].finishTermination(1);
    await tick();
    assert.equal((await controller.fetch()).reason, 'busy');
    if (first === 'exit') workers[0].finishTermination(1);
    else workers[0].emit('exit', 1);
    await tick();
    const retry = controller.fetch();
    workers[1].emit('message', good);
    workers[1].emit('exit', 0);
    assert.equal((await retry).status, 'complete');
  }
});

test('malformed IPC and a non-monotonic or failing clock fail closed', async () => {
  const { controller, workers, clock } = harness();
  clock.nowMs = 20;
  const pending = controller.fetch();
  clock.nowMs = 19;
  workers[0].emit('message', good);
  assert.equal((await pending).reason, 'clock');
  workers[0].emit('exit', 1);
  workers[0].finishTermination(1);
  const failedClock = { now: () => { throw new Error('private clock diagnostic'); },
    setTimeout, clearTimeout };
  const broken = createReferenceWorkerControllerForTest({ clock: failedClock, createWorker: () => { throw new Error('not started'); } });
  assert.deepEqual(await broken.fetch(), { status: 'unknown', records: [], reason: 'clock' });
});

test('IPC counts UTF-8 bytes per record and complete serialized array', async () => {
  const record = JSON.stringify({ x: 'a'.repeat(8_184) }); // 8,192 bytes including object syntax.
  assert.equal(Buffer.byteLength(record), 8_192);
  assert.equal((await fakeExchange(`[${record}]`)).status, 'complete');
  assert.equal((await fakeExchange(JSON.stringify([{ x: 'a'.repeat(8_185) }]))).reason, 'result-limit');
  assert.equal((await fakeExchange(JSON.stringify([{ x: '界'.repeat(2_729) }]))).reason, 'result-limit');
  // Serialized array is 8,388,608 bytes exactly: 1,023 records of 8,192
  // bytes plus delimiters, and a final record of 7,167 bytes.
  const last = JSON.stringify({ x: 'a'.repeat(7_159) });
  const boundary = `[${Array(1023).fill(record).join(',')},${last}]`;
  assert.equal(Buffer.byteLength(boundary), 8 * 1024 * 1024);
  assert.equal((await fakeExchange(boundary)).status, 'complete');
  assert.equal((await fakeExchange(`${boundary} `)).reason, 'result-limit');
});

test('invalid, empty, non-string, malformed and deeply nested results cannot publish', async () => {
  for (const message of [[], {}, '', '[]', '[null]', '[{}] trailing', '[{"x":}]', '[{},]',
    `[${'{"x":'.repeat(129)}0${'}'.repeat(129)}]`]) {
    const result = await fakeExchange(message);
    assert.equal(result.status, 'unknown', String(message).slice(0, 40));
    assert.deepEqual(result.records, []);
  }
});

test('stale generation events cannot poison a subsequent result', async () => {
  const { controller, workers, clock } = harness();
  const first = controller.fetch();
  clock.advance(15_000);
  assert.equal((await first).reason, 'deadline');
  workers[0].emit('exit', 1);
  workers[0].finishTermination(1);
  await tick();
  const second = controller.fetch();
  workers[0].emit('message', '[{"leak":"stale"}]');
  workers[0].emit('error', new Error('stale'));
  workers[1].emit('message', good);
  workers[1].emit('exit', 0);
  assert.deepEqual((await second).records, [{ provider: 'synthetic', modelId: 'fixture' }]);
});

test('errors, late messages, and multi-message floods never expose their content', async () => {
  const secret = 'synthetic-private-token';
  const { controller, workers } = harness();
  const pending = controller.fetch();
  workers[0].emit('message', good);
  for (let i = 0; i < 100; i++) workers[0].emit('message', `[{}]${secret}`);
  workers[0].emit('error', new Error(secret));
  workers[0].emit('exit', 1);
  workers[0].finishTermination(1);
  const result = await pending;
  assert.equal(result.reason, 'protocol-violation');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('request arguments and worker errors never reach the worker or result', async () => {
  const secret = 'synthetic-private-token';
  const url = 'http://private.example.internal';
  const { controller, workers, starts } = harness();
  assert.equal((await controller.fetch({ endpoint: url, authorization: secret })).reason, 'invalid-request');
  assert.equal(starts.length, 0);
  const pending = controller.fetch();
  workers[0].emit('error', new Error(`${secret} ${url}`));
  const result = await pending;
  assert.equal(result.reason, 'worker-error');
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(starts).includes(secret), false);
  assert.equal(JSON.stringify(starts).includes(url), false);
  workers[0].emit('exit', 1);
  workers[0].finishTermination(1);
  assert.equal((await fetchReferenceSnapshot({ endpoint: url, authorization: secret })).reason, 'invalid-request');
});

test('all successful calls create a fresh worker without cache', async () => {
  const { controller, workers } = harness();
  for (let i = 0; i < 2; i++) {
    const pending = controller.fetch();
    workers[i].emit('message', good);
    workers[i].emit('exit', 0);
    assert.equal((await pending).status, 'complete');
  }
  assert.equal(workers.length, 2);
});

test('worker crashes, OOM-style errors and startup errors are unknown', async () => {
  for (const mode of ['oom', 'messageerror', 'no-result']) {
    const { controller, workers } = harness();
    const pending = controller.fetch();
    if (mode === 'oom') workers[0].emit('error', Object.assign(new Error('synthetic OOM secret'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }));
    if (mode === 'messageerror') workers[0].emit('messageerror', new Error('bad payload'));
    if (mode === 'no-result') workers[0].emit('exit', 0);
    const result = await pending;
    assert.equal(result.status, 'unknown');
    assert.deepEqual(result.records, []);
    if (mode !== 'no-result') { workers[0].emit('exit', 1); workers[0].finishTermination(1); }
  }
  const broken = createReferenceWorkerControllerForTest({ createWorker: () => { throw new Error('synthetic-secret'); } });
  assert.deepEqual(await broken.fetch(), { status: 'unknown', records: [], reason: 'worker-start' });
});

function isolatedWorker(source, options) {
  // Test-controlled injection only: production always constructs WORKER_ENTRY.
  return new Worker(source, { ...options, eval: true });
}

test('real isolated worker delivers one record and normally exits', { timeout: 5_000 }, async () => {
  let worker;
  let observedExit = false;
  const controller = createReferenceWorkerControllerForTest({ deadlineMs: 2_000, createWorker(_entry, options) {
    worker = isolatedWorker(`const {parentPort} = require('node:worker_threads'); parentPort.postMessage(${JSON.stringify(good)});`, options);
    worker.once('exit', () => { observedExit = true; });
    return worker;
  } });
  const result = await controller.fetch();
  assert.equal(result.status, 'complete');
  assert.equal(observedExit, true);
  assert.equal(result.records[0].modelId, 'fixture');
});

test('real blocked worker aborts on owner disposal and retry waits for exit', { timeout: 5_000 }, async () => {
  const workers = [];
  let workerExit;
  let onStaged;
  const staged = new Promise(resolve => { onStaged = resolve; });
  const controller = createReferenceWorkerControllerForTest({ deadlineMs: 4_000, createWorker(_entry, options) {
    const source = workers.length === 0
      ? "const {parentPort} = require('node:worker_threads'); parentPort.postMessage('[{\"phase\":\"staged\"}]'); while (true) {}"
      : `const {parentPort} = require('node:worker_threads'); parentPort.postMessage(${JSON.stringify(good)});`;
    const worker = isolatedWorker(source, options);
    workers.push(worker);
    if (workers.length === 1) {
      workerExit = new Promise(resolve => worker.once('exit', resolve));
      worker.once('message', onStaged);
    }
    return worker;
  } });
  const owner = new AbortController();
  const pending = controller.fetchWithSignal(owner.signal);
  await staged;
  owner.abort('disposed');
  assert.deepEqual(await pending, { status: 'unknown', records: [], reason: 'aborted' });
  // A real Worker must emit exit and resolve terminate consistently; only then
  // can a second owner be admitted. Do not infer exit from a rejected result.
  await workerExit;
  await tick();
  const retry = await controller.fetch();
  assert.equal(retry.status, 'complete');
  assert.equal(workers.length, 2);
});

test('real blocked worker is terminated and retry waits for confirmed exit', { timeout: 5_000 }, async () => {
  const workers = [];
  const exited = new Set();
  const controller = createReferenceWorkerControllerForTest({ deadlineMs: 350, createWorker(_entry, options) {
    const source = workers.length === 0
      ? "const {parentPort} = require('node:worker_threads'); parentPort.postMessage('[{\"phase\":\"staged\"}]'); while (true) {}"
      : `const {parentPort} = require('node:worker_threads'); parentPort.postMessage(${JSON.stringify(good)});`;
    const worker = isolatedWorker(source, options);
    workers.push(worker);
    worker.once('exit', () => { exited.add(worker); });
    return worker;
  } });
  const pending = controller.fetch();
  assert.equal((await controller.fetch()).reason, 'busy');
  assert.equal((await pending).reason, 'deadline');
  // Depending on the runtime, the real exit may already have arrived. If it
  // has not, observe refusal; never fabricate an exit from terminate's promise.
  if (!exited.has(workers[0])) assert.equal((await controller.fetch()).reason, 'busy');
  if (!exited.has(workers[0])) await new Promise((resolve) => workers[0].once('exit', resolve));
  await tick(); // allow the terminate promise to settle, as well as the exit
  const retry = await controller.fetch();
  assert.equal(retry.status, 'complete');
  assert.equal(exited.has(workers[0]), true);
  assert.equal(workers.length, 2);
});
