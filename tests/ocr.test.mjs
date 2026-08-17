// Run with: node --experimental-test-module-mocks --test tests/*.test.mjs
// (also wired up as `npm test`)
//
// Covers the /api/ocr endpoint -- extracts visible text from uploaded
// photos via Google Cloud Vision API's TEXT_DETECTION, so a user who
// screenshots a dating profile doesn't have to manually retype the bio.
// This is a convenience feature only: it never calls check_and_increment_
// usage or touches plan_status/usage_count/credits, so there is no
// Supabase mock anywhere in this file -- if the handler ever reached for
// Supabase, that would itself be a regression worth catching, and the
// absence of any such stub here is part of what proves it doesn't.
//
// Security review finding: this endpoint used to accept {images} from
// anyone, with no userId and no rate limiting at all -- an uncapped,
// unauthenticated relay to a paid Vision API call. It now requires a
// UUID-shaped userId on every request (same UUID_RE pattern used
// everywhere else in the API surface) and enforces the same IP-based rate
// limit api/analyze.js already uses as a baseline defense-in-depth layer.
// It is still deliberately NOT gated by any per-user daily-cap RPC -- the
// plain "Extract Text From Photos" button must keep working ungated.
//
// Every fetch mock is registered via the per-test `t.mock` tracker so
// it's always restored, pass or fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function stubVisionFetch(t, impl) {
  return t.mock.method(globalThis, 'fetch', impl);
}

async function loadHandler() {
  return import(`../api/ocr.js?t=${Date.now()}-${Math.random()}`);
}

const withKey = () => { process.env.GOOGLE_VISION_API_KEY = 'test-vision-key'; };

const VALID_UID = '11111111-1111-4111-8111-111111111111';

