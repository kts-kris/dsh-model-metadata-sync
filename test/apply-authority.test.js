import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplyAuthority } from '../lib/apply-authority.js';

// Synthetic Host only: no profile, real credentials or network. Its identity
// registries and atomic hook model guarantees that real DSH has not established.
function fixture(options = {}) {
  const owner = Object.freeze({});
  const otherOwner = Object.freeze({});
  const otherIdentity = Object.freeze({});
  const identity = Object.freeze({});
  const capability = Object.freeze({});
  const evidence = Object.freeze({});
  let now = 1000;
  let revision = 7;
  let secretGeneration = 4;
  let commits = 0;
  const hostOperations = [];
  let recomputes = 0;
  let conflicts = options.conflicts ?? 0;
  let released, notifyWrite, releaseAck;
  const block = options.blockCommit ? new Promise(resolve => { released = resolve; }) : null;
  const writeReached = options.blockAfterWrite ? new Promise(resolve => { notifyWrite = resolve; }) : null;
  const ackBlocked = options.blockAfterWrite ? new Promise(resolve => { releaseAck = resolve; }) : null;
  const state = { providers: [{ models: [{ id: 'm', input: null, reasoningEfforts: false, unrelated: { keep: 1 } }] }],
    credential: 'synthetic-secret' };
  const proof = { owner: true, target: true, source: true, sourceFresh: true, writerInactive: true,
    effectiveComplete: true, protectionComplete: true, secretGeneration: true };
  const snapshot = () => ({ revision, secretGeneration, evidence,
    proof: { ...proof }, facts: { explicitModels: true, effectiveRevision: revision, protectionRevision: revision,
      sourceRevision: revision, writerRevision: revision, targetRevision: revision },
    target: { namespace: 'synthetic', providerPath: ['providers', '0'], provider: 'sample',
      endpointFingerprint: 'a'.repeat(64), protocol: 'openai-completions', mode: 'models', modelCount: 1 },
    view: { provider: 'sample', selectedNewIds: [], items: [{ modelId: 'm', existing: true, applicable: true,
      fields: [{ field: 'contextWindow', state: 'applicable', reason: 'absent', before: null, candidate: 64000,
        source: { kind: 'upstream', fetchedAt: '2026-11-25T03:00:00.000Z' } }] }],
      changes: [{ type: 'set-field', scope: 'models', modelId: 'm', index: 0, field: 'contextWindow', value: 64000 }],
      warnings: [], sources: { upstream: { kind: 'upstream', status: 'success', lastAttemptAt: '2026-11-25T03:00:00.000Z' } } } });
  const trusted = new WeakSet();
  function issueSnapshot() {
    const value = snapshot();
    if (recomputes && options.change) options.change(value);
    if (options.snapshot) options.snapshot(value);
    trusted.add(value);
    return value;
  }
  const accepted = new WeakSet();
  const casConflicts = new WeakSet();
  const receipt = set => { const value = Object.freeze({}); set.add(value); return value; };
  const authority = createApplyAuthority({
    ownerIdentity: value => value === owner ? identity : value === otherOwner ? otherIdentity : undefined,
    resolvePreview: (who, token) => who === identity && token === capability ? issueSnapshot() : null,
    recompute: () => { recomputes++; return issueSnapshot(); },
    verifySnapshot: (who, token, value) => who === identity && token === capability && trusted.has(value) && value.evidence === evidence,
    validateAtomic: (who, token, value, approved, expectedRevision) => who === identity && token === capability &&
      trusted.has(value) && expectedRevision === revision && secretGeneration === value.secretGeneration &&
      Object.values(proof).every(x => x === true) && approved.view.changes.every(change =>
        change.type !== 'set-field' || change.scope !== 'models' || !approved.view.items.find(item => item.modelId === change.modelId).existing ||
        state.providers[0].models[change.index]?.id === change.modelId),
    safeProjection: text => !text.includes('synthetic-secret'),
    commit: async request => {
      commits++;
      if (block) await block;
      if (conflicts > 0) {
        conflicts--;
        revision++;
        state.unrelated = revision;
        return receipt(casConflicts);
      }
      if (request.expectedRevision !== revision || !request.authorize()) return null;
      hostOperations.push(structuredClone(request.ops));
      for (const op of request.ops) {
        assert.equal(op.op, 'set');
        let target = state;
        for (const part of op.path.slice(0, -1)) {
          if (target[part] === undefined) target[part] = {};
          target = target[part];
        }
        target[op.path.at(-1)] = structuredClone(op.value);
      }
      revision++;
      if (ackBlocked) { notifyWrite(); await ackBlocked; }
      if (options.lostAck) throw Error('synthetic-secret in lost acknowledgement');
      return receipt(accepted);
    },
    classifyCommit: value => accepted.has(value) ? 'applied' : casConflicts.has(value) ? 'conflict-no-write' : 'unknown',
    clock: () => now,
  });
  return { authority, owner, otherOwner, capability, state, proof, hostOperations, release: () => released?.(),
    writeReached, releaseAck: () => releaseAck?.(),
    counts: () => ({ commits, recomputes }), setTime: value => { now = value; },
    rotateSecret: () => { secretGeneration++; } };
}
const register = f => f.authority.host.register(f.owner, f.capability);
const apply = (f, p, owner = f.owner) => f.authority.client.apply(owner, { previewId: p.previewId, digest: p.digest });
const error = result => result.error?.code;

