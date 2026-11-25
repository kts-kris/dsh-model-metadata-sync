import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedFetch } from '../lib/safe-fetch.js';

const SECRET = 'synthetic-secret-not-a-real-credential';
const ORIGIN = 'https://gateway.example';
const authorization = { authorization: `Bearer ${SECRET}` };
const jsonResponse = (value, init = {}) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { 'content-type': 'application/json' },
  ...init,
});
const redirect = (location, status = 302) => new Response(null, { status, headers: { location } });

// The transport is a recording boundary, not an implementation of policy.
function transport(responses) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(url, options);
      assert.ok(next, 'unexpected network request');
      return next;
    },
  };
}
const request = (fake, options = {}) => boundedFetch({
  source: 'upstream', mode: 'catalog', origin: ORIGIN,
  url: `${ORIGIN}/v1/models`, headers: authorization, fetchImpl: fake.fetch,
  ...options,
});
const noSecret = (result) => {
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
};

// upstream origin is the configured origin, never derived from a redirect.
// Successful catalog responses contain a flattened {data: [...]} JSON value.
test('sends synthetic upstream credentials to the configured origin only', async () => {
  const fake = transport([jsonResponse({ data: [{ id: 'demo-model' }] })]);
  const result = await request(fake);
  assert.deepEqual(result, { ok: true, value: { data: [{ id: 'demo-model' }] }, pages: 1 });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].options.redirect, 'manual');
  assert.equal(new Headers(fake.calls[0].options.headers).get('authorization'), `Bearer ${SECRET}`);
});

test('follows same-origin redirects manually and retains origin-bound credentials', async () => {
  const fake = transport([redirect('/v1/moved'), jsonResponse({ data: [{ id: 'safe' }] })]);
  const result = await request(fake);
  assert.equal(result.ok, true);
  assert.deepEqual(fake.calls.map(call => call.url), [`${ORIGIN}/v1/models`, `${ORIGIN}/v1/moved`]);
  assert.ok(fake.calls.every(call => call.options.redirect === 'manual'));
  assert.ok(fake.calls.every(call => new Headers(call.options.headers).get('authorization') === `Bearer ${SECRET}`));
});

test('never follows cross-host, changed-port, or downgraded redirects', async () => {
  for (const destination of [
    'https://elsewhere.example/v1/models',
    'https://gateway.example:8443/v1/models',
    'http://gateway.example/v1/models',
  ]) {
    const fake = transport([redirect(destination)]);
    const result = await request(fake);
    noSecret(result);
    assert.equal(fake.calls.length, 1, `redirect ${destination} must not issue a second request`);
  }
});

test('rejects cross-origin initial URLs, userinfo, and secret-bearing query links before transport', async () => {
  for (const url of [
    'https://evil.example/models',
    'https://user:pass@gateway.example/v1/models',
    `https://gateway.example/v1/models?api_key=${SECRET}`,
    `https://gateway.example/v1/models?cursor=${SECRET}`,
  ]) {
    const fake = transport([]);
    noSecret(await request(fake, { url }));
    assert.equal(fake.calls.length, 0);
  }
});

test('rejects redirects with userinfo or secrets in their query before a second request', async () => {
  for (const destination of [
    'https://user:pass@gateway.example/v1/models',
    `https://gateway.example/v1/models?token=${SECRET}`,
    `https://gateway.example/v1/models?after=${SECRET}`,
  ]) {
    const fake = transport([redirect(destination)]);
    noSecret(await request(fake));
    assert.equal(fake.calls.length, 1);
  }
});

test('only loopback upstreams may use cleartext HTTP', async () => {
  const refused = transport([]);
  noSecret(await request(refused, { origin: 'http://public.example', url: 'http://public.example/v1/models' }));
  assert.equal(refused.calls.length, 0);
  for (const origin of ['http://127.0.0.1:8888', 'http://localhost:8888', 'http://[::1]:8888']) {
    const fake = transport([jsonResponse({ data: [{ id: 'local' }] })]);
    assert.equal((await request(fake, { origin, url: `${origin}/v1/models` })).ok, true);
  }
});