test('rejects missing/invalid userId before ever calling Vision', async (t) => {
  withKey();
  const fetchMock = stubVisionFetch(t, async () => { throw new Error('Vision API should never be called'); });
  const { default: handler } = await loadHandler();
  for (const userId of [undefined, '', 'not-a-uuid', 123]) {
    const res = mockRes();
    await handler({ method: 'POST', body: { userId, images: ['img-a'] } }, res);
    assert.equal(res.statusCode, 400, `userId=${JSON.stringify(userId)} should be rejected`);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('rejects missing images field', async (t) => {
  withKey();
  const fetchMock = stubVisionFetch(t, async () => { throw new Error('Vision API should never be called'); });
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('rejects a non-array images value without crashing (a short string has no .every method)', async (t) => {
  withKey();
  const fetchMock = stubVisionFetch(t, async () => { throw new Error('Vision API should never be called'); });
  const { default: handler } = await loadHandler();

  for (const images of ['abc', {}, 42, true]) {
    const res = mockRes();
    await handler({ method: 'POST', body: { userId: VALID_UID, images } }, res);
    assert.equal(res.statusCode, 400, `images=${JSON.stringify(images)} should be rejected with 400, not crash`);
    assert.equal(res.body.error, 'Missing or empty images array');
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('rejects an empty images array', async (t) => {
  withKey();
  stubVisionFetch(t, async () => { throw new Error('Vision API should never be called'); });
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, images: [] } }, res);
  assert.equal(res.statusCode, 400);
});

test('rejects more than 6 images (mirrors MAX_PHOTOS independent of the client)', async (t) => {
  withKey();
  const fetchMock = stubVisionFetch(t, async () => { throw new Error('Vision API should never be called'); });
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, images: Array.from({ length: 7 }, (_, i) => `img${i}`) } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /6/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('accepts exactly 6 images', async (t) => {
  withKey();
  stubVisionFetch(t, async () => ({
    ok: true,
    json: async () => ({ responses: Array.from({ length: 6 }, () => ({ fullTextAnnotation: { text: 'hi' } })) })
  }));
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, images: Array.from({ length: 6 }, (_, i) => `img${i}`) } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.texts.length, 6);
});

test('rejects an images array containing a non-string or empty-string entry', async (t) => {
  withKey();
  const fetchMock = stubVisionFetch(t, async () => { throw new Error('Vision API should never be called'); });
  const { default: handler } = await loadHandler();

  for (const images of [['valid', 123], ['valid', ''], [null], [undefined]]) {
    const res = mockRes();
    await handler({ method: 'POST', body: { userId: VALID_UID, images } }, res);
    assert.equal(res.statusCode, 400, `images=${JSON.stringify(images)} should be rejected`);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('batches all images into a single Vision API request, not one call per image', async (t) => {
  withKey();
  let callCount = 0;
  let capturedBody;
  stubVisionFetch(t, async (_url, opts) => {
    callCount++;
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({ responses: [{ fullTextAnnotation: { text: 'a' } }, { fullTextAnnotation: { text: 'b' } }, {}] })
    };
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, images: ['img-a', 'img-b', 'img-c'] } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(callCount, 1, 'must batch into a single HTTP call, not one per image');
  assert.equal(capturedBody.requests.length, 3);
  assert.equal(capturedBody.requests[0].image.content, 'img-a');
  assert.equal(capturedBody.requests[0].features[0].type, 'TEXT_DETECTION');
});

test('uses the API key as a query-string param, not an x-api-key header (unlike Anthropic)', async (t) => {
  withKey();
  let capturedUrl;
  let capturedHeaders;
  stubVisionFetch(t, async (url, opts) => {
    capturedUrl = url;
    capturedHeaders = opts.headers;
    return { ok: true, json: async () => ({ responses: [{ fullTextAnnotation: { text: 'x' } }] }) };
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, images: ['img-a'] } }, res);

  assert.equal(res.statusCode, 200);
  assert.match(capturedUrl, /^https:\/\/vision\.googleapis\.com\/v1\/images:annotate\?key=test-vision-key$/);
  assert.equal(capturedHeaders['x-api-key'], undefined, 'must not use an x-api-key header for this API');
});

test('extracts fullTextAnnotation.text per image, preserving input order', async (t) => {
  withKey();
  stubVisionFetch(t, async () => ({
    ok: true,
    json: async () => ({
      responses: [
        { fullTextAnnotation: { text: 'first image text' } },
        { fullTextAnnotation: { text: 'second image text' } }
      ]
    })
  }));

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, images: ['img-a', 'img-b'] } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.texts, ['first image text', 'second image text']);
});

test('an image with no detected text contributes an empty string, not an error, and does not fail the batch', async (t) => {
  withKey();
  stubVisionFetch(t, async () => ({
    ok: true,
    json: async () => ({
      responses: [
        { fullTextAnnotation: { text: 'has text' } },
        {}, // Vision's real shape for "nothing detected" -- no fullTextAnnotation key at all
        { textAnnotations: [] } // another no-text shape Vision can return
      ]
    })
  }));

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, images: ['img-a', 'img-b', 'img-c'] } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.texts, ['has text', '', '']);
});

test('a per-image Vision error contributes an empty string rather than failing the whole batch', async (t) => {
  withKey();
  stubVisionFetch(t, async () => ({
    ok: true,
    json: async () => ({
      responses: [
        { fullTextAnnotation: { text: 'fine' } },
        { error: { code: 3, message: 'Bad image data.' } }
      ]
    })
  }));

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, images: ['img-a', 'img-b'] } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.texts, ['fine', '']);
});

test('missing GOOGLE_VISION_API_KEY degrades gracefully (500, no crash, no key leaked)', async (t) => {
  delete process.env.GOOGLE_VISION_API_KEY;
  const fetchMock = stubVisionFetch(t, async () => { throw new Error('Vision API should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, images: ['img-a'] } }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Server error. Please try again.');
  assert.equal(fetchMock.mock.callCount(), 0);

  withKey(); // restore for subsequent tests in this process
});

test('a Vision API-level error response (bad key, quota) is a clean 500, no crash', async (t) => {
  withKey();
  stubVisionFetch(t, async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: { code: 403, message: 'API key not valid.' } })
  }));

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, images: ['img-a'] } }, res);

  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(res.body.error, /API key not valid/, 'must not leak the raw Vision error to the client');
});

