// Extracts visible text from uploaded photos via Google Cloud Vision API's
// TEXT_DETECTION feature, so a user who screenshots a dating profile
// doesn't have to manually retype the bio. This is a convenience feature
// only -- it never calls check_and_increment_usage and never touches
// plan_status/usage_count/credits in any way. Do not add usage/paywall
// gating here without a separate, explicit decision to do so.

const MAX_PHOTOS = 6; // mirrors index.html's client-side cap; enforced here independently

// Vision API's TEXT_DETECTION is typically fast, well under this even for
// a full batch of 6 images -- bounded defensively so a slow/hung upstream
// call can't leave the client's "Extracting..." button stuck indefinitely.
const VISION_TIMEOUT_MS = 20000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { images } = req.body || {};

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