test('errors and failed responses never reveal raw upstream errors or bodies', async () => {
  for (const response of [
    new Error(`network exception ${SECRET}`),
    new Response(`upstream error ${SECRET}`, { status: 401 }),
    redirect(`https://evil.example/${SECRET}`),
  ]) {
    const fake = transport([response]);
    noSecret(await request(fake, { retries: 0 }));
    assert.equal(fake.calls.length, 1);
  }
});

test('reference request is fixed public snapshot and cannot receive supplied upstream headers', async () => {
  const fake = transport([jsonResponse({ openai: {} })]);
  const result = await boundedFetch({
    source: 'reference', mode: 'json', origin: ORIGIN,
    url: 'https://models.dev/api.json', headers: authorization, fetchImpl: fake.fetch,
  });
  assert.deepEqual(result, { ok: true, value: { openai: {} }, pages: 1 });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url, 'https://models.dev/api.json');
  assert.equal(new Headers(fake.calls[0].options.headers).has('authorization'), false);
  assert.equal(JSON.stringify(fake.calls).includes(SECRET), false);
  assert.equal(JSON.stringify(fake.calls).includes(ORIGIN), false);
  const refused = transport([]);
  noSecret(await boundedFetch({ source: 'reference', mode: 'json', url: `${ORIGIN}/private`, fetchImpl: refused.fetch }));
  assert.equal(refused.calls.length, 0);
});

function fakeClock() {
  const pending = new Map();
  let id = 0;
  return {
    pending,
    timers: {
      setTimeout(callback, ms) { const key = ++id; pending.set(key, { callback, ms }); return key; },
      clearTimeout(key) { pending.delete(key); },
    },
    fire() {
      const [key, timer] = pending.entries().next().value;
      pending.delete(key);
      timer.callback();
    },
  };
}

test('aborts a hung transport at the injected 15-second request deadline', async () => {
  const clock = fakeClock();
  const fake = transport([() => new Promise(() => {})]);
  const pending = request(fake, { timers: clock.timers, retries: 0 });
  assert.deepEqual([...clock.pending.values()].map(timer => timer.ms), [15_000]);
  clock.fire();
  noSecret(await pending);
  assert.equal(fake.calls[0].options.signal.aborted, true);
  assert.equal(clock.pending.size, 0);
});

test('the same deadline includes a stalled body and cancels its reader', async () => {
  const clock = fakeClock();
  let reading;
  const started = new Promise(resolve => { reading = resolve; });
  let cancelled = false;
  const body = new ReadableStream({
    pull() { reading(); return new Promise(() => {}); },
    cancel() { cancelled = true; },
  });
  const fake = transport([new Response(body)]);
  const pending = request(fake, { timers: clock.timers, retries: 0 });
  await started;
  clock.fire();
  noSecret(await pending);
  assert.equal(cancelled, true);
  assert.equal(fake.calls[0].options.signal.aborted, true);
});

for (const declared of [false, true]) {
  test(`rejects a closed, valid four MiB plus one response ${declared ? 'with' : 'without'} a content-length`, async () => {
    const limit = 4 * 1024 * 1024;
    const prefix = '{"data":[{"id":"';
    const suffix = '"}]}';
    const text = prefix + 'a'.repeat(limit + 1 - prefix.length - suffix.length) + suffix;
    assert.equal(Buffer.byteLength(text), limit + 1);
    assert.equal(JSON.parse(text).data.length, 1); // Oversize is the only defect.
    const bytes = new TextEncoder().encode(text);
    let closed = false;
    let reads = 0;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, limit));
        controller.enqueue(bytes.subarray(limit));
        controller.close();
        closed = true;
      },
    });
    // A declared oversize response is refused from headers, before body reads.
    const originalGetReader = body.getReader.bind(body);
    body.getReader = (...args) => {
      const reader = originalGetReader(...args);
      const originalRead = reader.read.bind(reader);
      reader.read = (...readArgs) => { reads++; return originalRead(...readArgs); };
      return reader;
    };
    const headers = declared ? { 'content-length': String(limit + 1) } : {};
    const fake = transport([new Response(body, { headers })]);
    const clock = fakeClock(); // Never fire: a timeout cannot impersonate the size check.
    const result = await request(fake, { timers: clock.timers });
    assert.equal(closed, true);
    noSecret(result);
    assert.equal(result.error.code, 'INCOMPLETE_RESPONSE');
    assert.equal('value' in result, false);
    assert.equal(fake.calls.length, 1);
    assert.equal(clock.pending.size, 0);
    if (declared) assert.equal(reads, 0);
  });
}

