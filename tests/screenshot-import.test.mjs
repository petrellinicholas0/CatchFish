// Run with: node --experimental-test-module-mocks --test tests/*.test.mjs
// (also wired up as `npm test`)
//
// Covers the new /api/screenshot-import endpoint -- the "Import from
// Screenshot" feature's structuring call. Takes raw OCR text (already
// extracted client-side via api/ocr.js) and returns structured fields
// (content_type/platform/age/location/occupation/bio/messages).
//
// This is a convenience feature only, same architecture as api/ocr.js:
// it never calls check_and_increment_usage or touches plan_status/
// usage_count/credits, so there is no Supabase mock anywhere in this
// file -- if the handler ever reached for Supabase, that would itself be
// a regression worth catching, and the absence of any such stub here is
// part of what proves it doesn't. The client applies its own separate
// daily cap (cf_import_usage/cf_import_reset) before ever calling this
// endpoint, which applies to Pro users too -- this endpoint itself must
// never gate on plan_status.
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

test('rejects missing or invalid userId before ever calling Anthropic', async (t) => {
  withKey();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should never be called'); });

  const { default: handler } = await loadHandler();
  for (const userId of [undefined, '', 'not-a-uuid', 123]) {
    const res = mockRes();
    await handler({ method: 'POST', body: { userId, text: 'some OCR text' } }, res);
    assert.equal(res.statusCode, 400, `userId=${JSON.stringify(userId)} should be rejected`);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('rejects missing/empty text', async (t) => {
  withKey();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should never be called'); });

  const { default: handler } = await loadHandler();
  for (const text of [undefined, '', '   ']) {
    const res = mockRes();
    await handler({ method: 'POST', body: { userId: VALID_UID, text } }, res);
    assert.equal(res.statusCode, 400, `text=${JSON.stringify(text)} should be rejected`);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('never queries Supabase or requires plan_status -- pure convenience endpoint like api/ocr.js', async (t) => {
  withKey();
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
  t.mock.method(globalThis, 'fetch', async () => anthropicOk(conversationResult)());

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, text: 'hey! / hi there' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, conversationResult);
});

test('strips ```json fences from the model response before parsing', async (t) => {
  withKey();
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
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'not valid json {{{' }] }) }));

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, text: 'some text' } }, res);

  assert.equal(res.statusCode, 502);
});

test('a response with an invalid content_type is rejected', async (t) => {
  withKey();
  t.mock.method(globalThis, 'fetch', async () => anthropicOk({ ...profileResult, content_type: 'garbage' })());

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, text: 'some text' } }, res);

  assert.equal(res.statusCode, 502);
});

test('a response with a non-string/non-null field (e.g. a number) is rejected, not partially served', async (t) => {
  withKey();
  t.mock.method(globalThis, 'fetch', async () => anthropicOk({ ...profileResult, age: 29 })());

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, text: 'some text' } }, res);

  assert.equal(res.statusCode, 502);
});

test('an Anthropic API-level error response is a clean error status, no raw error leaked', async (t) => {
  withKey();
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
