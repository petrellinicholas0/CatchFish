// Run with: node --experimental-test-module-mocks --test tests/*.test.mjs
// (also wired up as `npm test`)
//
// Covers the new /api/reverse-search endpoint -- detects stolen/reused
// profile photos via Google Cloud Vision API's WEB_DETECTION, alongside
// (not instead of) the existing AI-authenticity check. Gated entirely
// independently of check_and_increment_usage / the free-analysis counter
// via check_and_increment_reverse_search (see supabase/migrations/
// 0009_add_reverse_search_gating.sql) -- free tier gets one lifetime free
// use, an unused single-purchase credit bundles it in at no extra cost,
// and Pro gets a HARD daily cap (not a soft cap like the 150/day analysis
// limit).
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

function stubSupabase(t, rpcImpl) {
  t.mock.module('../lib/supabaseAdmin.js', {
    namedExports: { getSupabaseAdmin: () => ({ rpc: rpcImpl }) }
  });
}

function stubAllowed(t) {
  stubSupabase(t, async () => ({ data: [{ o_allowed: true, o_reason: null }], error: null }));
}

async function loadHandler() {
  return import(`../api/reverse-search.js?t=${Date.now()}-${Math.random()}`);
}

const withKey = () => { process.env.GOOGLE_VISION_API_KEY = 'test-vision-key'; };

const VALID_UID = '11111111-1111-4111-8111-111111111111';
const baseBody = { images: ['img-a'], userId: VALID_UID };

test('rejects missing or invalid userId before ever calling Supabase or Vision', async (t) => {
  withKey();
  const rpc = t.mock.fn(async () => ({ data: [{ o_allowed: true }], error: null }));
  stubSupabase(t, rpc);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Vision should never be called'); });

  const { default: handler } = await loadHandler();
  for (const userId of [undefined, '', 'not-a-uuid', 123]) {
    const res = mockRes();
    await handler({ method: 'POST', body: { ...baseBody, userId } }, res);
    assert.equal(res.statusCode, 400, `userId=${JSON.stringify(userId)} should be rejected`);
  }
  assert.equal(rpc.mock.callCount(), 0);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('rejects missing/empty/non-array/oversized images, mirroring MAX_PHOTOS independent of the client', async (t) => {
  withKey();
  const rpc = t.mock.fn(async () => ({ data: [{ o_allowed: true }], error: null }));
  stubSupabase(t, rpc);
  const { default: handler } = await loadHandler();

  for (const images of [undefined, [], 'not-an-array', Array.from({ length: 7 }, (_, i) => `img${i}`)]) {
    const res = mockRes();
    await handler({ method: 'POST', body: { ...baseBody, images } }, res);
    assert.equal(res.statusCode, 400, `images=${JSON.stringify(images)?.slice(0, 40)} should be rejected`);
  }
  assert.equal(rpc.mock.callCount(), 0);
});

test('rejects a non-string/empty entry in images', async (t) => {
  withKey();
  stubSupabase(t, async () => ({ data: [{ o_allowed: true }], error: null }));
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, images: ['valid', ''] } }, res);
  assert.equal(res.statusCode, 400);
});

test('calls check_and_increment_reverse_search with PRO_DAILY_REVERSE_SEARCH_LIMIT=10 before ever touching Vision', async (t) => {
  withKey();
  let capturedArgs;
  stubSupabase(t, async (fn, args) => {
    capturedArgs = { fn, args };
    return { data: [{ o_allowed: true, o_reason: null }], error: null };
  });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ responses: [{}] }) }));

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(capturedArgs.fn, 'check_and_increment_reverse_search');
  assert.equal(capturedArgs.args.p_user_id, VALID_UID);
  assert.equal(capturedArgs.args.p_pro_daily_limit, 10);
});

test('denied with reason=free_limit_reached returns 403 and never calls Vision', async (t) => {
  withKey();
  stubSupabase(t, async () => ({ data: [{ o_allowed: false, o_reason: 'free_limit_reached' }], error: null }));
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Vision should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.reason, 'free_limit_reached');
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('denied with reason=pro_daily_limit_reached returns 403 with that exact reason', async (t) => {
  withKey();
  stubSupabase(t, async () => ({ data: [{ o_allowed: false, o_reason: 'pro_daily_limit_reached' }], error: null }));
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Vision should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.reason, 'pro_daily_limit_reached');
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a Supabase RPC error fails closed (500), never proceeds to Vision', async (t) => {
  withKey();
  stubSupabase(t, async () => ({ data: null, error: { message: 'connection refused' } }));
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Vision should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('batches all images into a single Vision WEB_DETECTION request, not one per image', async (t) => {
  withKey();
  stubAllowed(t);
  let callCount = 0;
  let capturedBody;
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    callCount++;
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ responses: [{}, {}, {}] }) };
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { images: ['img-a', 'img-b', 'img-c'], userId: VALID_UID } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(callCount, 1, 'must batch into a single HTTP call, not one per image');
  assert.equal(capturedBody.requests.length, 3);
  assert.equal(capturedBody.requests[0].image.content, 'img-a');
  assert.equal(capturedBody.requests[0].features[0].type, 'WEB_DETECTION');
});