test('cancels an open stream immediately when its body exceeds the four MiB limit', async () => {
  const clock = fakeClock();
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(4 * 1024 * 1024));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() { cancelled = true; },
  });
  const result = await request(transport([new Response(body)]), { timers: clock.timers });
  noSecret(result);
  assert.equal(result.error.code, 'INCOMPLETE_RESPONSE');
  assert.equal(cancelled, true);
  assert.equal(clock.pending.size, 0);
});

test('accepts an ordinary response fragmented into many small chunks', async () => {
  const bytes = new TextEncoder().encode('{"data":[{"id":"fragmented"}]}');
  let index = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (index === bytes.length) controller.close();
      else controller.enqueue(bytes.subarray(index, ++index));
    },
  });
  const result = await request(transport([new Response(stream)]));
  assert.equal(result.ok, true);
  assert.equal(result.value.data[0].id, 'fragmented');
});

test('too many nonempty tiny transport chunks cannot evade the resource bound', async () => {
  const clock = fakeClock();
  let reads = 0;
  let cancelled = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    pull(controller) {
      reads++;
      if (reads <= 70_000) controller.enqueue(Uint8Array.of(0x20));
      else { controller.enqueue(encoder.encode('{"data":[{"id":"late"}]}')); controller.close(); }
    },
    cancel() { cancelled = true; },
  });
  const result = await request(transport([new Response(stream)]), { timers: clock.timers });
  noSecret(result);
  assert.equal(result.error.code, 'INCOMPLETE_RESPONSE');
  assert.equal(cancelled, true);
  assert.ok(reads < 70_000);
  assert.equal(clock.pending.size, 0);
});

test('endless empty transport chunks are bounded and the response is cancelled', async () => {
  const clock = fakeClock();
  let reads = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      reads++;
      if (reads <= 70_000) controller.enqueue(new Uint8Array(0));
      else { controller.enqueue(new TextEncoder().encode('{"data":[{"id":"late"}]}')); controller.close(); }
    },
    cancel() { cancelled = true; },
  });
  const result = await request(transport([new Response(stream)]), { timers: clock.timers });
  noSecret(result);
  assert.equal(result.error.code, 'INCOMPLETE_RESPONSE');
  assert.equal(cancelled, true);
  assert.ok(reads < 70_000);
  assert.equal(clock.pending.size, 0);
});

test('does not trust a declared short length or return a truncated response', async () => {
  for (const response of [
    new Response('{"data":[{"id":"one"}]}', { headers: { 'content-length': '999' } }),
    new Response('{"data":[{"id":"one"}]}', { headers: { 'content-length': '1' } }),
    new Response('{"data":[{"id":"one"}]}', { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }),
    new Response('{"data":[{"id":"broken"}'),
  ]) {
    noSecret(await request(transport([response])));
  }
});

for (const [description, body, source] of [
  ['nested duplicate model id', '{"data":[{"id":"a","id":"b"}]}', 'upstream'],
  ['escaped duplicate model id', '{"data":[{"id":"a","\\u0069d":"b"}]}', 'upstream'],
  ['duplicate nested metadata key', '{"data":[{"id":"a","meta":{"limit":1,"limit":2}}]}', 'upstream'],
  ['escaped lone surrogate key', '{"data":[{"id":"a","\\ud800":1,"\\uD800":2}]}', 'upstream'],
  ['escaped newline key', '{"data":[{"id":"a","\\n":1,"\\u000A":2}]}', 'upstream'],
  ['contradictory pagination signals', '{"data":[{"id":"a"}],"has_more":true,"has_more":false}', 'upstream'],
  ['supplementary Unicode escaped and literal keys', '{"data":[{"id":"a","😀":1,"\\ud83d\\ude00":2}]}', 'upstream'],
  ['escaped and literal backslash keys', '{"data":[{"id":"a","\\\\":1,"\\u005c":2}]}', 'upstream'],
  ['duplicate __proto__ key', '{"data":[{"id":"a","__proto__":1,"__proto__":2}]}', 'upstream'],
  ['duplicate reference provider', '{"openai":{"id":"openai","models":{}},"openai":{"id":"openai","models":{}}}', 'reference'],
  ['duplicate reference model', '{"openai":{"id":"openai","models":{"m":{"id":"m"},"m":{"id":"m"}}}}', 'reference'],
]) {
  test(`rejects ${description} in raw JSON before any data can be applied`, async () => {
    const fake = transport([new Response(body)]);
    const options = source === 'reference' ? {
      source, mode: 'json', url: 'https://models.dev/api.json',
    } : {};
    const result = await request(fake, options);
    noSecret(result);
    assert.equal(result.error.code, 'INVALID_RESPONSE');
    assert.equal('value' in result, false);
    assert.equal(fake.calls.length, 1);
    if (source === 'reference') assert.equal(new Headers(fake.calls[0].options.headers).has('authorization'), false);
  });
}

