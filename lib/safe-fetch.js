// A Host-only network boundary. Neither raw bodies nor these returned values are
// suitable for clients: callers must validate and project source metadata first.
const MAX_BYTES = 4 * 1024 * 1024;
// Cap both the scanner's recursion and its simultaneously live key sets.
const MAX_JSON_DEPTH = 128;
// Prevent tiny or empty chunks from turning the byte bound into unbounded
// per-chunk allocations or an endless chain of immediately resolved reads.
const MAX_BODY_CHUNKS = 65_536;
const MAX_PAGES = 20;
const MAX_RETRIES = 3;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const ERROR_MESSAGES = Object.freeze({
  ORIGIN_REFUSED: 'Network target refused.',
  INCOMPLETE_RESPONSE: 'Source response incomplete or unavailable.',
  INVALID_RESPONSE: 'Source response invalid.',
});

function failure(code) {
  return { ok: false, error: { code, message: ERROR_MESSAGES[code] } };
}
function internal(code, retryable = false) {
  return { code, retryable };
}
function cancelBody(body) {
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* cleanup only */ }
}
function isLoopback(url) {
  return url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
}
function headerSecrets(headers) {
  const values = new Set();
  const add = value => { if (value) values.add(value); };
  for (const [, value] of new Headers(headers)) {
    add(value);
    const token = /^(bearer|basic)\s+(.+)$/i.exec(value);
    if (token) {
      add(token[2]);
      if (token[1].toLowerCase() === 'basic') {
        const encoded = token[2];
        const decoded = Buffer.from(encoded, 'base64').toString('utf8');
        if (decoded.includes(':')) {
          const separator = decoded.indexOf(':');
          add(decoded);
          add(decoded.slice(0, separator));
          add(decoded.slice(separator + 1));
        }
      }
    }
    // Cookie-like or custom compound headers can contain a raw secret in one
    // field, independently of whether their name resembles an auth header.
    for (const part of value.split(';')) {
      const equals = part.indexOf('=');
      if (equals > 0) add(part.slice(equals + 1).trim().replace(/^"|"$/g, ''));
    }
  }
  return [...values];
}
function containsSecret(value, secrets) {
  if (typeof value !== 'string') return false;
  return secrets.some(secret => value.includes(secret));
}
function safeUrl(value, base, allowedOrigin, secrets) {
  const url = new URL(value, base);
  if (url.origin !== allowedOrigin || url.username || url.password || url.hash) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url))) return null;
  if (containsSecret(decodeURIComponent(url.pathname), secrets)) return null;
  for (const [name, item] of url.searchParams) {
    if (/token|secret|auth|pass|credential|api.?key|signature/i.test(name)) return null;
    if (containsSecret(name, secrets) || containsSecret(item, secrets)) return null;
  }
  return url;
}
function hasSecretInJson(root, secrets) {
  if (!secrets.length) return false;
  const stack = [root];
  while (stack.length) {
    const value = stack.pop();
    if (typeof value === 'string' && containsSecret(value, secrets)) return true;
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (containsSecret(key, secrets)) return true;
        stack.push(child);
      }
    }
  }
  return false;
}

// JSON.parse is the final syntax/Unicode authority, but discards duplicate
// keys. Walk the bounded text before constructing the parsed value: check the
// structural grammar and nesting, and independently decode each key with
// JSON.parse. This matches its UTF-16/escape equality even for surrogate pairs.
// The final parse validates primitive and non-key string syntax. Each code unit
// is visited a constant number of times (Set operations are expected O(1));
// memory is O(input size), and recursion is capped at MAX_JSON_DEPTH.
function rejectDuplicateJsonKeys(text) {
  let position = 0;
  const invalid = () => { throw new SyntaxError('Invalid or ambiguous JSON'); };
  const whitespace = () => {
    while (text[position] === ' ' || text[position] === '\n' || text[position] === '\r' || text[position] === '\t') position++;
  };
  const stringEnd = () => {
    if (text[position] !== '"') invalid();
    const start = position++;
    while (position < text.length) {
      const character = text[position++];
      if (character === '"') return start;
      if (character === '\\') position++; // Invalid escapes are rejected by JSON.parse.
    }
    return invalid();
  };
  const value = depth => {
    whitespace();
    const character = text[position];
    if (character === '{' || character === '[') {
      if (depth >= MAX_JSON_DEPTH) invalid();
      const object = character === '{';
      const close = object ? '}' : ']';
      const keys = object ? new Set() : null;
      position++;
      whitespace();
      if (text[position] === close) { position++; return; }
      for (;;) {
        if (object) {
          const start = stringEnd();
          const key = JSON.parse(text.slice(start, position));
          if (keys.has(key)) invalid();
          keys.add(key);
          whitespace();
          if (text[position++] !== ':') invalid();
        }
        value(depth + 1);
        whitespace();
        if (text[position] === close) { position++; return; }
        if (text[position++] !== ',') invalid();
        whitespace();
      }
    }
    if (character === '"') { stringEnd(); return; }
    const start = position;
    while (position < text.length && !',]} \n\r\t'.includes(text[position])) position++;
    if (position === start) invalid();
  };
  value(0);
  whitespace();
  if (position !== text.length) invalid();
}

