// Pro-only feature: compiles reverse-search results (api/reverse-search.js)
// plus RDAP domain-age lookups into a structured, factual JSON document --
// an "evidence packet" a user can copy into a platform's DMCA report form
// or hand to an attorney. This is intentionally NOT an AI feature: there
// is no Anthropic API call anywhere in this file, and no generated/
// interpretive sentence is ever produced -- every field in the response
// traces to a literal value from Vision's API response (forwarded by the
// client from api/reverse-search.js), an RDAP lookup, or the user's own
// typed text passed through unmodified. See api/inspector-advice.js for
// the sibling feature that DOES use the model, for contrast.

import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { extractDomain, lookupDomainRegistration } from '../lib/rdap.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirrors api/reverse-search.js's own MAX_PHOTOS -- reverseSearchData is
// expected to be that endpoint's own `results` array, forwarded verbatim
// by the client, so it should never exceed this in normal use. Enforced
// independently here too since this endpoint doesn't re-verify the data
// against a live Vision response -- a client could in principle submit a
// fabricated payload, and this bounds how much of it gets processed.
const MAX_PHOTOS = 6;

// Bounds request volume to RDAP -- explicit requirement, not just general
// defensiveness: a page found on many different domains could otherwise
// trigger dozens of outbound lookups per request.
const MAX_UNIQUE_DOMAINS = 15;

// Defensive cap on how many entries end up in each output list, same
// "bound otherwise-unbounded client input" posture as MAX_DOMAINS in
// api/inspector-advice.js -- a real Vision response for 6 photos doesn't
// come close to this, but a fabricated payload could claim to.
const MAX_ENTRIES_PER_CATEGORY = 50;

// "truncated to a reasonable length" per spec -- same order of magnitude
// as reverseSearchNote's cap in api/analyze.js, generous enough for any
// real bio/messages submission.
const SUBMITTED_TEXT_MAX_LEN = 5000;

function collectMatchUrls(photos, field, cap) {
  const out = [];
  photos.forEach((photo, imageIndex) => {
    const arr = Array.isArray(photo && photo[field]) ? photo[field] : [];
    for (const url of arr) {
      if (out.length >= cap) break;
      if (typeof url === 'string' && url.trim()) {
        out.push({ imageIndex, url: url.trim() });
      }
    }
  });
  return out;
}

function collectPages(photos, cap) {
  const out = [];
  photos.forEach((photo) => {
    const arr = Array.isArray(photo && photo.pagesWithMatchingImages) ? photo.pagesWithMatchingImages : [];
    for (const p of arr) {
      if (out.length >= cap) break;
      if (p && typeof p.url === 'string' && p.url.trim()) {
        out.push({ url: p.url.trim(), pageTitle: typeof p.pageTitle === 'string' ? p.pageTitle : null });
      }
    }
  });
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, reverseSearchData, submittedText } = req.body || {};

  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    return res.status(400).json({ error: 'Missing or invalid userId' });
  }
  if (!Array.isArray(reverseSearchData) || reverseSearchData.length === 0) {
    return res.status(400).json({ error: 'Missing or empty reverseSearchData' });
  }
  if (reverseSearchData.length > MAX_PHOTOS) {
    return res.status(400).json({ error: `Max ${MAX_PHOTOS} photos` });
  }

  try {
    const supabase = getSupabaseAdmin();
    // Direct lookup, not an RPC -- this endpoint doesn't gate/consume any
    // usage counter, it only needs the user's current plan. Same pattern
    // as api/inspector-advice.js: maybeSingle() so a userId with no row
    // yet resolves to null (treated as not-Pro) rather than throwing.
    const { data: userRow, error: userError } = await supabase
      .from('users')
      .select('plan_status')
      .eq('id', userId)
      .maybeSingle();

    if (userError) {
      console.error('evidence-packet.js: user lookup failed:', userError.message);
      return res.status(500).json({ error: 'Server error. Please try again.' });
    }
    if (!userRow || userRow.plan_status !== 'active') {
      return res.status(403).json({ error: 'pro_required' });
    }
  } catch (err) {
    console.error('evidence-packet.js: user lookup error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }

  const photos = reverseSearchData;

  const exactMatches = collectMatchUrls(photos, 'fullMatchingImages', MAX_ENTRIES_PER_CATEGORY);
  const partialMatches = collectMatchUrls(photos, 'partialMatchingImages', MAX_ENTRIES_PER_CATEGORY);
  const similarNotConfirmed = collectMatchUrls(photos, 'visuallySimilarImages', MAX_ENTRIES_PER_CATEGORY);
  const pages = collectPages(photos, MAX_ENTRIES_PER_CATEGORY);

  // Dedupe domains in first-seen order, then only actually look up the
  // first MAX_UNIQUE_DOMAINS of them -- pages on domains beyond the cap
  // still appear in pagesFound below, just with domainRegisteredDate:
  // null (not looked up), rather than being dropped entirely.
  const domainsInOrder = [];
  const seenDomains = new Set();
  for (const p of pages) {
    const domain = extractDomain(p.url);
    if (domain && !seenDomains.has(domain)) {
      seenDomains.add(domain);
      domainsInOrder.push(domain);
    }
  }
  const domainsToLookup = domainsInOrder.slice(0, MAX_UNIQUE_DOMAINS);

  const lookupResults = await Promise.all(domainsToLookup.map((d) => lookupDomainRegistration(d)));
  const registrationByDomain = new Map();
  lookupResults.forEach((r) => {
    if (r.domain) registrationByDomain.set(r.domain, r.registrationDate);
  });

  const pagesFound = pages.map((p) => {
    const domain = extractDomain(p.url);
    return {
      url: p.url,
      pageTitle: p.pageTitle,
      domain,
      domainRegisteredDate: domain && registrationByDomain.has(domain) ? registrationByDomain.get(domain) : null
    };
  });

  const submittedTextExcerpt = typeof submittedText === 'string' ? submittedText.trim().slice(0, SUBMITTED_TEXT_MAX_LEN) : '';

  return res.status(200).json({
    generatedAt: new Date().toISOString(),
    exactMatches,
    partialMatches,
    similarNotConfirmed,
    pagesFound,
    submittedTextExcerpt
  });
}
