// Run with: node --experimental-test-module-mocks --test tests/*.test.mjs
// (also wired up as `npm test`)
//
// Covers the new /api/inspector-advice endpoint -- a Pro-only feature that
// generates removal/reporting guidance, in the voice of mascot "Inspector
// Catchworth," for photos api/reverse-search.js found matches for. Pro
// status is verified here server-side against the users table directly
// (plan_status) -- the client's S.isPro() check in index.html is a
// courtesy only, never trusted; there is no client-supplied isPro flag in
// this endpoint's contract at all.
//
// Every mock is registered via the per-test `t.mock` tracker so it's
// always restored, pass or fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

// Mirrors the .from('users').select('plan_status').eq('id', userId).maybeSingle()
// chain the handler actually calls -- a direct lookup, not check_and_increment_usage
// or any RPC, since this endpoint doesn't gate/consume a usage counter.
function stubSupabase(t, maybeSingleImpl, capture) {
  t.mock.module('../lib/supabaseAdmin.js', {
    namedExports: {
      getSupabaseAdmin: () => ({
        from: (table) => {
          if (capture) capture.table = table;
          return {
            select: (cols) => {
              if (capture) capture.select = cols;
              return {
                eq: (col, val) => {
                  if (capture) capture.eq = { col, val };
                  return { maybeSingle: maybeSingleImpl };
                }
              };
            }
          };
        }
      })
    }
  });
}

function stubPro(t, capture) {
  stubSupabase(t, async () => ({ data: { plan_status: 'active' }, error: null }), capture);
}
function stubFree(t, capture) {
  stubSupabase(t, async () => ({ data: { plan_status: 'free' }, error: null }), capture);
}

async function loadHandler() {
  return import(`../api/inspector-advice.js?t=${Date.now()}-${Math.random()}`);
}

const withKey = () => { process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'; };

const VALID_UID = '11111111-1111-4111-8111-111111111111';
const baseBody = { userId: VALID_UID, matchedDomains: ['instagram.com', 'example.com'], photoContext: 'profile photo' };

const anthropicOk = (text) => async () => ({
  ok: true,
  json: async () => ({ content: [{ type: 'text', text }] })
});

test('rejects missing or invalid userId before ever calling Supabase or Anthropic', async (t) => {
  withKey();
  const capture = {};
  stubPro(t, capture);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Anthropic should never be called'); });

  const { default: handler } = await loadHandler();
  for (const userId of [undefined, '', 'not-a-uuid', 123]) {
    const res = mockRes();
    await handler({ method: 'POST', body: { ...baseBody, userId } }, res);
    assert.equal(res.statusCode, 400, `userId=${JSON.stringify(userId)} should be rejected`);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(capture.table, undefined, 'Supabase should never be touched for an invalid userId');
});

test('rejects missing/empty/non-array/oversized matchedDomains', async (t) => {
  withKey();
  stubPro(t);
  const { default: handler } = await loadHandler();

  for (const matchedDomains of [undefined, [], 'not-an-array', Array.from({ length: 21 }, (_, i) => `d${i}.com`)]) {
    const res = mockRes();
    await handler({ method: 'POST', body: { ...baseBody, matchedDomains } }, res);
    assert.equal(res.statusCode, 400, `matchedDomains=${JSON.stringify(matchedDomains)?.slice(0, 40)} should be rejected`);
  }
});

test('rejects a non-string/empty entry in matchedDomains', async (t) => {
  withKey();
  stubPro(t);
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, matchedDomains: ['example.com', ''] } }, res);
  assert.equal(res.statusCode, 400);
});

test('a free-tier user gets 403 pro_required, verified via a direct server-side plan_status lookup, and Anthropic is never called', async (t) => {
  withKey();
  const capture = {};
  stubFree(t, capture);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Anthropic should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'pro_required');
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(capture.table, 'users');
  assert.equal(capture.select, 'plan_status');
  assert.equal(capture.eq.col, 'id');
  assert.equal(capture.eq.val, VALID_UID);
});