test('one approved exact preview commits only a path and preserves unrelated data', async () => {
  const f = fixture();
  const preview = await register(f);
  assert.equal(preview?.view?.provider, 'sample');
  assert.match(preview?.digest ?? '', /^[a-f0-9]{64}$/);
  assert.equal(preview.expiresAt, '1970-01-01T00:05:01.000Z');
  assert.deepEqual(await apply(f, preview), { status: 'applied' });
  assert.deepEqual(f.state, { providers: [{ models: [{ id: 'm', input: null, reasoningEfforts: false,
    unrelated: { keep: 1 }, contextWindow: 64000 }] }], credential: 'synthetic-secret' });
});

test('unforgeable Host capability and owner isolation; other owner cannot consume', async () => {
  const f = fixture();
  assert.equal(error(await f.authority.host.register(f.owner, Object.freeze({}))), 'SETTINGS_UNAVAILABLE');
  const p = await register(f);
  assert.equal(error(await apply(f, p, f.otherOwner)), 'REPREVIEW_REQUIRED');
  assert.equal(error(await f.authority.client.apply(f.owner, { previewId: 'unknown', digest: p.digest })), 'REPREVIEW_REQUIRED');
  assert.deepEqual(await apply(f, p), { status: 'applied' });
  assert.equal(error(await apply(f, p)), 'REPREVIEW_REQUIRED');
  assert.equal(error(await register(f)), 'REPREVIEW_REQUIRED');
  assert.equal('register' in f.authority.client, false);
});

test('two concurrent clicks on the same token have one winner', async () => {
  const f = fixture({ blockCommit: true });
  const p = await register(f);
  const first = apply(f, p);
  const second = await apply(f, p);
  assert.equal(error(second), 'REPREVIEW_REQUIRED');
  f.release();
  assert.deepEqual(await first, { status: 'applied' });
  assert.deepEqual(f.counts(), { commits: 1, recomputes: 0 });
});

for (const lostAck of [false, true]) {
  test(`cancel cannot claim to revoke an authorized write awaiting ${lostAck ? 'a lost' : 'an applied'} receipt`, async () => {
    const f = fixture({ blockAfterWrite: true, lostAck });
    const p = await register(f);
    const pending = apply(f, p);
    await f.writeReached;
    const valueAtBarrier = f.state.providers[0].models[0].contextWindow;
    const otherCancellation = f.authority.client.cancel(f.otherOwner, { previewId: p.previewId });
    const cancellation = f.authority.client.cancel(f.owner, { previewId: p.previewId });
    // Always unblock the in-flight task before asserting so a failure cannot
    // strand the fake Host or hide its final receipt classification.
    f.releaseAck();
    const result = await pending;
    assert.equal(valueAtBarrier, 64000);
    assert.deepEqual(otherCancellation, { status: 'not-found' });
    assert.deepEqual(cancellation, { status: 'not-found' });
    assert.deepEqual(result, lostAck ? { error: { code: 'SETTINGS_UNAVAILABLE' } } : { status: 'applied' });
    assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
    assert.equal(error(await apply(f, p)), 'REPREVIEW_REQUIRED');
    assert.deepEqual(f.counts(), { commits: 1, recomputes: 0 });
  });
}