test('a duplicate key on a later page invalidates the entire paginated catalog', async () => {
  const fake = transport([
    jsonResponse({ data: [{ id: 'one' }], has_more: true, next: '/v1/models?page=2' }),
    new Response('{"data":[{"id":"two","id":"three"}]}'),
  ]);
  const result = await request(fake);
  noSecret(result);
  assert.equal(result.error.code, 'INVALID_RESPONSE');
  assert.equal('value' in result, false);
  assert.equal(fake.calls.length, 2);
});

test('permits the same object keys in different objects and preserves escaped JSON strings', async () => {
  const raw = '{"data":[{"id":"a","label":"quote: \\\" and brace: }","nested":{"k":"\\ud83d\\ude00"}},{"id":"b","nested":{"k":"ok"}}]}';
  const result = await request(transport([new Response(raw)]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, JSON.parse(raw));
});

test('does not normalize or conflate case-distinct and canonically distinct Unicode keys', async () => {
  const raw = '{"data":[{"id":"a","A":1,"a":2,"é":3,"e\\u0301":4,"\\ud800":5}]}';
  const result = await request(transport([new Response(raw)]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, JSON.parse(raw));
});

test('JSON nesting through 128 containers is allowed but deeper input is rejected', async () => {
  const body = count => '{"data":[{"id":"a","nested":' + '['.repeat(count) + '0' + ']'.repeat(count) + '}]}';
  assert.equal((await request(transport([new Response(body(125))]))).ok, true);
  const result = await request(transport([new Response(body(126))]));
  noSecret(result);
  assert.equal(result.error.code, 'INVALID_RESPONSE');
});

test('excessively deep JSON fails closed without returning a model', async () => {
  const raw = '{"data":[{"id":"a","nested":' + '['.repeat(20_000) + '0' + ']'.repeat(20_000) + '}]}';
  const result = await request(transport([new Response(raw)]));
  noSecret(result);
  assert.equal(result.error.code, 'INVALID_RESPONSE');
  assert.equal('value' in result, false);
});

for (const length of ['-1', '+1', '1.0', '1e3', '1, 1', 'NaN', '']) {
  test(`cancels the response body for malformed content-length ${JSON.stringify(length)}`, async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const fake = transport([new Response(body, { headers: { 'content-length': length } })]);
    const result = await request(fake);
    noSecret(result);
    assert.equal(result.error.code, 'INCOMPLETE_RESPONSE');
    assert.equal(cancelled, true);
    assert.equal(fake.calls.length, 1);
  });
}

test('an unsafe numeric content-length cancels the response body', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const fake = transport([new Response(body, { headers: { 'content-length': '9007199254740992' } })]);
  const result = await request(fake);
  noSecret(result);
  assert.equal(result.error.code, 'INCOMPLETE_RESPONSE');
  assert.equal(cancelled, true);
});

test('rejects invalid JSON grammar, escapes and UTF-8 at the network boundary', async () => {
  for (const body of [
    '{"data":[{"id":"a",}]}',
    '{"data":[{"id":"a","value":01}]}',
    '{"data":[{"id":"a","value":"\\q"}]}',
    '{"data":[{"id":"a"}]} trailing',
    new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc0, 0xaf, 0x22, 0x7d]),
  ]) {
    const result = await request(transport([new Response(body)]));
    noSecret(result);
    assert.equal(result.error.code, 'INVALID_RESPONSE');
  }
});

