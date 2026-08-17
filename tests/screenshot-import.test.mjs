// Run with: node --experimental-test-module-mocks --test tests/*.test.mjs
// (also wired up as `npm test`)
//
// Covers the /api/screenshot-import endpoint -- the "Import from
// Screenshot" feature's structuring call. Takes raw OCR text (already
// extracted client-side via api/ocr.js) and returns structured fields
// (content_type/platform/age/location/occupation/bio/messages).
//
// This is a convenience feature, same architecture as api/ocr.js: it
// never calls check_and_increment_usage and never touches plan_status/
// credits, and never gates on plan_status/Pro status. It DOES now call
// Supabase for one specific thing -- check_and_increment_import_usage,
// the server-side daily-cap enforcement added after a security review
// found the only enforcement of IMPORT_DAILY_CAP was client-side
// JavaScript, trivially bypassed by calling this endpoint directly. Every
// test that reaches the Anthropic call now stubs that RPC explicitly via
// stubSupabaseAllowed() below, so it's clear exactly what Supabase call
// this endpoint makes and does not make (still no plan_status lookup, no
// credits touch -- only the one RPC).
//
// Also entirely separate from api/analyze.js, which explicitly rejects
// any client-supplied `system` field -- this endpoint builds its own
// system prompt (IMPORT_SYS) server-side, matching the established
// pattern (api/research-coach.js, api/inspector-advice.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IMPORT_SYS, validateImportShape } from '../api/screenshot-import.js';

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function stubSupabase(t, impl) {
  t.mock.module('../lib/supabaseAdmin.js', { namedExports: { getSupabaseAdmin: impl } });
}

// Default happy-path stub: the daily cap has not been hit. Asserts the RPC
// name and params on every call so any test using this helper doubles as
// a check that the handler is calling the right function correctly.
function stubSupabaseAllowed(t, { usageCount = 1 } = {}) {
  const rpcCalls = [];
  stubSupabase(t, () => ({
    rpc: async (fn, params) => {
      rpcCalls.push({ fn, params });
      assert.equal(fn, 'check_and_increment_import_usage');
      assert.equal(params.p_user_id, VALID_UID);
      assert.equal(params.p_daily_limit, 8);
      assert.equal(params.p_reset_hours, 24);
      return { data: [{ o_allowed: true, o_usage_count: usageCount }], error: null };
    }
  }));
  return rpcCalls;
}

async function loadHandler() {
  return import(`../api/screenshot-import.js?t=${Date.now()}-${Math.random()}`);
}

const withKey = () => { process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'; };

const VALID_UID = '11111111-1111-4111-8111-111111111111';

const profileResult = {
  content_type: 'profile',
  platform: 'Hinge',
  age: '29',
  location: 'Austin, TX',
  occupation: 'Nurse',
  bio: 'Love hiking and dogs.',
  messages: null
};

const conversationResult = {
  content_type: 'conversation',
  platform: null,
  age: null,
  location: null,
  occupation: null,
  bio: null,
  messages: 'Them: hey!\nMe: hi there'
};

const anthropicOk = (obj) => async () => ({
  ok: true,
  json: async () => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] })
});