test('cancel cannot consume a reserved preview even before the atomic decision', async () => {
  const f = fixture({ blockCommit: true });
  const p = await register(f);
  const pending = apply(f, p);
  const otherCancellation = f.authority.client.cancel(f.otherOwner, { previewId: p.previewId });
  const cancellation = f.authority.client.cancel(f.owner, { previewId: p.previewId });
  f.release();
  const result = await pending;
  assert.deepEqual(otherCancellation, { status: 'not-found' });
  assert.deepEqual(cancellation, { status: 'not-found' });
  assert.deepEqual(result, { status: 'applied' });
  assert.equal(f.state.providers[0].models[0].contextWindow, 64000);
  assert.deepEqual(f.counts(), { commits: 1, recomputes: 0 });
});

test('expiry, cancel and unload prevent writes, including an in-flight reservation', async () => {
  let f = fixture();
  let p = await register(f);
  f.setTime(301000);
  assert.equal(error(await apply(f, p)), 'REPREVIEW_REQUIRED');
  f = fixture(); p = await register(f);
  assert.deepEqual(f.authority.client.cancel(f.otherOwner, { previewId: p.previewId }), { status: 'not-found' });
  assert.deepEqual(f.authority.client.cancel(f.owner, { previewId: p.previewId }), { status: 'cancelled' });
  assert.equal(error(await apply(f, p)), 'REPREVIEW_REQUIRED');
  f = fixture({ blockCommit: true }); p = await register(f);
  const pending = apply(f, p); f.authority.unload(); f.release();
  assert.equal(error(await pending), 'SETTINGS_UNAVAILABLE');
  assert.equal(f.state.providers[0].models[0].contextWindow, undefined);
});

test('a new model field preceding its own addition is refused before any write', async () => {
  const f = fixture({ snapshot: s => {
    s.view.selectedNewIds = ['new-a'];
    s.view.items.push({ modelId: 'new-a', existing: false, applicable: true,
      fields: [{ field: 'contextWindow', state: 'applicable', reason: 'absent', candidate: 32000,
        source: { kind: 'upstream', fetchedAt: '2026-11-25T03:00:00.000Z' } }] });
    s.view.changes = [
      { type: 'set-field', scope: 'models', modelId: 'new-a', index: 1, field: 'contextWindow', value: 32000 },
      { type: 'add-model', modelId: 'new-a' },
    ];
  } });
  const p = await register(f);
  // On the broken implementation, demonstrate the real Host write rather than
  // stopping at the unexpectedly accepted preview: set creates the model, and
  // the later add overwrites its field.
  const erroneousApply = p.previewId ? await apply(f, p) : null;
  assert.deepEqual(p, { error: { code: 'SETTINGS_UNAVAILABLE' } },
    `invalid ordering must be refused, not committed as ${JSON.stringify(erroneousApply)} to ${JSON.stringify(f.state.providers[0].models)}`);
  assert.deepEqual(f.counts(), { commits: 0, recomputes: 0 });
  assert.deepEqual(f.state.providers[0].models, [{ id: 'm', input: null, reasoningEfforts: false, unrelated: { keep: 1 } }]);
});