test('malformed JSON, empty catalogs, unknown shapes, or credentials in a success body cannot be applied', async () => {
  for (const response of [
    new Response('not-json'),
    jsonResponse({ data: [] }),
    jsonResponse({ models: [{ id: 'shape-not-proven' }] }),
    jsonResponse({ data: [{ id: SECRET }] }),
    jsonResponse({ data: [{ id: 'model', extra: { nested: SECRET } }] }),
  ]) {
    noSecret(await request(transport([response])));
  }
});

test('fully follows verified same-origin pagination and returns only a complete catalog', async () => {
  const fake = transport([
    jsonResponse({ data: [{ id: 'one' }], has_more: true, next: '/v1/models?page=2' }),
    jsonResponse({ data: [{ id: 'two' }], has_more: false, next: null }),
  ]);
  assert.deepEqual(await request(fake), {
    ok: true, value: { data: [{ id: 'one' }, { id: 'two' }] }, pages: 2,
  });
  assert.deepEqual(fake.calls.map(call => call.url), [`${ORIGIN}/v1/models`, `${ORIGIN}/v1/models?page=2`]);
});

test('missing, contradictory, looping, or cross-origin pagination fails without partial data', async () => {
  for (const first of [
    { data: [{ id: 'one' }], has_more: true },
    { data: [{ id: 'one' }], has_more: false, next: '/v1/models?page=2' },
    { data: [{ id: 'one' }], has_more: 'unknown' },
    { data: [{ id: 'one' }], next: 'https://elsewhere.example/next' },
    { data: [{ id: 'one' }], has_more: true, next: '/v1/models' },
  ]) {
    const fake = transport([jsonResponse(first)]);
    noSecret(await request(fake));
    assert.equal(fake.calls.length, 1);
  }
});

test('unknown or contradictory pagination metadata cannot masquerade as a complete list', async () => {
  for (const metadata of [
    { truncated: true }, { incomplete: true }, { complete: false },
    { total_pages: 2, page: 1 }, { total: 20, offset: 0, limit: 1 },
    { has_next_page: true }, { page_info: { has_next_page: true } },
    { object: 'unexpected' },
  ]) {
    const fake = transport([jsonResponse({ data: [{ id: 'one' }], ...metadata })]);
    const result = await request(fake);
    noSecret(result);
    assert.equal('value' in result, false);
  }
});

test('opaque or already-followed responses cannot prove the configured credential origin', async () => {
  const fake = transport([{
    ok: true, status: 200, redirected: true, url: 'https://evil.example/secret',
    headers: new Headers(), body: jsonResponse({ data: [{ id: 'one' }] }).body,
  }]);
  noSecret(await request(fake));
});

test('twenty-page terminal catalog succeeds but a twenty-first page is never requested', async () => {
  const pages = (moreOnLast) => Array.from({ length: 20 }, (_, i) => jsonResponse({
    data: [{ id: `item-${i}` }], has_more: i < 19 || moreOnLast,
    next: i < 19 || moreOnLast ? `/v1/models?page=${i + 2}` : null,
  }));
  const complete = transport(pages(false));
  const result = await request(complete);
  assert.equal(result.ok, true);
  assert.equal(result.pages, 20);
  assert.equal(result.value.data.length, 20);
  const partial = transport(pages(true));
  noSecret(await request(partial));
  assert.equal(partial.calls.length, 20);
});

test('transient responses are retried at most three times and exhausted retries fail closed', async () => {
  const transient = () => new Response('do not expose raw error', { status: 503 });
  const recovered = transport([transient(), transient(), transient(), jsonResponse({ data: [{ id: 'recovered' }] })]);
  assert.equal((await request(recovered)).ok, true);
  assert.equal(recovered.calls.length, 4);
  const exhausted = transport([transient(), transient(), transient(), transient()]);
  noSecret(await request(exhausted, { retries: 10 }));
  assert.ok(exhausted.calls.length <= 4);
});

