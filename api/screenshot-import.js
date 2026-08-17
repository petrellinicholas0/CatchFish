// Convenience feature for the Profile Analyzer's "Import from Screenshot"
// card: takes raw OCR text (already extracted client-side via a call to
// api/ocr.js, using the same Vision TEXT_DETECTION endpoint as the
// existing "Extract Text From Photos" button) and structures it into
// profile/conversation fields the client can offer to auto-fill.
//
// Same convenience-only architecture as api/ocr.js -- this endpoint never
// calls check_and_increment_usage and never touches plan_status/
// usage_count/credits. The client applies its own separate, independent
// daily cap (cf_import_usage/cf_import_reset) before ever calling this
// endpoint; that cap applies to Pro users too, since this is an abuse
// guard, not a paywall. Do not add usage/paywall gating here without a
// separate, explicit decision to do so.
//
// Entirely separate endpoint from api/analyze.js by design, matching the
// established pattern (api/research-coach.js, api/inspector-advice.js,
// api/evidence-packet.js) of small single-purpose endpoints that build
// their own system prompt server-side -- api/analyze.js itself explicitly
// rejects any client-supplied `system` field, so there is no generic
// {system, messages} relay to reuse here.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Several screenshots' worth of OCR text, generously bounded -- the client
// caps at 4 images per import action, and Vision's TEXT_DETECTION output
// for a single screenshot is rarely more than a few hundred words.
const MAX_TEXT_LEN = 20000;

// Structured JSON, not a long-form report -- same ceiling as
// api/research-coach.js's structured-plan call.
const IMPORT_TIMEOUT_MS = 30000;

// ════════════════════ SERVER-SIDE SYSTEM PROMPT ════════════════════
const IMPORT_SYS = `You are a structured data extractor for dating-app screenshots. You will
receive raw OCR text extracted from one or more screenshots of either a
dating profile screen, a message conversation thread, or both. Extract ONLY
what is explicitly present in the text -- never infer, guess, or fabricate a
value. If a field is not confidently present, use null for it.

Return ONLY valid JSON, no markdown, no extra text:
{
  "content_type": "profile"|"conversation"|"mixed"|"unclear",
  "platform": <string or null, e.g. 'Hinge', 'Tinder', 'Instagram'>,
  "age": <string or null>,
  "location": <string or null>,
  "occupation": <string or null>,
  "bio": <string or null, the profile's about-me/bio text verbatim>,
  "messages": <string or null, the conversation text, prefixed with
    speaker labels like 'Them:'/'Me:' where the OCR layout makes the
    sender distinguishable, otherwise just the raw message text in order>
}`;

const STRING_OR_NULL_FIELDS = ['platform', 'age', 'location', 'occupation', 'bio', 'messages'];
const VALID_CONTENT_TYPES = new Set(['profile', 'conversation', 'mixed', 'unclear']);

function validateImportShape(result) {
  if (!result || typeof result !== 'object') {
    return { ok: false, reason: 'response is not an object' };
  }
  if (!VALID_CONTENT_TYPES.has(result.content_type)) {
    return { ok: false, reason: `invalid content_type: ${JSON.stringify(result.content_type)}` };
  }
  for (const field of STRING_OR_NULL_FIELDS) {
    const v = result[field];
    if (v !== null && typeof v !== 'string') {
      return { ok: false, reason: `${field} must be a string or null` };
    }
  }
  return { ok: true };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, text } = req.body || {};

  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    return res.status(400).json({ error: 'Missing or invalid userId' });
  }
  const textTrimmed = typeof text === 'string' ? text.trim() : '';
  if (!textTrimmed) {
    return res.status(400).json({ error: 'Missing text' });
  }
  const textT = textTrimmed.slice(0, MAX_TEXT_LEN);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('screenshot-import.js error: Missing ANTHROPIC_API_KEY environment variable');
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMPORT_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1200,
        system: IMPORT_SYS,
        messages: [{ role: 'user', content: textT }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic API error:', data.error || data);
      return res.status(response.status).json({ error: 'Import is unavailable right now. Please try again.' });
    }

    const raw = Array.isArray(data.content)
      ? data.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
      : '';

    let result;
    try {
      result = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch (parseErr) {
      console.error('screenshot-import.js: failed to parse model response as JSON:', parseErr.message);
      return res.status(502).json({ error: "Couldn't read that screenshot. Please try again." });
    }

    const validation = validateImportShape(result);
    if (!validation.ok) {
      console.error('screenshot-import.js: response failed shape validation:', validation.reason);
      return res.status(502).json({ error: "Couldn't read that screenshot. Please try again." });
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('screenshot-import.js error:', err);
    const message = err.name === 'AbortError' ? 'Import timed out. Please try again.' : 'Server error. Please try again.';
    return res.status(err.name === 'AbortError' ? 504 : 500).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
}

// Named exports so tests can assert on the exact prompt/validation logic
// without duplicating it -- Vercel only ever calls the default export.
export { IMPORT_SYS, validateImportShape };
