// Run with: node --experimental-test-module-mocks --test tests/*.test.mjs
// (also wired up as `npm test`)
//
// Covers the new /api/evidence-packet endpoint -- a Pro-only, pure
// data-formatting feature (NOT an AI feature: no Anthropic API call
// anywhere) that compiles reverse-search results + RDAP domain-age
// lookups into a structured evidence document. Pro status is verified
// server-side against the users table directly, same pattern as
// api/inspector-advice.js -- the client's S.isPro() check in index.html
// is a courtesy only, never trusted.
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

// RDAP lookups go through lib/rdap.js's own `fetch` call to rdap.org --
// mocked at the global fetch level (same as tests/rdap.test.mjs), never
// hitting the network.
function stubRdap(t, byDomain) {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const m = String(url).match(/^https:\/\/rdap\.org\/domain\/(.+)$/);
    if (!m) throw new Error('unexpected fetch in evidence-packet test: ' + url);
    const domain = decodeURIComponent(m[1]);
    const date = byDomain[domain];
    if (date === undefined) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({ events: [{ eventAction: 'registration', eventDate: date }] }) };
  });
}

async function loadHandler() {
  return import(`../api/evidence-packet.js?t=${Date.now()}-${Math.random()}`);
}

const VALID_UID = '11111111-1111-4111-8111-111111111111';

const onePhoto = [{
  matchCount: 3,
  pages: [{ url: 'instagram.com', title: 'A post' }],
  fullMatchingImages: ['https://instagram.com/p/abc'],
  partialMatchingImages: ['https://mirror.example/x'],
  visuallySimilarImages: ['https://similar.example/y'],
  pagesWithMatchingImages: [
    { url: 'https://instagram.com/p/abc', pageTitle: 'A post' },
    { url: 'https://mirror.example/x', pageTitle: null }
  ]
}];

const baseBody = { userId: VALID_UID, reverseSearchData: onePhoto, submittedText: 'Hi, hope you are well.' };

test('rejects missing or invalid userId before ever calling Supabase', async (t) => {
  const capture = {};
  stubPro(t, capture);
  const { default: handler } = await loadHandler();
  for (const userId of [undefined, '', 'not-a-uuid', 123]) {
    const res = mockRes();
    await handler({ method: 'POST', body: { ...baseBody, userId } }, res);
    assert.equal(res.statusCode, 400, `userId=${JSON.stringify(userId)} should be rejected`);
  }
  assert.equal(capture.table, undefined, 'Supabase should never be touched for an invalid userId');
});

test('rejects missing/empty/non-array/oversized reverseSearchData', async (t) => {
  stubPro(t);
  const { default: handler } = await loadHandler();
  for (const reverseSearchData of [undefined, [], 'not-an-array', Array.from({ length: 7 }, () => onePhoto[0])]) {
    const res = mockRes();
    await handler({ method: 'POST', body: { ...baseBody, reverseSearchData } }, res);
    assert.equal(res.statusCode, 400, `reverseSearchData=${JSON.stringify(reverseSearchData)?.slice(0, 40)} should be rejected`);
  }
});

test('a free-tier user gets 403 pro_required via a direct server-side plan_status lookup, and does zero RDAP lookups', async (t) => {
  const capture = {};
  stubFree(t, capture);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('RDAP should never be called'); });

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