test('a userId with no row yet (plan_status lookup returns null) is treated as not-Pro, not an error', async (t) => {
  withKey();
  stubSupabase(t, async () => ({ data: null, error: null }));
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Anthropic should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'pro_required');
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a client-supplied isPro-style flag is ignored entirely -- only the server-side plan_status lookup decides', async (t) => {
  withKey();
  stubFree(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Anthropic should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, isPro: true, plan_status: 'active' } }, res);

  assert.equal(res.statusCode, 403, 'a free user must be blocked even if the request body claims Pro status');
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a Supabase lookup error fails closed (500), never proceeds to Anthropic', async (t) => {
  withKey();
  stubSupabase(t, async () => ({ data: null, error: { message: 'connection refused' } }));
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Anthropic should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a Pro user gets a 200 with the generated advice text, and Anthropic is called with the domain list', async (t) => {
  withKey();
  stubPro(t);
  let capturedBody;
  let capturedHeaders;
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    capturedHeaders = opts.headers;
    return anthropicOk('1. Report on Instagram via their impersonation flow.\n2. Contact example.com\'s abuse address.')();
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 200);
  assert.match(res.body.advice, /Instagram/);
  assert.equal(capturedHeaders['x-api-key'], 'test-anthropic-key');
  assert.equal(capturedBody.model, 'claude-sonnet-5');
  assert.equal(capturedBody.max_tokens, 500);
  assert.match(capturedBody.system, /Inspector Catchworth/);
  assert.match(capturedBody.messages[0].content, /instagram\.com/);
  assert.match(capturedBody.messages[0].content, /example\.com/);
  assert.match(capturedBody.messages[0].content, /profile photo/);
});

test('photoContext defaults to "profile photo" when missing, and is bounded when oversized', async (t) => {
  withKey();
  stubPro(t);
  let capturedBody;
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return anthropicOk('steps')();
  });

  const { default: handler } = await loadHandler();
  const res1 = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, matchedDomains: ['a.com'] } }, res1);
  assert.equal(res1.statusCode, 200);
  assert.match(capturedBody.messages[0].content, /profile photo/);

  const res2 = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, matchedDomains: ['a.com'], photoContext: 'x'.repeat(500) } }, res2);
  assert.equal(res2.statusCode, 200);
  const contextInPrompt = capturedBody.messages[0].content.match(/A user's (x+)/)[1];
  assert.ok(contextInPrompt.length <= 100, 'photoContext must be bounded to MAX_CONTEXT_LEN');
});

test('the INSPECTOR_SYSTEM prompt never claims to be a lawyer, never guarantees removal, and points to FTC/IC3 for scam-adjacent cases', async (t) => {
  const { INSPECTOR_SYSTEM } = await loadHandler();
  assert.match(INSPECTOR_SYSTEM, /Inspector Catchworth/);
  assert.match(INSPECTOR_SYSTEM, /never claim to be a lawyer|Never claim to be a lawyer/i);
  assert.match(INSPECTOR_SYSTEM, /never claim removal is guaranteed|Never claim removal is guaranteed/i);
  assert.match(INSPECTOR_SYSTEM, /reportfraud\.ftc\.gov/);
  assert.match(INSPECTOR_SYSTEM, /ic3\.gov/);
  assert.match(INSPECTOR_SYSTEM, /DMCA/);
  assert.match(INSPECTOR_SYSTEM, /200 words/);
  assert.match(INSPECTOR_SYSTEM, /Do NOT draft|Do not draft/);
});

test('missing ANTHROPIC_API_KEY degrades gracefully (500, no crash, no key leaked)', async (t) => {
  delete process.env.ANTHROPIC_API_KEY;
  stubPro(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Anthropic should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Server error. Please try again.');
  assert.equal(fetchMock.mock.callCount(), 0);

  withKey();
});

test('an Anthropic API-level error response is a clean error status, no crash, no raw error leaked', async (t) => {
  withKey();
  stubPro(t);
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { type: 'authentication_error', message: 'invalid x-api-key' } })
  }));

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 401);
  assert.doesNotMatch(res.body.error, /invalid x-api-key/);
});

test('an empty/whitespace-only advice response from Anthropic is a clean 500, not a broken 200', async (t) => {
  withKey();
  stubPro(t);
  t.mock.method(globalThis, 'fetch', async () => anthropicOk('   ')());

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 500);
});

test('a timeout (AbortError) is a clean 504, not a crash', async (t) => {
  withKey();
  stubPro(t);
  t.mock.method(globalThis, 'fetch', async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 504);
  assert.match(res.body.error, /timed out/i);
});

test('rejects non-POST methods', async (t) => {
  withKey();
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'GET', body: baseBody }, res);
  assert.equal(res.statusCode, 405);
});