test('rejects missing or invalid userId before ever calling Anthropic or Supabase', async (t) => {
  withKey();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should never be called'); });
  const supabaseMock = t.mock.fn(() => { throw new Error('should never be called'); });
  stubSupabase(t, supabaseMock);

  const { default: handler } = await loadHandler();
  for (const userId of [undefined, '', 'not-a-uuid', 123]) {
    const res = mockRes();
    await handler({ method: 'POST', body: { userId, text: 'some OCR text' } }, res);
    assert.equal(res.statusCode, 400, `userId=${JSON.stringify(userId)} should be rejected`);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(supabaseMock.mock.callCount(), 0);
});

test('rejects missing/empty text before ever calling Anthropic or Supabase', async (t) => {
  withKey();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should never be called'); });
  const supabaseMock = t.mock.fn(() => { throw new Error('should never be called'); });
  stubSupabase(t, supabaseMock);

  const { default: handler } = await loadHandler();
  for (const text of [undefined, '', '   ']) {
    const res = mockRes();
    await handler({ method: 'POST', body: { userId: VALID_UID, text } }, res);
    assert.equal(res.statusCode, 400, `text=${JSON.stringify(text)} should be rejected`);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(supabaseMock.mock.callCount(), 0);
});

test('does not require or check plan_status/Pro status -- allowed regardless', async (t) => {
  withKey();
  stubSupabaseAllowed(t);
  t.mock.method(globalThis, 'fetch', async () => anthropicOk(profileResult)());

  const { default: handler } = await loadHandler();
  const res = mockRes();
  // No isPro/plan_status field supplied at all -- must still succeed.
  await handler({ method: 'POST', body: { userId: VALID_UID, text: 'Hinge bio text' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, profileResult);
});

test('a profile-style OCR text returns profile fields populated, messages null', async (t) => {
  withKey();
  stubSupabaseAllowed(t);
  let capturedBody;
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return anthropicOk(profileResult)();
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, text: 'Hinge profile OCR text' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, profileResult);
  assert.equal(capturedBody.model, 'claude-sonnet-5');
  assert.equal(capturedBody.system, IMPORT_SYS);
  assert.match(capturedBody.messages[0].content, /Hinge profile OCR text/);
});

test('a conversation-style OCR text returns messages populated, profile fields null', async (t) => {
  withKey();
  stubSupabaseAllowed(t);
  t.mock.method(globalThis, 'fetch', async () => anthropicOk(conversationResult)());

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, text: 'hey! / hi there' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, conversationResult);
});

test('strips ```json fences from the model response before parsing', async (t) => {
  withKey();
  stubSupabaseAllowed(t);
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: '```json\n' + JSON.stringify(profileResult) + '\n```' }] })
  }));

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, text: 'some text' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, profileResult);
});

test('a malformed JSON response from the model is a clean 502, not a crash', async (t) => {
  withKey();
  stubSupabaseAllowed(t);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'not valid json {{{' }] }) }));

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, text: 'some text' } }, res);

  assert.equal(res.statusCode, 502);
});

test('a response with an invalid content_type is rejected', async (t) => {
  withKey();
  stubSupabaseAllowed(t);
  t.mock.method(globalThis, 'fetch', async () => anthropicOk({ ...profileResult, content_type: 'garbage' })());

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, text: 'some text' } }, res);

  assert.equal(res.statusCode, 502);
});

test('a response with a non-string/non-null field (e.g. a number) is rejected, not partially served', async (t) => {
  withKey();
  stubSupabaseAllowed(t);
  t.mock.method(globalThis, 'fetch', async () => anthropicOk({ ...profileResult, age: 29 })());

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, text: 'some text' } }, res);

  assert.equal(res.statusCode, 502);
});

test('an Anthropic API-level error response is a clean error status, no raw error leaked', async (t) => {
  withKey();
  stubSupabaseAllowed(t);
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { type: 'authentication_error', message: 'invalid x-api-key' } })
  }));

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, text: 'some text' } }, res);

  assert.equal(res.statusCode, 401);
  assert.doesNotMatch(res.body.error, /invalid x-api-key/);
});

test('missing ANTHROPIC_API_KEY degrades gracefully (500, no crash, no key leaked)', async (t) => {
  delete process.env.ANTHROPIC_API_KEY;
  stubSupabaseAllowed(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, text: 'some text' } }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(fetchMock.mock.callCount(), 0);

  withKey();
});

test('a timeout (AbortError) is a clean 504, not a crash', async (t) => {
  withKey();
  stubSupabaseAllowed(t);
  t.mock.method(globalThis, 'fetch', async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, text: 'some text' } }, res);

  assert.equal(res.statusCode, 504);
  assert.match(res.body.error, /timed out/i);
});

test('rejects non-POST methods', async (t) => {
  withKey();
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'GET', body: { userId: VALID_UID, text: 'some text' } }, res);
  assert.equal(res.statusCode, 405);
});