test('the three-retry budget is shared across the entire paginated operation', async () => {
  const unavailable = () => new Response(null, { status: 503 });
  const fake = transport([
    unavailable(), unavailable(), unavailable(),
    jsonResponse({ data: [{ id: 'one' }], has_more: true, next: '/v1/models?page=2' }),
    unavailable(),
    jsonResponse({ data: [{ id: 'two' }] }),
  ]);
  noSecret(await request(fake));
  assert.equal(fake.calls.length, 5);
});

test('credentials hidden in arbitrary headers or HTTP Basic are never echoed in successful data or URLs', async () => {
  const pairs = [
    { headers: { accept: SECRET }, secret: SECRET },
    { headers: { authorization: `Basic ${Buffer.from(`person:${SECRET}`).toString('base64')}` }, secret: SECRET },
    { headers: { cookie: `session=${SECRET}; type=other` }, secret: SECRET },
  ];
  for (const { headers, secret } of pairs) {
    const body = transport([jsonResponse({ data: [{ id: secret }] })]);
    const result = await request(body, { headers });
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(secret), false);
    const query = transport([]);
    const queryResult = await request(query, { headers, url: `${ORIGIN}/v1/models?cursor=${encodeURIComponent(secret)}` });
    assert.equal(queryResult.ok, false);
    assert.equal(query.calls.length, 0);
  }
});

test('duplicate model IDs across pages invalidate the whole fetched catalog', async () => {
  const fake = transport([
    jsonResponse({ data: [{ id: 'same' }], has_more: true, next: '/v1/models?page=2' }),
    jsonResponse({ data: [{ id: 'same' }] }),
  ]);
  const result = await request(fake);
  noSecret(result);
  assert.equal('value' in result, false);
});

test('exactly four MiB of valid JSON is allowed and over-limit declared streams are cancelled', async () => {
  const limit = 4 * 1024 * 1024;
  const prefix = '{"data":[{"id":"';
  const suffix = '"}]}';
  const text = prefix + 'a'.repeat(limit - prefix.length - suffix.length) + suffix;
  assert.equal(Buffer.byteLength(text), limit);
  for (const declared of [false, true]) {
    const headers = declared ? { 'content-length': String(limit) } : {};
    const fake = transport([new Response(text, { headers })]);
    const result = await request(fake);
    assert.equal(result.ok, true);
    assert.equal(result.value.data.length, 1);
  }
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  noSecret(await request(transport([new Response(stream, { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } })])));
  assert.equal(cancelled, true);
});

test('deceptive content encodings and partial HTTP statuses cannot establish an intact JSON body', async () => {
  for (const response of [
    new Response('{"data":[{"id":"one"}]}', { headers: { 'content-encoding': 'gzip', 'content-length': '999' } }),
    new Response('{"data":[{"id":"one"}]}', { status: 206, headers: { 'content-range': 'bytes 0-22/100' } }),
    new Response('{"data":[{"id":"one"}]}', { status: 201 }),
  ]) {
    noSecret(await request(transport([response])));
  }
});

test('successful reference content containing a synthetic private endpoint fails closed', async () => {
  const fake = transport([jsonResponse({ openai: { note: `private upstream: ${ORIGIN}` } })]);
  const result = await boundedFetch({
    source: 'reference', mode: 'json', origin: ORIGIN, url: 'https://models.dev/api.json', fetchImpl: fake.fetch,
  });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(ORIGIN), false);
});

test('a late response after deadline is cancelled and never read', async () => {
  const clock = fakeClock();
  let finish;
  const fake = transport([() => new Promise(resolve => { finish = resolve; })]);
  const pending = request(fake, { timers: clock.timers, retries: 0 });
  clock.fire();
  noSecret(await pending);
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  finish(new Response(stream));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('one provider failure does not erase an independent complete result', async () => {
  const good = transport([jsonResponse({ data: [{ id: 'good' }] })]);
  const bad = transport([jsonResponse({ data: [{ id: 'partial' }], has_more: true })]);
  const [success, failure] = await Promise.all([request(good), request(bad)]);
  assert.deepEqual(success, { ok: true, value: { data: [{ id: 'good' }] }, pages: 1 });
  noSecret(failure);
  assert.equal('value' in failure, false);
});