test('uses the API key as a query-string param, not an x-api-key header', async (t) => {
  withKey();
  stubAllowed(t);
  let capturedUrl;
  let capturedHeaders;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    capturedUrl = url;
    capturedHeaders = opts.headers;
    return { ok: true, json: async () => ({ responses: [{}] }) };
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 200);
  assert.match(capturedUrl, /^https:\/\/vision\.googleapis\.com\/v1\/images:annotate\?key=test-vision-key$/);
  assert.equal(capturedHeaders['x-api-key'], undefined);
});

test('extracts matchCount (full + partial) and domain-only pages, preserving input order', async (t) => {
  withKey();
  stubAllowed(t);
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({
      responses: [
        {
          webDetection: {
            fullMatchingImages: [{ url: 'https://instagram.com/p/abc' }, { url: 'https://pinterest.com/pin/1' }],
            partialMatchingImages: [{ url: 'https://mirror.example/x' }],
            pagesWithMatchingImages: [
              { url: 'https://instagram.com/p/abc', pageTitle: 'Some post' },
              { url: 'https://pinterest.com/pin/1' }
            ]
          }
        },
        { webDetection: { fullMatchingImages: [], partialMatchingImages: [], pagesWithMatchingImages: [] } }
      ]
    })
  }));

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { images: ['img-a', 'img-b'], userId: VALID_UID } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results.length, 2);
  assert.equal(res.body.results[0].matchCount, 3);
  assert.deepEqual(res.body.results[0].pages, [
    { url: 'instagram.com', title: 'Some post' },
    { url: 'pinterest.com', title: null }
  ]);
  assert.equal(res.body.results[1].matchCount, 0);
  assert.deepEqual(res.body.results[1].pages, []);
});

test('an image with no webDetection contributes matchCount:0/pages:[] rather than an error, and does not fail the batch', async (t) => {
  withKey();
  stubAllowed(t);
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ responses: [{ webDetection: { fullMatchingImages: [{ url: 'https://a.com' }] } }, {}] })
  }));

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { images: ['img-a', 'img-b'], userId: VALID_UID } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results[1].matchCount, 0);
  assert.deepEqual(res.body.results[1].pages, []);
});

test('a per-image Vision error contributes matchCount:0/pages:[] rather than failing the whole batch', async (t) => {
  withKey();
  stubAllowed(t);
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({
      responses: [
        { webDetection: { fullMatchingImages: [{ url: 'https://a.com' }] } },
        { error: { code: 3, message: 'Bad image data.' } }
      ]
    })
  }));

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { images: ['img-a', 'img-b'], userId: VALID_UID } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results[0].matchCount, 1);
  assert.equal(res.body.results[1].matchCount, 0);
});

test('never leaks full URLs -- only the domain (hostname) is ever returned', async (t) => {
  withKey();
  stubAllowed(t);
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({
      responses: [{
        webDetection: {
          fullMatchingImages: [{ url: 'https://example.com/deep/path?token=secret123' }],
          pagesWithMatchingImages: [{ url: 'https://example.com/deep/path?token=secret123', pageTitle: 'x' }]
        }
      }]
    })
  }));

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results[0].pages[0].url, 'example.com');
  assert.doesNotMatch(res.body.results[0].pages[0].url, /secret123|deep\/path/);
});

test('missing GOOGLE_VISION_API_KEY degrades gracefully (500, no crash, no key leaked)', async (t) => {
  delete process.env.GOOGLE_VISION_API_KEY;
  stubAllowed(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Vision should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Server error. Please try again.');
  assert.equal(fetchMock.mock.callCount(), 0);

  withKey();
});

test('a Vision API-level error response is a clean 500, no crash, no raw error leaked', async (t) => {
  withKey();
  stubAllowed(t);
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: { code: 403, message: 'API key not valid.' } })
  }));

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(res.body.error, /API key not valid/);
});

test('a timeout (AbortError) is a clean 504, not a crash', async (t) => {
  withKey();
  stubAllowed(t);
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
