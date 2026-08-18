// Tests sw.js's Web Share Target handling (handleShareTarget) in complete
// isolation from a real browser/service-worker environment. sw.js is loaded
// with `node:vm` into a sandbox that stands in for the ServiceWorkerGlobalScope
// (self, caches, addEventListener, clients.claim) -- this is the same script
// that ships to the browser, unmodified, so these tests exercise the actual
// production logic, not a reimplementation of it.
//
// This complements (but does not replace) manual on-device verification of
// the real OS share intent -- see the PR description for why full end-to-end
// share-target behavior can't be reliably simulated outside a real Android
// install.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SW_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

// Real Cache.match/put/delete accept either a string URL or a Request; both
// get normalized to a URL string internally by the real Cache Storage API,
// so this mock does the same.
function normalizeCacheKey(key) {
  if (typeof key === 'string') return key;
  if (key && typeof key.url === 'string') return key.url;
  return String(key);
}

function createMockCaches() {
  const store = new Map(); // cacheName -> Map(url -> Response)
  return {
    async open(name) {
      if (!store.has(name)) store.set(name, new Map());
      const cacheMap = store.get(name);
      return {
        async match(key) { return cacheMap.get(normalizeCacheKey(key)); },
        async put(key, response) { cacheMap.set(normalizeCacheKey(key), response); },
        async delete(key) { return cacheMap.delete(normalizeCacheKey(key)); },
      };
    },
    // The real global CacheStorage also exposes a top-level match() that
    // searches every open cache -- sw.js's default fetch-fallback path
    // relies on this.
    async match(key) {
      const k = normalizeCacheKey(key);
      for (const cacheMap of store.values()) {
        if (cacheMap.has(k)) return cacheMap.get(k);
      }
      return undefined;
    },
    async keys() { return Array.from(store.keys()); },
    async delete(name) { return store.delete(name); },
    _store: store,
  };
}

// Loads a fresh copy of sw.js into a new sandbox for each test, so state
// (like the mock cache) never leaks between tests.
// Node's global Response.redirect() (undici) requires an absolute URL; a
// real ServiceWorkerGlobalScope resolves a relative one (like sw.js's own
// '/?share=1') against the SW's own location automatically. This subclass
// makes the sandbox's Response behave the same way sw.js can rely on in an
// actual browser, without changing sw.js itself.
class SandboxResponse extends Response {
  static redirect(url, status) {
    return Response.redirect(new URL(url, 'http://localhost/').toString(), status);
  }
}

function loadSW() {
  const mockCaches = createMockCaches();
  const listeners = {};
  const fetchCalls = [];
  const sandbox = {
    caches: mockCaches,
    Response: SandboxResponse,
    Request,
    URL,
    fetch: async (...args) => { fetchCalls.push(args); return new Response('ok'); },
    console,
  };
  sandbox.self = sandbox;
  sandbox.addEventListener = (name, fn) => { listeners[name] = fn; };
  sandbox.skipWaiting = () => {};
  sandbox.clients = { claim: async () => {} };
  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, sandbox, { filename: 'sw.js' });
  return { sandbox, mockCaches, listeners, fetchCalls };
}

function buildShareRequest({ title = '', text = '', url = '', photoBytes, photoType = 'image/jpeg', photoName = 'shared.jpg' } = {}) {
  const fd = new FormData();
  fd.append('title', title);
  fd.append('text', text);
  fd.append('url', url);
  if (photoBytes) {
    fd.append('photos', new Blob([photoBytes], { type: photoType }), photoName);
  }
  return new Request('http://localhost/share-target', { method: 'POST', body: fd });
}

test('handleShareTarget: text-only share stores payload with hasPhoto:false and no photo key', async () => {
  const { sandbox, mockCaches } = loadSW();
  const req = buildShareRequest({ title: 'Hello', text: 'World', url: 'https://example.com' });

  const resp = await sandbox.handleShareTarget(req);

  assert.equal(resp.status, 303);
  assert.equal(new URL(resp.headers.get('location')).pathname + new URL(resp.headers.get('location')).search, '/?share=1');

  const cache = await mockCaches.open('catchfish-share-v1');
  const payloadResp = await cache.match('/__share-payload');
  assert.ok(payloadResp, 'payload should be stored');
  const payload = await payloadResp.json();
  assert.deepEqual(payload, { title: 'Hello', text: 'World', url: 'https://example.com', hasPhoto: false });

  const photoResp = await cache.match('/__share-photo');
  assert.equal(photoResp, undefined, 'no photo key should be written when nothing was shared');
});

test('handleShareTarget: shared photo is stored byte-for-byte with the right content type', async () => {
  const { sandbox, mockCaches } = loadSW();
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]);
  const req = buildShareRequest({ photoBytes: bytes, photoType: 'image/png' });

  await sandbox.handleShareTarget(req);

  const cache = await mockCaches.open('catchfish-share-v1');
  const photoResp = await cache.match('/__share-photo');
  assert.ok(photoResp, 'photo should be stored');
  assert.equal(photoResp.headers.get('content-type'), 'image/png');
  const storedBuf = new Uint8Array(await photoResp.arrayBuffer());
  assert.deepEqual(Array.from(storedBuf), Array.from(bytes), 'stored bytes must exactly match the shared photo, never altered');

  const payload = await (await cache.match('/__share-payload')).json();
  assert.equal(payload.hasPhoto, true);
});

