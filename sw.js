const CACHE_NAME = 'catchfish-v4';
const urlsToCache = ['/', '/index.html', '/manifest.json'];

// Holds pending Web Share Target payloads only (title/text/url/photo from
// the OS share sheet) -- kept in its own cache, separate from CACHE_NAME's
// static-asset cache, so a future static-asset cache-name bump never wipes
// a share the user hasn't opened the app to consume yet.
const SHARE_CACHE_NAME = 'catchfish-share-v1';
const SHARE_PAYLOAD_KEY = '/__share-payload';
const SHARE_PHOTO_KEY = '/__share-photo';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME && n !== SHARE_CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

// Handles the OS "Share to CatchFish" action (see manifest.json's
// share_target). Everything here stays on-device: the shared title/text/url
// and any shared photo are read straight out of the POST body and written
// into the Cache Storage API -- never forwarded to any server, matching
// CatchFish's existing "we don't store or upload your photos" commitment.
// index.html's handleIncomingShare() picks this back up on next load and
// deletes it immediately once read, so it never replays on a later visit.
async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const title = (formData.get('title') || '').toString();
    const text = (formData.get('text') || '').toString();
    const url = (formData.get('url') || '').toString();
    const photo = formData.getAll('photos').find((f) => f && typeof f.size === 'number' && f.size > 0);

    const cache = await caches.open(SHARE_CACHE_NAME);
    await cache.delete(SHARE_PAYLOAD_KEY);
    await cache.delete(SHARE_PHOTO_KEY);

    if (photo) {
      await cache.put(SHARE_PHOTO_KEY, new Response(photo, { headers: { 'Content-Type': photo.type || 'image/jpeg' } }));
    }
    await cache.put(SHARE_PAYLOAD_KEY, new Response(JSON.stringify({ title, text, url, hasPhoto: !!photo }), { headers: { 'Content-Type': 'application/json' } }));
  } catch (e) {
    // Fall through to the redirect regardless -- the user should never be
    // left staring at a raw POST response just because parsing the share
    // payload failed.
  }
  // 303 turns the POST into a plain GET navigation, landing the user back
  // in the app with ?share=1 for handleIncomingShare() to notice.
  return Response.redirect('/?share=1', 303);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(handleShareTarget(event.request));
    return;
  }
  event.respondWith(
    caches.match(event.request).then((response) => response || fetch(event.request))
  );
});