async function readBody(response, setReader) {
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding.trim().toLowerCase() !== 'identity') {
    cancelBody(response.body);
    throw internal('INCOMPLETE_RESPONSE');
  }
  const rawLength = response.headers.get('content-length');
  let expected = null;
  if (rawLength !== null) {
    if (!/^\d+$/.test(rawLength)) {
      cancelBody(response.body);
      throw internal('INCOMPLETE_RESPONSE');
    }
    expected = Number(rawLength);
    if (!Number.isSafeInteger(expected) || expected > MAX_BYTES) {
      cancelBody(response.body);
      throw internal('INCOMPLETE_RESPONSE');
    }
  }
  if (!response.body || typeof response.body.getReader !== 'function') throw internal('INCOMPLETE_RESPONSE');
  const reader = response.body.getReader();
  setReader(reader);
  const pieces = [];
  let size = 0;
  let chunks = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || ++chunks > MAX_BODY_CHUNKS) throw internal('INCOMPLETE_RESPONSE');
      size += value.byteLength;
      if (size > MAX_BYTES) throw internal('INCOMPLETE_RESPONSE');
      if (value.byteLength) pieces.push(value);
    }
    if (expected !== null && expected !== size) {
      throw internal('INCOMPLETE_RESPONSE');
    }
    if (size === 0) throw internal('INCOMPLETE_RESPONSE');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const piece of pieces) { bytes.set(piece, offset); offset += piece.byteLength; }
    let parsed;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      rejectDuplicateJsonKeys(text);
      parsed = JSON.parse(text);
    } catch { throw internal('INVALID_RESPONSE'); }
    return parsed;
  } catch (error) {
    cancelBody(reader);
    throw error;
  } finally {
    setReader(null);
    try { reader.releaseLock(); } catch { /* a timed-out read can still be pending */ }
  }
}

async function requestOnce(target, headers, fetchImpl, timers) {
  const controller = new AbortController();
  let reader;
  let deadline;
  const timeout = new Promise((_, reject) => {
    deadline = timers.setTimeout(() => {
      if (reader) cancelBody(reader);
      controller.abort();
      reject(internal('INCOMPLETE_RESPONSE'));
    }, TIMEOUT_MS);
  });
  const work = (async () => {
    let response;
    try {
      response = await fetchImpl(target.href, {
        method: 'GET', headers, redirect: 'manual', credentials: 'omit',
        referrerPolicy: 'no-referrer', signal: controller.signal,
      });
    } catch { throw internal('INCOMPLETE_RESPONSE', true); }
    if (controller.signal.aborted) {
      cancelBody(response?.body);
      throw internal('INCOMPLETE_RESPONSE');
    }
    if (!response || !response.headers || typeof response.headers.get !== 'function') {
      throw internal('INCOMPLETE_RESPONSE');
    }
    // An auto-following transport has already violated the trust boundary;
    // accepting its body would also conceal whether it forwarded credentials.
    if (response.redirected || (response.url && response.url !== target.href)) {
      cancelBody(response.body);
      throw internal('ORIGIN_REFUSED');
    }
    if (REDIRECT_STATUS.has(response.status)) {
      const location = response.headers.get('location');
      cancelBody(response.body);
      return { redirect: location };
    }
    if (response.status !== 200 || !response.ok) {
      cancelBody(response.body);
      throw internal('INCOMPLETE_RESPONSE', TRANSIENT_STATUS.has(response.status));
    }
    // Link-based pagination is not implemented: it must never silently truncate.
    if (response.headers.get('link') !== null || response.headers.get('content-range') !== null) {
      cancelBody(response.body);
      throw internal('INCOMPLETE_RESPONSE');
    }
    const value = await readBody(response, current => { reader = current; });
    return { value };
  })();
  try { return await Promise.race([work, timeout]); }
  finally { timers.clearTimeout(deadline); }
}

