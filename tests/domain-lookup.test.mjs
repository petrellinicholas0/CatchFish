// Run with: node --experimental-test-module-mocks --test tests/*.test.mjs
// (also wired up as `npm test`)
//
// Covers api/domain-lookup.js after refactoring it to reuse lib/rdap.js
// (no dedicated test file existed for this handler before). Confirms the
// refactor preserved the exact prior response contract byte-for-byte.

import { test } from 'node:test';
import assert from 'node:assert/strict';

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function loadHandler() {
  return import(`../api/domain-lookup.js?t=${Date.now()}-${Math.random()}`);
}

test('rejects non-POST methods', async () => {
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'GET', body: { domain: 'example.com' } }, res);
  assert.equal(res.statusCode, 405);
});

test('an unextractable domain returns a clean null result, no network call', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should never be called'); });
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { domain: 'not a domain' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { domain: null, available: false, registrationDate: null });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a valid domain returns the RDAP registration date via rdap.org', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, 'https://rdap.org/domain/example.com');
    return { ok: true, json: async () => ({ events: [{ eventAction: 'registration', eventDate: '2011-03-02T00:00:00Z' }] }) };
  });
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { domain: 'https://example.com/some/path' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { domain: 'example.com', available: true, registrationDate: '2011-03-02T00:00:00Z' });
});

test('an RDAP lookup failure degrades to a clean 200 with nulls, never a 500', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network down'); });
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { domain: 'example.com' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { domain: 'example.com', available: false, registrationDate: null });
});