test('a network-level fetch failure (thrown error) is a clean 500, no crash', async (t) => {
  withKey();
  stubVisionFetch(t, async () => { throw new Error('getaddrinfo ENOTFOUND vision.googleapis.com'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, images: ['img-a'] } }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Server error. Please try again.');
});

test('a timeout (AbortError) is a clean 504, not a crash', async (t) => {
  withKey();
  stubVisionFetch(t, async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, images: ['img-a'] } }, res);

  assert.equal(res.statusCode, 504);
  assert.match(res.body.error, /timed out/i);
});

test('rejects non-POST methods', async (t) => {
  withKey();
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'GET', body: { userId: VALID_UID, images: ['img-a'] } }, res);
  assert.equal(res.statusCode, 405);
});

// ════════════════════ IP-based rate limiting (baseline defense) ═════════
// This endpoint has no per-userId gating RPC at all, so the IP-based
// throttle is the only thing standing between it and an unlimited script
// that mints a fresh userId per request. Same threshold/window as
// api/analyze.js's own checkIpRateLimit.

test('IP rate limit: many requests from the same IP with different fresh userIds get rate-limited once the threshold is hit', async (t) => {
  withKey();
  stubVisionFetch(t, async () => ({ ok: true, json: async () => ({ responses: [{ fullTextAnnotation: { text: 'x' } }] }) }));

  // One handler instance for this whole test, so its module-level
  // in-memory rate-limit counter persists across every call below.
  const { default: handler } = await loadHandler();
  const sameIp = '203.0.113.77';
  const statuses = [];

  for (let i = 0; i < 12; i++) {
    const res = mockRes();
    await handler({
      method: 'POST',
      headers: { 'x-forwarded-for': sameIp },
      body: { userId: crypto.randomUUID(), images: ['img-a'] }
    }, res);
    statuses.push(res.statusCode);
  }

  const allowedCount = statuses.filter((s) => s === 200).length;
  const limitedCount = statuses.filter((s) => s === 429).length;

  assert.equal(allowedCount, 10, `expected exactly 10 allowed (IP_RATE_LIMIT), got statuses: ${statuses}`);
  assert.equal(limitedCount, 2, `expected the last 2 of 12 to be 429-rate-limited, got statuses: ${statuses}`);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
  assert.deepEqual(statuses.slice(10), [429, 429]);
});

test('IP rate limit: a different IP is unaffected by another IP already being at its limit', async (t) => {
  withKey();
  stubVisionFetch(t, async () => ({ ok: true, json: async () => ({ responses: [{ fullTextAnnotation: { text: 'x' } }] }) }));

  const { default: handler } = await loadHandler();

  for (let i = 0; i < 10; i++) {
    const res = mockRes();
    await handler({ method: 'POST', headers: { 'x-forwarded-for': '203.0.113.88' }, body: { userId: crypto.randomUUID(), images: ['img-a'] } }, res);
    assert.equal(res.statusCode, 200);
  }
  const exhausted = mockRes();
  await handler({ method: 'POST', headers: { 'x-forwarded-for': '203.0.113.88' }, body: { userId: crypto.randomUUID(), images: ['img-a'] } }, exhausted);
  assert.equal(exhausted.statusCode, 429);

  const otherIp = mockRes();
  await handler({ method: 'POST', headers: { 'x-forwarded-for': '198.51.100.42' }, body: { userId: crypto.randomUUID(), images: ['img-a'] } }, otherIp);
  assert.equal(otherIp.statusCode, 200, 'a different IP must not be affected by another IP being rate-limited');
});

test('IP rate limit: missing x-forwarded-for fails open rather than blocking every request', async (t) => {
  withKey();
  stubVisionFetch(t, async () => ({ ok: true, json: async () => ({ responses: [{ fullTextAnnotation: { text: 'x' } }] }) }));

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', headers: {}, body: { userId: VALID_UID, images: ['img-a'] } }, res);
  assert.equal(res.statusCode, 200);
});
