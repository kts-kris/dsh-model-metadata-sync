import { createHash, randomBytes } from 'node:crypto';
import { types } from 'node:util';
import { isSafeMetadataText, isValidModelId, isValidUtcTimestamp } from './metadata-source.js';

const TTL = 300000;
const MAX = 512;
const FIELDS = new Set(['contextWindow', 'maxTokens', 'reasoningEfforts']);
const EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const has = (x, k) => Object.prototype.hasOwnProperty.call(x, k);
const integer = x => Number.isSafeInteger(x) && x >= 0;
const positive = x => Number.isSafeInteger(x) && x > 0;
const refusal = code => ({ error: { code } });
const P = Promise.prototype.then;

// Do not assimilate an untrusted thenable. Observe a real, mistaken rejected
// promise without allowing its eventual result to become authorization.
function exactlyTrue(value) {
  if (value === true) return true;
  if (types.isPromise(value)) P.call(value, () => {}, () => {});
  return false;
}
function data(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.every(k => typeof k === 'string' && keys.includes(k) && has(Object.getOwnPropertyDescriptor(value, k), 'value')) &&
    required.every(k => has(value, k));
}
function array(value, max = 20000) {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > max) return false;
  if (Reflect.ownKeys(value).some(k => k !== 'length' && (typeof k !== 'string' || !/^(0|[1-9]\d*)$/.test(k) || +k >= value.length))) return false;
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    return d && has(d, 'value');
  }).every(Boolean);
}
function canonical(x) {
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
  return JSON.stringify(x);
}
function valueValid(field, value, candidate = false) {
  if (!candidate && (value === null || value === false)) return true;
  if (field !== 'reasoningEfforts') return positive(value);
  if (!data(value, [...EFFORTS], []) || (candidate && !Object.keys(value).some(k => k !== 'off'))) return false;
  return Object.entries(value).every(([k, v]) => k === 'off' && v === null || isSafeMetadataText(v));
}
function sourceValid(s) {
  return data(s, ['kind', 'fetchedAt', 'origin'], ['kind', 'fetchedAt']) &&
    ['upstream', 'reference'].includes(s.kind) && isValidUtcTimestamp(s.fetchedAt) &&
    (!has(s, 'origin') || s.kind === 'reference' && s.origin === 'https://models.dev/api.json');
}
function statusSourceValid(s) {
  return data(s, ['kind', 'status', 'lastAttemptAt', 'reason', 'lookupIdentifiers'], ['kind', 'status']) &&
    ['upstream', 'reference'].includes(s.kind) && ['success', 'unknown', 'disabled', 'error'].includes(s.status) &&
    (!has(s, 'lastAttemptAt') || isValidUtcTimestamp(s.lastAttemptAt)) &&
    (!has(s, 'reason') || isSafeMetadataText(s.reason)) &&
    (!has(s, 'lookupIdentifiers') || array(s.lookupIdentifiers, 3) &&
      s.lookupIdentifiers.every(x => ['provider', 'modelId', 'protocol'].includes(x)));
}
function safeTextTree(value, checker) {
  const stack = [value];
  while (stack.length) {
    const x = stack.pop();
    if (typeof x === 'string' || typeof x === 'number') {
      if (!exactlyTrue(checker(typeof x === 'number' ? JSON.stringify(x) : x))) return false;
    } else if (x && typeof x === 'object') {
      for (const [k, v] of Object.entries(x)) stack.push(k, v);
    } else if (x !== null && typeof x !== 'boolean') return false;
  }
  return exactlyTrue(checker(JSON.stringify(value)));
}
function validView(view, target) {
  if (!data(view, ['provider', 'selectedNewIds', 'items', 'changes', 'warnings', 'sources']) ||
      view.provider !== target.provider || !array(view.selectedNewIds) ||
      !view.selectedNewIds.every(isValidModelId) || new Set(view.selectedNewIds).size !== view.selectedNewIds.length ||
      !array(view.items) || !array(view.changes, 60000) || !array(view.warnings, 100) ||
      !view.warnings.every(isSafeMetadataText) ||
      !data(view.sources, ['upstream', 'reference'], []) || !Object.values(view.sources).every(statusSourceValid)) return false;
  const items = new Map();
  for (const item of view.items) {
    if (!data(item, ['modelId', 'existing', 'applicable', 'reason', 'fields'], ['modelId', 'existing', 'applicable']) ||
        !isValidModelId(item.modelId) || items.has(item.modelId) || typeof item.existing !== 'boolean' ||
        typeof item.applicable !== 'boolean' || (has(item, 'reason') && !isSafeMetadataText(item.reason)) ||
        (has(item, 'fields') && !array(item.fields, 3))) return false;
    const fields = new Set();
    for (const field of item.fields ?? []) {
      if (!data(field, ['field', 'state', 'reason', 'before', 'candidate', 'source'], ['field', 'state', 'reason']) ||
          !FIELDS.has(field.field) || fields.has(field.field) ||
          !['applicable', 'unchanged', 'conflict', 'unknown'].includes(field.state) || !isSafeMetadataText(field.reason) ||
          (has(field, 'before') && !valueValid(field.field, field.before)) ||
          (has(field, 'candidate') && !valueValid(field.field, field.candidate, true)) ||
          (has(field, 'source') && !sourceValid(field.source)) ||
          (field.state === 'applicable' && (!has(field, 'candidate') || !has(field, 'source')))) return false;
      fields.add(field.field);
    }
    items.set(item.modelId, item);
  }
  const additions = [];
  const mutations = new Set();
  for (const change of view.changes) {
    if (!data(change, ['type', 'scope', 'modelId', 'index', 'field', 'value'], ['type', 'modelId']) || !isValidModelId(change.modelId)) return false;
    const item = items.get(change.modelId);
    if (!item) return false;
    if (change.type === 'add-model') {
      if (Object.keys(change).length !== 2 || target.mode !== 'models' || item.existing || !item.applicable || additions.includes(change.modelId)) return false;
      additions.push(change.modelId);
    } else if (change.type === 'set-field') {
      // `additions` contains only additions already encountered. A write for a
      // new model must follow its own addition, without reordering the preview.
      if (!data(change, ['type', 'scope', 'modelId', 'index', 'field', 'value'],
        target.mode === 'models' ? ['type', 'scope', 'modelId', 'index', 'field', 'value'] : ['type', 'scope', 'modelId', 'field', 'value']) ||
          change.scope !== target.mode || !FIELDS.has(change.field) || !valueValid(change.field, change.value, true) ||
          (target.mode === 'models' ? !integer(change.index) : has(change, 'index')) ||
          (target.mode === 'modelOverrides' && !item.existing) ||
          (target.mode === 'models' && !item.existing && !additions.includes(change.modelId))) return false;
      const key = `${change.modelId}\0${change.field}`;
      const shown = item.fields?.find(x => x.field === change.field);
      if (mutations.has(key) || !shown || shown.state !== 'applicable' || canonical(shown.candidate) !== canonical(change.value)) return false;
      mutations.add(key);
    } else return false;
  }
  if (target.mode === 'models' && canonical(additions) !== canonical(view.selectedNewIds)) return false;
  if (target.mode === 'modelOverrides' && additions.length) return false;
  for (const change of view.changes) if (change.type === 'set-field' && target.mode === 'models') {
    const item = items.get(change.modelId);
    if (item.existing ? change.index >= target.modelCount :
      !additions.includes(change.modelId) || change.index !== target.modelCount + additions.indexOf(change.modelId)) return false;
  }
  return true;
}
function makeOps(target, view) {
  let next = target.modelCount;
  return view.changes.map(c => c.type === 'add-model'
    ? { op: 'set', path: [...target.providerPath, 'models', String(next++)], value: { id: c.modelId } }
    : { op: 'set', path: [...target.providerPath, c.scope, c.scope === 'models' ? String(c.index) : c.modelId, c.field], value: c.value });
}
function binding(snapshot, checkText) {
  if (!data(snapshot, ['revision', 'secretGeneration', 'evidence', 'proof', 'facts', 'target', 'view']) ||
      !integer(snapshot.revision) || !integer(snapshot.secretGeneration) || !snapshot.evidence ||
      !data(snapshot.proof, ['owner', 'target', 'source', 'sourceFresh', 'writerInactive', 'effectiveComplete', 'protectionComplete', 'secretGeneration']) ||
      Object.values(snapshot.proof).some(x => x !== true)) return null;
  const f = snapshot.facts;
  if (!data(f, ['effectiveRevision', 'protectionRevision', 'sourceRevision', 'writerRevision', 'targetRevision', 'explicitModels']) ||
      ['effectiveRevision', 'protectionRevision', 'sourceRevision', 'writerRevision', 'targetRevision'].some(k => f[k] !== snapshot.revision) ||
      typeof f.explicitModels !== 'boolean') return null;
  const t = snapshot.target;
  if (!data(t, ['namespace', 'providerPath', 'provider', 'endpointFingerprint', 'protocol', 'mode', 'modelCount']) ||
      !isValidModelId(t.namespace) || !isValidModelId(t.provider) || !array(t.providerPath, 20) || !t.providerPath.length ||
      !t.providerPath.every(isValidModelId) || !/^[a-f0-9]{64}$/.test(t.endpointFingerprint) ||
      t.protocol !== 'openai-completions' || !['models', 'modelOverrides'].includes(t.mode) || !integer(t.modelCount) ||
      (t.mode === 'models') !== f.explicitModels || !validView(snapshot.view, t)) return null;
  const stable = structuredClone({ secretGeneration: snapshot.secretGeneration, target: t, view: snapshot.view,
    facts: { explicitModels: f.explicitModels }, proof: snapshot.proof });
  if (!safeTextTree(stable.view, checkText)) return null;
  return { stable, revision: snapshot.revision, snapshot };
}

