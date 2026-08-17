// Detects stolen/reused profile photos via Google Cloud Vision API's
// WEB_DETECTION feature, alongside (not instead of) the existing
// AI-authenticity check -- many catfish use real stolen photos, not
// AI-generated ones. Gated entirely independently of
// check_and_increment_usage / the free-analysis counter -- see
// supabase/migrations/0009_add_reverse_search_gating.sql for the
// free-tier/credit/Pro allowance this enforces.

import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';

const MAX_PHOTOS = 6; // mirrors index.html's client-side cap; enforced here independently
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Named constant so this is easy to tune later without hunting through the
// function body. Reverse search is materially more expensive per call
// than a text-only usage check, hence a much lower daily figure than the
// 150/day analysis soft cap -- and this one actually blocks at the limit
// (see the migration), not just logs.
const PRO_DAILY_REVERSE_SEARCH_LIMIT = 10;

// Vision's WEB_DETECTION does more work than plain TEXT_DETECTION
// (crawls/matches against its web-image index), so a slightly more
// generous bound than api/ocr.js's 20s -- still well short of leaving a
// request hanging indefinitely.
const VISION_TIMEOUT_MS = 25000;

// Defensive bounds on the fuller Vision fields added for the Evidence
// Packet feature (api/evidence-packet.js) below -- Vision doesn't return
// unbounded arrays in practice, but nothing stops us from capping payload
// size the same way the rest of this codebase bounds otherwise-unbounded
// input (MAX_PHOTOS here, MAX_DOMAINS in api/inspector-advice.js, etc.).
// visuallySimilarImages specifically capped at 5 per the Evidence Packet
// spec -- it's the weakest signal of the three match types, so it doesn't
// need as much room as confirmed (full/partial) matches.
const MAX_MATCH_URLS = 20;
const MAX_VISUALLY_SIMILAR = 5;
const MAX_PAGES_WITH_MATCHES = 20;

function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
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

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.rpc('check_and_increment_reverse_search', {
      p_user_id: userId,
      p_pro_daily_limit: PRO_DAILY_REVERSE_SEARCH_LIMIT
    });

    if (error) {
      console.error('reverse-search.js: usage check failed:', error.message);
      return res.status(500).json({ error: 'Server error. Please try again.' });
    }

    const gate = Array.isArray(data) ? data[0] : data;
    if (!gate || !gate.o_allowed) {
      return res.status(403).json({ error: 'Reverse image search unavailable', reason: gate?.o_reason || 'free_limit_reached' });
    }
  } catch (err) {
    console.error('reverse-search.js: usage check error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }

  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) {
    console.error('reverse-search.js error: Missing GOOGLE_VISION_API_KEY environment variable');
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);

  try {
    // Same batching approach as api/ocr.js -- all images in one Vision
    // request via the `requests` array, rather than one HTTP call per
    // image. Auth is the API key on the query string, matching the other
    // Vision-backed route.
    const response = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: images.map((content) => ({
          image: { content },
          features: [{ type: 'WEB_DETECTION' }]
        }))
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Vision API error:', data.error || data);
      return res.status(500).json({ error: 'Reverse image search service error. Please try again.' });
    }

    const responses = Array.isArray(data.responses) ? data.responses : [];

    // Positionally aligned with `images`, same convention as api/ocr.js's
    // `texts`. An image with no web matches, or one Vision reported a
    // per-image error for, contributes matchCount: 0 / pages: [] (and all
    // the new fields below as empty arrays) rather than failing the whole
    // batch -- not an error, just nothing found.
    //
    // `matchCount` and `pages` (domain-only, no full URLs) are the
    // original fields index.html's reverseSearchDetailHTML() already
    // renders -- left completely unchanged so that existing behavior and
    // its tests keep working exactly as before.
    //
    // Everything below `pages` is new, added for the Evidence Packet
    // feature (api/evidence-packet.js), which -- unlike the original
    // domain-only design -- deliberately needs the actual full URLs a
    // photo was found at, since a real takedown/evidence document has to
    // point at the exact page, not just the domain. This only ever
    // reflects data about photos the requesting user themselves uploaded,
    // returned to them.
    const results = images.map((_, i) => {
      const entry = responses[i];
      const webDetection = entry && !entry.error ? entry.webDetection : null;
      if (!webDetection) {
        return {
          matchCount: 0,
          pages: [],
          fullMatchingImages: [],
          partialMatchingImages: [],
          visuallySimilarImages: [],
          pagesWithMatchingImages: []
        };
      }

      // matchCount stays computed from the raw (unsliced) Vision counts --
      // exactly the original calculation -- so capping the new list
      // fields below for payload size never changes this pre-existing
      // number that reverseSearchDetailHTML() already displays.
      const fullCount = Array.isArray(webDetection.fullMatchingImages) ? webDetection.fullMatchingImages.length : 0;
      const partialCount = Array.isArray(webDetection.partialMatchingImages) ? webDetection.partialMatchingImages.length : 0;

      const fullMatchingImages = Array.isArray(webDetection.fullMatchingImages)
        ? webDetection.fullMatchingImages.filter((m) => typeof m.url === 'string').map((m) => m.url).slice(0, MAX_MATCH_URLS)
        : [];
      const partialMatchingImages = Array.isArray(webDetection.partialMatchingImages)
        ? webDetection.partialMatchingImages.filter((m) => typeof m.url === 'string').map((m) => m.url).slice(0, MAX_MATCH_URLS)
        : [];
      const visuallySimilarImages = Array.isArray(webDetection.visuallySimilarImages)
        ? webDetection.visuallySimilarImages.filter((m) => typeof m.url === 'string').map((m) => m.url).slice(0, MAX_VISUALLY_SIMILAR)
        : [];
      const pagesWithMatchingImages = Array.isArray(webDetection.pagesWithMatchingImages)
        ? webDetection.pagesWithMatchingImages
            .filter((p) => typeof p.url === 'string')
            .map((p) => ({ url: p.url, pageTitle: typeof p.pageTitle === 'string' ? p.pageTitle : null }))
            .slice(0, MAX_PAGES_WITH_MATCHES)
        : [];

      const pages = Array.isArray(webDetection.pagesWithMatchingImages)
        ? webDetection.pagesWithMatchingImages
            .filter((p) => typeof p.url === 'string')
            .map((p) => ({ url: extractDomain(p.url), title: typeof p.pageTitle === 'string' ? p.pageTitle : null }))
        : [];

      return {
        matchCount: fullCount + partialCount,
        pages,
        fullMatchingImages,
        partialMatchingImages,
        visuallySimilarImages,
        pagesWithMatchingImages
      };
    });

    return res.status(200).json({ results });
  } catch (err) {
    console.error('reverse-search.js error:', err);
    const message = err.name === 'AbortError' ? 'Reverse image search timed out. Please try again.' : 'Server error. Please try again.';
    return res.status(err.name === 'AbortError' ? 504 : 500).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
}