function nextPage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.data) || !value.data.length) {
    throw internal('INVALID_RESPONSE');
  }
  // Accept only the documented subset. Unknown envelope fields can be an
  // unrecognized pagination/truncation signal, so are not evidence of closure.
  for (const key of Object.keys(value)) {
    if (!['data', 'object', 'has_more', 'next'].includes(key)) throw internal('INCOMPLETE_RESPONSE');
  }
  if (Object.hasOwn(value, 'object') && value.object !== 'list') throw internal('INVALID_RESPONSE');
  const more = value.has_more;
  const next = value.next;
  if (more !== undefined && typeof more !== 'boolean') throw internal('INCOMPLETE_RESPONSE');
  if (next !== undefined && next !== null && (typeof next !== 'string' || !next.trim())) throw internal('INCOMPLETE_RESPONSE');
  if (more === true && !next) throw internal('INCOMPLETE_RESPONSE');
  if (more === false && next) throw internal('INCOMPLETE_RESPONSE');
  return next || null;
}

/**
 * Fetch a validated target without forwarding credentials across origins.
 * `origin` is required for upstreams and must be the configured bare origin.
 * For `reference`, only https://models.dev/api.json is used and all caller
 * headers are discarded. `mode: 'catalog'` returns {data: [...]} only after
 * every explicit `next` page completes; `mode: 'json'` returns a nonempty
 * JSON object for a single snapshot. Duplicate object keys, nesting beyond 128
 * containers, or over 65,536 body chunks fail closed without partial values.
 * The optional `fetchImpl`, `timers`, and `retries` are for Host/test integration;
 * retries may lower, but never exceed, the hard policy limit.
 */
export async function boundedFetch({
  url, origin, headers, source = 'upstream', mode = 'catalog',
  fetchImpl = globalThis.fetch, timers = globalThis, retries = MAX_RETRIES,
}) {
  try {
    if ((source !== 'upstream' && source !== 'reference') || (mode !== 'catalog' && mode !== 'json')) return failure('ORIGIN_REFUSED');
    const reference = source === 'reference';
    if (reference && mode !== 'json') return failure('ORIGIN_REFUSED');
    const configured = reference ? new URL('https://models.dev') : new URL(origin);
    if (configured.username || configured.password || configured.pathname !== '/' || configured.search || configured.hash) return failure('ORIGIN_REFUSED');
    const secrets = headerSecrets(headers);
    // A reference snapshot is untrusted too; never surface a provided private
    // upstream address if a malicious service echoes it in the success body.
    const privateInputs = reference && typeof origin === 'string' && origin ? [origin] : [];
    const sensitiveValues = [...secrets, ...privateInputs];
    const allowed = configured.origin;
    let target = safeUrl(url, undefined, allowed, secrets);
    if (!target || (reference && target.href !== 'https://models.dev/api.json')) return failure('ORIGIN_REFUSED');
    const requestHeaders = reference ? new Headers() : new Headers(headers);
    // A compressed response can report wire length rather than decoded size.
    requestHeaders.set('accept-encoding', 'identity');
    const retryLimit = Number.isSafeInteger(retries) && retries >= 0 ? Math.min(retries, MAX_RETRIES) : MAX_RETRIES;
    const seenPages = new Set();
    const seenIds = new Set();
    const data = [];
    let pageCount = 0;
    let retryCount = 0;
    while (target) {
      if (pageCount >= MAX_PAGES || seenPages.has(target.href)) return failure('INCOMPLETE_RESPONSE');
      seenPages.add(target.href);
      let redirects = 0;
      let response;
      for (;;) {
        for (;;) {
          try { response = await requestOnce(target, requestHeaders, fetchImpl, timers); break; }
          catch (error) {
            if (!error?.retryable || retryCount >= retryLimit) throw error;
            retryCount++;
          }
        }
        if (!Object.hasOwn(response, 'redirect')) break;
        if (!response.redirect || redirects++ >= MAX_REDIRECTS) return failure('INCOMPLETE_RESPONSE');
        target = safeUrl(response.redirect, target.href, allowed, secrets);
        if (!target || (reference && target.href !== 'https://models.dev/api.json')) return failure('ORIGIN_REFUSED');
      }
      pageCount++;
      const value = response.value;
      if (hasSecretInJson(value, sensitiveValues)) return failure('INVALID_RESPONSE');
      if (mode === 'json') {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) return failure('INVALID_RESPONSE');
        return { ok: true, value, pages: pageCount };
      }
      const next = nextPage(value);
      for (const item of value.data) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id || seenIds.has(item.id)) {
          return failure('INVALID_RESPONSE');
        }
        seenIds.add(item.id);
        data.push(item);
      }
      if (!next) return { ok: true, value: { data }, pages: pageCount };
      target = safeUrl(next, target.href, allowed, secrets);
      if (!target) return failure('ORIGIN_REFUSED');
    }
    return failure('INCOMPLETE_RESPONSE');
  } catch (error) {
    return failure(Object.hasOwn(ERROR_MESSAGES, error?.code) ? error.code : 'INCOMPLETE_RESPONSE');
  }
}