/**
 * Synthetic-only Host seam. The returned `host` facet MUST remain private to
 * trusted Host code: its register argument is an immutable capability checked
 * by `resolvePreview` and `verifySnapshot`, never a client-supplied object.
 * The `client` facet takes only a Host-authenticated owner and an ID/digest.
 *
 * resolvePreview(ownerIdentity, capability) and recompute(...) produce opaque
 * Host snapshots; verifySnapshot must strictly authenticate their provenance,
 * owner, immutable capability, completeness, identities and source evidence.
 * Static true flags by themselves are NOT evidence. `validateAtomic` must
 * verify every binding/proof and current revision/secret generation/original
 * writer under the very same exclusion/transaction as the following write.
 * `commit` MUST synchronously call request.authorize() exactly at the atomic
 * decision point, and only then apply request.ops with settings.mutate CAS.
 * `classifyCommit` must strictly classify only Host-authenticated receipts as
 * applied or a CAS conflict conclusively proving no write; every other result
 * is unknown, including lost acknowledgements and arbitrary exceptions.
 *
 * The real installed DSH API has not demonstrated these combined guarantees.
 * No production adapter, HTTP handler, credentials access, settings access or
 * network is installed here. Supplying callbacks does not prove these duties.
 */
export function createApplyAuthority({ ownerIdentity, resolvePreview, recompute, verifySnapshot,
  validateAtomic, safeProjection, commit, classifyCommit, clock = Date.now } = {}) {
  if (![ownerIdentity, resolvePreview, recompute, verifySnapshot, validateAtomic, safeProjection, commit, classifyCommit, clock]
    .every(fn => typeof fn === 'function')) throw new TypeError('Trusted Host dependencies are required.');
  const pending = new Map();
  const used = new WeakSet();
  let active = true;
  let lastTime = 0;
  function time() {
    const t = clock();
    if (!integer(t) || t < lastTime || t > 253402300799999 - TTL) throw new Error('Invalid Host clock');
    lastTime = t;
    return t;
  }
  function ownerOf(owner) {
    const identity = ownerIdentity(owner);
    return (typeof identity === 'string' && identity.length > 0) ||
      (identity !== null && typeof identity === 'object' && !types.isProxy(identity) && Object.isFrozen(identity)) ? identity : null;
  }
  function validSnapshot(owner, capability, snapshot) {
    if (!exactlyTrue(verifySnapshot(owner, capability, snapshot))) return null;
    return binding(snapshot, safeProjection);
  }
  async function register(owner, capability) {
    try {
      const identity = ownerOf(owner);
      if (!active || !identity || !capability || typeof capability !== 'object' || types.isProxy(capability) ||
          !Object.isFrozen(capability) || used.has(capability)) return refusal('REPREVIEW_REQUIRED');
      used.add(capability);
      const raw = await resolvePreview(identity, capability);
      if (!active) return refusal('REPREVIEW_REQUIRED');
      const bound = validSnapshot(identity, capability, raw);
      if (!bound) return refusal('SETTINGS_UNAVAILABLE');
      const now = time();
      for (const [id, entry] of pending) if (entry.expires <= now && entry.status === 'pending') pending.delete(id);
      if (pending.size >= MAX) return refusal('SETTINGS_UNAVAILABLE');
      const id = randomBytes(32).toString('base64url');
      if (pending.has(id)) return refusal('SETTINGS_UNAVAILABLE');
      const digest = createHash('sha256').update(canonical({ revision: bound.revision, ...bound.stable })).digest('hex');
      const result = { previewId: id, digest, expiresAt: new Date(now + TTL).toISOString(), view: bound.stable.view };
      if (!safeTextTree(result, safeProjection)) return refusal('SETTINGS_UNAVAILABLE');
      pending.set(id, { identity, capability, bound, digest, expires: now + TTL, status: 'pending' });
      return structuredClone(result);
    } catch { return refusal('SETTINGS_UNAVAILABLE'); }
  }
  function cancel(owner, request) {
    try {
      const identity = ownerOf(owner);
      if (!active || !identity || !data(request, ['previewId']) || typeof request.previewId !== 'string') return { status: 'not-found' };
      const entry = pending.get(request.previewId);
      // A reserved apply may already have written before its acknowledgement.
      // Never claim to cancel it or disturb its one-use authorization state.
      if (!entry || entry.identity !== identity || entry.status !== 'pending' || time() >= entry.expires) return { status: 'not-found' };
      pending.delete(request.previewId);
      return { status: 'cancelled' };
    } catch { return { status: 'not-found' }; }
  }
  async function apply(owner, request) {
    let entry, id;
    let reserved = false;
    try {
      const identity = ownerOf(owner);
      if (!active || !identity || !data(request, ['previewId', 'digest']) ||
          typeof request.previewId !== 'string' || typeof request.digest !== 'string') return refusal('REPREVIEW_REQUIRED');
      id = request.previewId;
      entry = pending.get(id);
      if (!entry || entry.identity !== identity || entry.status !== 'pending') return refusal('REPREVIEW_REQUIRED');
      // No await before the reservation: all attempts from this owner, including
      // wrong digests, consume the one-use consent. Other owners cannot consume it.
      entry.status = 'reserved';
      reserved = true;
      if (time() >= entry.expires || request.digest !== entry.digest) return refusal('REPREVIEW_REQUIRED');
      let current = entry.bound;
      const approved = canonical(current.stable);
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!active || pending.get(id) !== entry || time() >= entry.expires) return refusal('REPREVIEW_REQUIRED');
        let authorized = false;
        const requestToHost = Object.freeze({ expectedRevision: current.revision, namespace: current.stable.target.namespace,
          ops: structuredClone(makeOps(current.stable.target, current.stable.view)),
          authorize: () => {
            if (authorized) return false;
            try {
              if (!active || pending.get(id) !== entry || time() >= entry.expires ||
                  !exactlyTrue(validateAtomic(identity, entry.capability, current.snapshot,
                    structuredClone(current.stable), current.revision))) return false;
              authorized = true;
              return true;
            } catch { return false; }
          } });
        let receipt, thrown;
        try { receipt = await commit(requestToHost); } catch (error) { thrown = error; }
        const classification = classifyCommit(receipt, thrown);
        if (classification === 'applied' && authorized) return { status: current.stable.view.changes.length ? 'applied' : 'unchanged' };
        if (classification !== 'conflict-no-write') return refusal('SETTINGS_UNAVAILABLE');
        if (attempt === 2) return refusal('REVISION_CONFLICT');
        if (!active || pending.get(id) !== entry || time() >= entry.expires) return refusal('REPREVIEW_REQUIRED');
        const next = validSnapshot(identity, entry.capability, await recompute(identity, entry.capability));
        if (!next) return refusal('SETTINGS_UNAVAILABLE');
        if (canonical(next.stable) !== approved) return refusal('REPREVIEW_REQUIRED');
        current = next;
      }
      return refusal('REVISION_CONFLICT');
    } catch { return refusal('SETTINGS_UNAVAILABLE'); }
    finally { if (reserved && pending.get(id) === entry) pending.delete(id); }
  }
  function unload() { active = false; pending.clear(); }
  return Object.freeze({ host: Object.freeze({ register }), client: Object.freeze({ apply, cancel }), unload });
}