test('several new models retain fields when their additions precede their fields', async () => {
  const f = fixture({ snapshot: s => {
    s.view.selectedNewIds = ['new-a', 'new-b'];
    s.view.items.push(...[
      ['new-a', 'contextWindow', 32000], ['new-b', 'maxTokens', 8192],
    ].map(([modelId, field, candidate]) => ({ modelId, existing: false, applicable: true,
      fields: [{ field, state: 'applicable', reason: 'absent', candidate,
        source: { kind: 'upstream', fetchedAt: '2026-11-25T03:00:00.000Z' } }] })));
    // Interleave fields for old/new entries to ensure we preserve, rather than
    // silently reorder, the exact approved operations.
    s.view.changes = [
      { type: 'add-model', modelId: 'new-a' },
      { type: 'set-field', scope: 'models', modelId: 'm', index: 0, field: 'contextWindow', value: 64000 },
      { type: 'add-model', modelId: 'new-b' },
      { type: 'set-field', scope: 'models', modelId: 'new-b', index: 2, field: 'maxTokens', value: 8192 },
      { type: 'set-field', scope: 'models', modelId: 'new-a', index: 1, field: 'contextWindow', value: 32000 },
    ];
  } });
  const p = await register(f);
  assert.deepEqual(await apply(f, p), { status: 'applied' });
  assert.deepEqual(f.state.providers[0].models, [
    { id: 'm', input: null, reasoningEfforts: false, unrelated: { keep: 1 }, contextWindow: 64000 },
    { id: 'new-a', contextWindow: 32000 },
    { id: 'new-b', maxTokens: 8192 },
  ]);
  assert.deepEqual(f.hostOperations, [[
    { op: 'set', path: ['providers', '0', 'models', '1'], value: { id: 'new-a' } },
    { op: 'set', path: ['providers', '0', 'models', '0', 'contextWindow'], value: 64000 },
    { op: 'set', path: ['providers', '0', 'models', '2'], value: { id: 'new-b' } },
    { op: 'set', path: ['providers', '0', 'models', '2', 'maxTokens'], value: 8192 },
    { op: 'set', path: ['providers', '0', 'models', '1', 'contextWindow'], value: 32000 },
  ]]);
});

test('one new model addition does not authorize another model\'s earlier field', async () => {
  const f = fixture({ snapshot: s => {
    s.view.selectedNewIds = ['new-a', 'new-b'];
    s.view.items.push({ modelId: 'new-a', existing: false, applicable: true },
      { modelId: 'new-b', existing: false, applicable: true,
        fields: [{ field: 'maxTokens', state: 'applicable', reason: 'absent', candidate: 8192,
          source: { kind: 'upstream', fetchedAt: '2026-11-25T03:00:00.000Z' } }] });
    s.view.changes = [
      { type: 'add-model', modelId: 'new-a' },
      { type: 'set-field', scope: 'models', modelId: 'new-b', index: 2, field: 'maxTokens', value: 8192 },
      { type: 'add-model', modelId: 'new-b' },
    ];
  } });
  assert.deepEqual(await register(f), { error: { code: 'SETTINGS_UNAVAILABLE' } });
  assert.deepEqual(f.counts(), { commits: 0, recomputes: 0 });
  assert.deepEqual(f.hostOperations, []);
});

test('a retry refuses a newly malformed field-before-add snapshot without writing', async () => {
  const f = fixture({ conflicts: 1, snapshot: s => {
    s.view.selectedNewIds = ['new-a'];
    s.view.items.push({ modelId: 'new-a', existing: false, applicable: true,
      fields: [{ field: 'contextWindow', state: 'applicable', reason: 'absent', candidate: 32000,
        source: { kind: 'upstream', fetchedAt: '2026-11-25T03:00:00.000Z' } }] });
    s.view.changes = [
      { type: 'add-model', modelId: 'new-a' },
      { type: 'set-field', scope: 'models', modelId: 'new-a', index: 1, field: 'contextWindow', value: 32000 },
    ];
    // `snapshot` is also applied on recomputation in this fixture, so place the
    // malformed order in that callback below, after building the full view.
    if (s.revision > 7) s.view.changes.reverse();
  } });
  const p = await register(f);
  assert.deepEqual(await apply(f, p), { error: { code: 'SETTINGS_UNAVAILABLE' } });
  assert.deepEqual(f.counts(), { commits: 1, recomputes: 1 });
  assert.deepEqual(f.hostOperations, []);
  assert.deepEqual(f.state.providers[0].models, [{ id: 'm', input: null, reasoningEfforts: false, unrelated: { keep: 1 } }]);
});