test('a userId with no row yet is treated as not-Pro, not an error', async (t) => {
  stubSupabase(t, async () => ({ data: null, error: null }));
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('RDAP should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a client-supplied isPro-style flag is ignored -- only the server-side lookup decides', async (t) => {
  stubFree(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('RDAP should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, isPro: true, plan_status: 'active' } }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a Supabase lookup error fails closed (500), never proceeds to RDAP', async (t) => {
  stubSupabase(t, async () => ({ data: null, error: { message: 'connection refused' } }));
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('RDAP should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a Pro user gets a fully assembled, correctly-shaped packet with real RDAP dates', async (t) => {
  stubPro(t);
  stubRdap(t, { 'instagram.com': '2011-03-02T00:00:00Z', 'mirror.example': '2023-05-01T00:00:00Z' });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 200);
  const p = res.body;

  assert.match(p.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(p.exactMatches, [{ imageIndex: 0, url: 'https://instagram.com/p/abc' }]);
  assert.deepEqual(p.partialMatches, [{ imageIndex: 0, url: 'https://mirror.example/x' }]);
  assert.deepEqual(p.similarNotConfirmed, [{ imageIndex: 0, url: 'https://similar.example/y' }]);
  assert.deepEqual(p.pagesFound, [
    { url: 'https://instagram.com/p/abc', pageTitle: 'A post', domain: 'instagram.com', domainRegisteredDate: '2011-03-02T00:00:00Z' },
    { url: 'https://mirror.example/x', pageTitle: null, domain: 'mirror.example', domainRegisteredDate: '2023-05-01T00:00:00Z' }
  ]);
  assert.equal(p.submittedTextExcerpt, 'Hi, hope you are well.');
});

test('an RDAP lookup failure for one domain degrades that entry to domainRegisteredDate:null without failing the request', async (t) => {
  stubPro(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('rdap.org is down'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pagesFound[0].domainRegisteredDate, null);
  assert.equal(res.body.pagesFound[1].domainRegisteredDate, null);
});

test('unique domains are capped at 15 for RDAP lookups; pages beyond the cap still appear with domainRegisteredDate:null (not dropped)', async (t) => {
  stubPro(t);
  const lookedUp = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const domain = decodeURIComponent(String(url).replace('https://rdap.org/domain/', ''));
    lookedUp.push(domain);
    return { ok: true, json: async () => ({ events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }] }) };
  });

  const manyDomainsPhoto = [{
    fullMatchingImages: [],
    partialMatchingImages: [],
    visuallySimilarImages: [],
    pagesWithMatchingImages: Array.from({ length: 20 }, (_, i) => ({ url: `https://domain${i}.example/page`, pageTitle: `Page ${i}` }))
  }];

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, reverseSearchData: manyDomainsPhoto } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(lookedUp.length, 15, 'only the first 15 unique domains should trigger an RDAP call');
  assert.equal(res.body.pagesFound.length, 20, 'all 20 pages must still appear, not just the first 15');
  assert.notEqual(res.body.pagesFound[0].domainRegisteredDate, null);
  assert.equal(res.body.pagesFound[19].domainRegisteredDate, null, 'the 20th page, beyond the cap, was never looked up');
});

test('submittedText is truncated to a reasonable bound, and a non-string is treated as empty rather than crashing', async (t) => {
  stubPro(t);
  stubRdap(t, {});

  const { default: handler } = await loadHandler();

  const res1 = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, submittedText: 'x'.repeat(20000) } }, res1);
  assert.equal(res1.statusCode, 200);
  assert.ok(res1.body.submittedTextExcerpt.length <= 5000);

  const res2 = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, submittedText: 12345 } }, res2);
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.body.submittedTextExcerpt, '');

  const res3 = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, submittedText: undefined } }, res3);
  assert.equal(res3.statusCode, 200);
  assert.equal(res3.body.submittedTextExcerpt, '');
});

test('missing/malformed per-photo fields degrade to empty lists rather than crashing', async (t) => {
  stubPro(t);
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, reverseSearchData: [{}, { fullMatchingImages: 'not-an-array' }, null] } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.exactMatches, []);
  assert.deepEqual(res.body.partialMatches, []);
  assert.deepEqual(res.body.similarNotConfirmed, []);
  assert.deepEqual(res.body.pagesFound, []);
});

test('this endpoint never calls the Anthropic API -- no fetch to api.anthropic.com, ever', async (t) => {
  stubPro(t);
  const calledUrls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calledUrls.push(String(url));
    return { ok: true, json: async () => ({ events: [] }) };
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 200);
  assert.ok(calledUrls.length > 0, 'sanity check: RDAP calls did happen');
  for (const url of calledUrls) {
    assert.doesNotMatch(url, /anthropic/i);
  }
});

test('rejects non-POST methods', async () => {
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'GET', body: baseBody }, res);
  assert.equal(res.statusCode, 405);
});