// ════════════════════ Server-side daily-cap enforcement ═════════════════
// The core of the fix: IMPORT_DAILY_CAP must be enforced here, backed by a
// real DB counter (check_and_increment_import_usage, migration 0012), not
// trusted from the client's own cf_import_usage/cf_import_reset check.

test('cap exceeded: the RPC reporting o_allowed=false blocks the request with 429, Anthropic is never called', async (t) => {
  withKey();
  stubSupabase(t, () => ({
    rpc: async () => ({ data: [{ o_allowed: false, o_usage_count: 8 }], error: null })
  }));
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Anthropic should never be called once the daily cap is hit'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, text: 'some text' } }, res);

  assert.equal(res.statusCode, 429);
  assert.equal(res.body.limitReached, true);
  assert.equal(fetchMock.mock.callCount(), 0, 'the paid Anthropic call must never fire once the cap is hit');
});

test('cap exceeded: a non-array single-object RPC response shape (o_allowed=false) is also handled correctly', async (t) => {
  withKey();
  stubSupabase(t, () => ({
    rpc: async () => ({ data: { o_allowed: false, o_usage_count: 8 }, error: null })
  }));
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, text: 'some text' } }, res);

  assert.equal(res.statusCode, 429);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('cap not yet exceeded: o_allowed=true lets the request through to Anthropic as normal', async (t) => {
  withKey();
  stubSupabaseAllowed(t, { usageCount: 7 });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => anthropicOk(profileResult)());

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, text: 'some text' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('simulates 8 imports in a row for the same userId against a real-shaped counter: the 9th is blocked', async (t) => {
  withKey();
  let count = 0;
  const DAILY_LIMIT = 8;
  stubSupabase(t, () => ({
    rpc: async (fn, params) => {
      assert.equal(fn, 'check_and_increment_import_usage');
      if (count >= params.p_daily_limit) {
        return { data: [{ o_allowed: false, o_usage_count: count }], error: null };
      }
      count += 1;
      return { data: [{ o_allowed: true, o_usage_count: count }], error: null };
    }
  }));
  t.mock.method(globalThis, 'fetch', async () => anthropicOk(profileResult)());

  const { default: handler } = await loadHandler();
  const statuses = [];
  for (let i = 0; i < 9; i++) {
    const res = mockRes();
    await handler({ method: 'POST', body: { userId: VALID_UID, text: `screenshot ${i}` } }, res);
    statuses.push(res.statusCode);
  }

  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 200, 429], `expected exactly ${DAILY_LIMIT} allowed then blocked, got: ${statuses}`);
  assert.equal(count, DAILY_LIMIT);
});

test('the usage-check RPC erroring is a clean 500, not a crash, and Anthropic is never called', async (t) => {
  withKey();
  stubSupabase(t, () => ({
    rpc: async () => ({ data: null, error: { message: 'connection reset' } })
  }));
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, text: 'some text' } }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('the usage-check RPC throwing is a clean 500, not a crash', async (t) => {
  withKey();
  stubSupabase(t, () => ({
    rpc: async () => { throw new Error('network blip'); }
  }));
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, text: 'some text' } }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(fetchMock.mock.callCount(), 0);
});

// ════════════════════ Unit tests: validateImportShape ════════════════════

test('validateImportShape: accepts a fully-populated valid shape', () => {
  assert.deepEqual(validateImportShape(profileResult), { ok: true });
});

test('validateImportShape: accepts all-null fields with a valid content_type', () => {
  const allNull = { content_type: 'unclear', platform: null, age: null, location: null, occupation: null, bio: null, messages: null };
  assert.deepEqual(validateImportShape(allNull), { ok: true });
});

test('validateImportShape: rejects a non-object', () => {
  assert.equal(validateImportShape(null).ok, false);
  assert.equal(validateImportShape('a string').ok, false);
});

test('validateImportShape: rejects an invalid content_type', () => {
  assert.equal(validateImportShape({ ...profileResult, content_type: 'nonsense' }).ok, false);
});

test('validateImportShape: rejects a field that is neither string nor null', () => {
  assert.equal(validateImportShape({ ...profileResult, bio: 42 }).ok, false);
  assert.equal(validateImportShape({ ...profileResult, messages: {} }).ok, false);
});