test('only proven no-write conflicts retry: stable unrelated revisions succeed by attempt three', async () => {
  const f = fixture({ conflicts: 2 });
  const p = await register(f);
  assert.deepEqual(await apply(f, p), { status: 'applied' });
  assert.deepEqual(f.counts(), { commits: 3, recomputes: 2 });
  assert.equal(f.state.unrelated, 9);
  assert.equal(f.state.credential, 'synthetic-secret');
  const exhausted = fixture({ conflicts: 3 });
  const q = await register(exhausted);
  assert.equal(error(await apply(exhausted, q)), 'REVISION_CONFLICT');
  assert.deepEqual(exhausted.counts(), { commits: 3, recomputes: 2 });
  assert.equal(exhausted.state.providers[0].models[0].contextWindow, undefined);
});

test('changed displayed diff, target, source, selection, facts or generation aborts recomputation', async () => {
  const changes = [
    s => { s.view.items[0].fields[0].candidate = 32000; s.view.changes[0].value = 32000; },
    s => { s.target.endpointFingerprint = 'b'.repeat(64); },
    s => { s.view.sources.upstream.lastAttemptAt = '2026-11-25T03:01:00.000Z'; },
    s => { s.view.selectedNewIds = ['new']; s.view.items.push({ modelId: 'new', existing: false, applicable: true }); s.view.changes.push({ type: 'add-model', modelId: 'new' }); },
    s => { s.secretGeneration++; },
  ];
  for (const change of changes) {
    const f = fixture({ conflicts: 1, change });
    const p = await register(f);
    assert.equal(error(await apply(f, p)), 'REPREVIEW_REQUIRED');
    assert.deepEqual(f.counts(), { commits: 1, recomputes: 1 });
    assert.equal(f.state.providers[0].models[0].contextWindow, undefined);
  }
});

test('lost acknowledgement may have written but is never replayed or leaked', async () => {
  const f = fixture({ lostAck: true });
  const p = await register(f);
  const result = await apply(f, p);
  assert.equal(error(result), 'SETTINGS_UNAVAILABLE');
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
  assert.equal(f.state.providers[0].models[0].contextWindow, 64000);
  assert.equal(error(await apply(f, p)), 'REPREVIEW_REQUIRED');
  assert.deepEqual(f.counts(), { commits: 1, recomputes: 0 });
});

test('uncertain original writer, incomplete proofs and generation rotation block the commit', async () => {
  for (const key of ['owner', 'target', 'source', 'sourceFresh', 'writerInactive', 'effectiveComplete', 'protectionComplete', 'secretGeneration']) {
    const f = fixture();
    f.proof[key] = false;
    assert.equal(error(await register(f)), 'SETTINGS_UNAVAILABLE', key);
    assert.deepEqual(f.counts(), { commits: 0, recomputes: 0 });
  }
  const f = fixture(); const p = await register(f);
  f.proof.writerInactive = false;
  assert.equal(error(await apply(f, p)), 'SETTINGS_UNAVAILABLE');
  assert.equal(f.state.providers[0].models[0].contextWindow, undefined);
  const rotated = fixture(); const q = await register(rotated); rotated.rotateSecret();
  assert.equal(error(await apply(rotated, q)), 'SETTINGS_UNAVAILABLE');
  assert.equal(rotated.state.providers[0].models[0].contextWindow, undefined);
});

test('an exact-ID/index mismatch fails the atomic Host check even when index is in range', async () => {
  const f = fixture();
  const p = await register(f);
  f.state.providers[0].models[0].id = 'different-model';
  assert.equal(error(await apply(f, p)), 'SETTINGS_UNAVAILABLE');
  assert.equal(f.state.providers[0].models[0].contextWindow, undefined);
});

test('same-revision evidence mismatch and unapproved extra client fields are refused', async () => {
  const invalid = fixture({ snapshot: s => { s.facts.effectiveRevision--; } });
  assert.equal(error(await register(invalid)), 'SETTINGS_UNAVAILABLE');
  const f = fixture(); const p = await register(f);
  const result = await f.authority.client.apply(f.owner, { previewId: p.previewId, digest: p.digest, target: {} });
  assert.equal(error(result), 'REPREVIEW_REQUIRED');
  assert.deepEqual(await apply(f, p), { status: 'applied' });
});
