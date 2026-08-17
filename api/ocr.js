// Extracts visible text from uploaded photos via Google Cloud Vision API's
// TEXT_DETECTION feature, so a user who screenshots a dating profile
// doesn't have to manually retype the bio. This is a convenience feature
// only -- it never calls check_and_increment_usage and never touches
// plan_status/usage_count/credits in any way. Do not add usage/paywall
// gating here without a separate, explicit decision to do so.
//
// This endpoint used to accept {images} from anyone, with no userId and no
// rate limiting at all -- an uncapped, unauthenticated relay to a paid
// Vision API call (security review finding). It's still deliberately NOT
// gated by any per-user daily-cap RPC (the plain "Extract Text From
// Photos" button must keep working exactly as it always has, ungated,
// same as api/screenshot-import.js's own separate import cap must not
// apply here) -- but every request must now at least identify itself
// (UUID_RE, same pattern used across the rest of the API surface) and is
// bounded by the same IP-based rate limit api/analyze.js already uses as
// a baseline defense-in-depth layer, so a script can no longer hit Google
// Vision through this app with zero limit of any kind.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_PHOTOS = 6; // mirrors index.html's client-side cap; enforced here independently

// Vision API's TEXT_DETECTION is typically fast, well under this even for
// a full batch of 6 images -- bounded defensively so a slow/hung upstream
// call can't leave the client's "Extracting..." button stuck indefinitely.
const VISION_TIMEOUT_MS = 20000;

// ════════════════════ IP-BASED RATE LIMITING (defense in depth) ════════
// Same pattern, same accepted limitations, as api/analyze.js's own
// checkIpRateLimit -- see that file for the full rationale (plain
// in-memory counter, doesn't survive cold starts or span instances,
// x-forwarded-for is Vercel-set for real traffic but not a hard
// guarantee). This endpoint has no per-userId gating at all otherwise, so
// this is the only throttle standing between it and an unlimited script.
const IP_RATE_LIMIT = 10; // requests per IP per window
const IP_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const ipHits = new Map();

function extractClientIp(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (!xff) return null;
  const first = (Array.isArray(xff) ? xff[0] : xff).split(',')[0].trim();
  return first || null;
}

function checkIpRateLimit(ip) {
  if (!ip) return true;
  const now = Date.now();
  const entry = ipHits.get(ip);
  if (!entry || now - entry.windowStart >= IP_RATE_WINDOW_MS) {
    ipHits.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= IP_RATE_LIMIT) {
    return false;
  }
  entry.count += 1;
  return true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!checkIpRateLimit(extractClientIp(req))) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  const { images, userId } = req.body || {};

  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    return res.status(400).json({ error: 'Missing or invalid userId' });
  }
  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: 'Missing or empty images array' });
  }
  if (images.length > MAX_PHOTOS) {
    return res.status(400).json({ error: `Max ${MAX_PHOTOS} photos` });
  }
  if (!images.every((img) => typeof img === 'string' && img.length > 0)) {
    return res.status(400).json({ error: 'Each image must be a non-empty base64 string' });
  }

  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) {
    console.error('ocr.js error: Missing GOOGLE_VISION_API_KEY environment variable');
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);

  try {
    // Vision API accepts multiple images in a single request via the
    // `requests` array -- batching all of them into one call instead of
    // one HTTP round trip per image, which is both cheaper and faster.
    // Auth is a plain API key on the query string here, unlike Anthropic's
    // x-api-key header in api/analyze.js.
    const response = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: images.map((content) => ({
          image: { content },
          features: [{ type: 'TEXT_DETECTION' }]
        }))
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Vision API error:', data.error || data);
      return res.status(500).json({ error: 'Text extraction service error. Please try again.' });
    }

    const responses = Array.isArray(data.responses) ? data.responses : [];

    // Positionally aligned with `images` (same length, same order) so the
    // client can zip texts[i] back to the photo it came from. An image
    // with no detected text, or one Vision reported a per-image error for
    // (a single malformed image shouldn't fail the whole batch), simply
    // contributes '' here rather than an error -- the client is expected
    // to filter out empty entries before joining/inserting into Bio.
    const texts = images.map((_, i) => {
      const entry = responses[i];
      if (!entry || entry.error) return '';
      return typeof entry.fullTextAnnotation?.text === 'string' ? entry.fullTextAnnotation.text : '';
    });

    return res.status(200).json({ texts });
  } catch (err) {
    console.error('ocr.js error:', err);
    const message = err.name === 'AbortError' ? 'Text extraction timed out. Please try again.' : 'Server error. Please try again.';
    return res.status(err.name === 'AbortError' ? 504 : 500).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
}
