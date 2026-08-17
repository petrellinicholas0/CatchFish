// Run with: node --experimental-test-module-mocks --test tests/*.test.mjs
// (also wired up as `npm test`)
//
// Covers lib/rdap.js -- extracted from api/domain-lookup.js so
// api/evidence-packet.js can reuse the exact same RDAP lookup logic
// without duplicating it. This locks in the pre-extraction behavior
// (there was no dedicated test file for the logic before the extraction).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDomain, lookupDomainRegistration } from '../lib/rdap.js';

test('extractDomain: strips protocol, path, query, port, and userinfo', () => {
  assert.equal(extractDomain('https://example.com/deep/path?x=1'), 'example.com');
  assert.equal(extractDomain('http://example.com:8080'), 'example.com');
  assert.equal(extractDomain('user@example.com'), 'example.com');
  assert.equal(extractDomain('EXAMPLE.com'), 'example.com');
  assert.equal(extractDomain('  example.com  '), 'example.com');
});

test('extractDomain: rejects non-domain-shaped input rather than guessing', () => {
  for (const input of [null, undefined, '', '   ', 'not a domain', 'localhost', 42]) {
    assert.equal(extractDomain(input), null, `input=${JSON.stringify(input)}`);
  }
});

test('lookupDomainRegistration: null domain short-circuits without a network call', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should never be called'); });
  const result = await lookupDomainRegistration(null);
  assert.deepEqual(result, { domain: null, available: false, registrationDate: null });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('lookupDomainRegistration: extracts the registration event date on success', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    assert.equal(url, 'https://rdap.org/domain/example.com');
    assert.equal(opts.headers.Accept, 'application/rdap+json');
    return {
      ok: true,
      json: async () => ({
        events: [
          { eventAction: 'last changed', eventDate: '2024-01-01T00:00:00Z' },
          { eventAction: 'registration', eventDate: '2011-03-02T00:00:00Z' }
        ]
      })
    };
  });
  const result = await lookupDomainRegistration('example.com');
  assert.deepEqual(result, { domain: 'example.com', available: true, registrationDate: '2011-03-02T00:00:00Z' });
});

test('lookupDomainRegistration: no registration event -> available:false, registrationDate:null', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ events: [] }) }));
  const result = await lookupDomainRegistration('example.com');
  assert.deepEqual(result, { domain: 'example.com', available: false, registrationDate: null });
});

test('lookupDomainRegistration: non-ok response degrades gracefully, no throw', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 404, json: async () => ({}) }));
  const result = await lookupDomainRegistration('nonexistent-domain-xyz.com');
  assert.deepEqual(result, { domain: 'nonexistent-domain-xyz.com', available: false, registrationDate: null });
});

test('lookupDomainRegistration: network error/timeout degrades gracefully, no throw', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network down'); });
  const result = await lookupDomainRegistration('example.com');
  assert.deepEqual(result, { domain: 'example.com', available: false, registrationDate: null });
});