test('handleShareTarget: a zero-byte "photos" entry (field present but empty) is treated as no photo', async () => {
  const { sandbox, mockCaches } = loadSW();
  const req = buildShareRequest({ photoBytes: new Uint8Array([]) });

  await sandbox.handleShareTarget(req);

  const cache = await mockCaches.open('catchfish-share-v1');
  assert.equal(await cache.match('/__share-photo'), undefined);
  const payload = await (await cache.match('/__share-payload')).json();
  assert.equal(payload.hasPhoto, false);
});

test('handleShareTarget: a new share fully replaces a stale, unconsumed previous share', async () => {
  const { sandbox, mockCaches } = loadSW();

  // First share: has a photo.
  await sandbox.handleShareTarget(buildShareRequest({ photoBytes: new Uint8Array([9, 9, 9]) }));
  const cache = await mockCaches.open('catchfish-share-v1');
  assert.ok(await cache.match('/__share-photo'), 'sanity check: first share stored a photo');

  // Second share (user shared again before the app was ever opened to
  // consume the first one): text-only, no photo this time.
  await sandbox.handleShareTarget(buildShareRequest({ text: 'second share, no photo' }));

  assert.equal(await cache.match('/__share-photo'), undefined, 'stale photo from the first share must not survive into the second');
  const payload = await (await cache.match('/__share-payload')).json();
  assert.equal(payload.text, 'second share, no photo');
  assert.equal(payload.hasPhoto, false);
});

test('handleShareTarget: still redirects cleanly if formData() parsing throws', async () => {
  const { sandbox } = loadSW();
  const brokenRequest = { formData: async () => { throw new Error('malformed multipart body'); } };

  const resp = await sandbox.handleShareTarget(brokenRequest);

  assert.equal(resp.status, 303);
  const loc = new URL(resp.headers.get('location'));
  assert.equal(loc.pathname + loc.search, '/?share=1', 'user must land back in the app even if the share payload was unparseable');
});

test('handleShareTarget: never calls fetch() -- nothing shared leaves the device via this path', async () => {
  const { sandbox, fetchCalls } = loadSW();
  const resp = await sandbox.handleShareTarget(buildShareRequest({ photoBytes: new Uint8Array([1, 2, 3]) }));
  assert.equal(resp.status, 303);
  assert.equal(fetchCalls.length, 0, 'handleShareTarget must never call fetch()');
});

test('static scan: handleShareTarget\'s own source contains no fetch( call at all', () => {
  const match = SW_SOURCE.match(/async function handleShareTarget[\s\S]*?\n}\n/);
  assert.ok(match, 'could not locate handleShareTarget in sw.js for static scan');
  assert.ok(!/\bfetch\s*\(/.test(match[0]), 'handleShareTarget must never call fetch() -- shared content must never leave the device');
});

test('fetch handler: a POST to /share-target is routed to handleShareTarget, not the normal cache-or-network path', async () => {
  const { sandbox, listeners } = loadSW();
  let handledByShareTarget = false;
  sandbox.handleShareTarget = async () => { handledByShareTarget = true; return new Response(null, { status: 303, headers: { Location: '/?share=1' } }); };

  let respondWithArg = null;
  const fakeEvent = {
    request: new Request('http://localhost/share-target', { method: 'POST', body: new FormData() }),
    respondWith(p) { respondWithArg = p; },
  };
  listeners.fetch(fakeEvent);
  await respondWithArg;
  assert.ok(handledByShareTarget, 'POST /share-target must be dispatched to handleShareTarget');
});

test('fetch handler: a normal GET request is NOT routed to handleShareTarget (no-op on unrelated traffic)', async () => {
  const { sandbox, listeners, mockCaches } = loadSW();
  let handledByShareTarget = false;
  sandbox.handleShareTarget = async () => { handledByShareTarget = true; return new Response(); };

  const fakeEvent = {
    request: new Request('http://localhost/index.html', { method: 'GET' }),
    respondWith(p) { p.catch(() => {}); },
  };
  listeners.fetch(fakeEvent);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(handledByShareTarget, false, 'ordinary GET requests must be completely unaffected by the share-target addition');
});

test('activate handler: waits for clients.claim() before completing (no race where the SW reports active before it actually controls the page)', async () => {
  const { sandbox, listeners } = loadSW();
  let claimResolved = false;
  let claimCalled = false;
  sandbox.clients.claim = () => {
    claimCalled = true;
    return new Promise((resolve) => setTimeout(() => { claimResolved = true; resolve(); }, 5));
  };

  let waitUntilPromise = null;
  const fakeEvent = { waitUntil(p) { waitUntilPromise = p; } };
  listeners.activate(fakeEvent);
  assert.ok(waitUntilPromise, 'activate handler must call event.waitUntil()');
  await waitUntilPromise;
  assert.ok(claimCalled, 'clients.claim() must be called during activate');
  assert.ok(claimResolved, 'event.waitUntil() must not resolve until clients.claim() itself has resolved');
});
