// Pro-only feature: generates practical removal/reporting guidance, in the
// voice of the app's mascot "Inspector Catchworth," for photos that
// api/reverse-search.js found matches for elsewhere online. This is
// guidance, never legal advice -- see INSPECTOR_SYSTEM below and the
// hardcoded disclaimer index.html renders under every response.
//
// Pro status is verified here, server-side, directly against the users
// table -- the client's S.isPro() check in index.html is a courtesy that
// only decides whether to bother calling this endpoint at all; it is never
// trusted as the actual gate. A free-tier userId hitting this endpoint
// directly always gets 403 regardless of any client-supplied flag (none is
// even accepted in the request body).

import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Bounds on client-forwarded raw material (the domain list index.html
// already computed from api/reverse-search.js's own response, plus a short
// free-text label for what kind of photo this was) -- same "client
// forwards raw material, never instructions" pattern as reverseSearchNote
// in api/analyze.js. Generous enough for any real reverse-search result
// (api/reverse-search.js itself caps at MAX_PHOTOS=6 images, each with a
// handful of matched pages) while bounding otherwise-unbounded input.
const MAX_DOMAINS = 20;
const MAX_DOMAIN_LEN = 200;
const MAX_CONTEXT_LEN = 100;

// Short, in-character response -- not a full report -- so a much lower
// ceiling than analyze.js's 55s is plenty, while still leaving headroom
// past a normal generation.
const INSPECTOR_TIMEOUT_MS = 20000;

// ════════════════════ SERVER-SIDE SYSTEM PROMPT ════════════════════
// Built here only, same architecture as api/analyze.js's prompt constants —
// the client never sends or controls a system prompt for this endpoint
// either (there is no `system` field in the request contract at all).
const INSPECTOR_SYSTEM = `You are Inspector Catchworth, CatchFish's friendly in-house detective mascot. A user's photo was matched by reverse image search on other websites, and they want practical next steps for getting it removed or reported. Respond in character: warm, plain-spoken, a little playful like a kindly old-fashioned detective, but always clear and practical.

GIVE PRACTICAL STEPS ONLY. Keep the whole response under ~200 words, plain language, numbered or short steps:
1. For each matched domain given below, name the concrete reporting path if it's a recognizable platform type — e.g. Instagram/Facebook/other social platforms: use their built-in impersonation or fake-account report flow; a generic website, blog, or stock-photo site: contact via their abuse or DMCA contact (often an "abuse@" address or a "Report Content"/"DMCA" page). If a domain doesn't map to anything you recognize, say so plainly rather than guessing what it is or how to report it.
2. If it sounds like this is the user's OWN original photo (not a stock photo they don't own), briefly explain in plain terms what a DMCA takedown notice is, and note that many sites' terms require the copyright holder — the user themself — to file it, not a third party. Do NOT draft an actual takedown notice or any specific legal document text.
3. If anything about the situation sounds like it could be a scam or impersonation, not just a stolen photo, mention reportfraud.ftc.gov and ic3.gov as options.

HARD RULES — never break these:
- Never give a jurisdiction-specific legal conclusion.
- Never claim removal is guaranteed or fast — always frame steps as "commonly used options," never guarantees.
- Never claim to be a lawyer or offer legal advice.
- Do not draft an actual DMCA notice or other legal document text.

Respond with plain text only (no markdown headers, no JSON) — short numbered or dashed steps, under ~200 words total. A disclaimer is shown separately underneath your response by the app itself, so do not add your own "I'm not a lawyer" disclaimer at the end — just give the steps.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, matchedDomains, photoContext } = req.body || {};

  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    return res.status(400).json({ error: 'Missing or invalid userId' });
  }
  if (!Array.isArray(matchedDomains) || matchedDomains.length === 0) {
    return res.status(400).json({ error: 'Missing or empty matchedDomains' });
  }
  if (matchedDomains.length > MAX_DOMAINS) {
    return res.status(400).json({ error: `Max ${MAX_DOMAINS} domains` });
  }
  if (!matchedDomains.every((d) => typeof d === 'string' && d.trim().length > 0)) {
    return res.status(400).json({ error: 'Each matched domain must be a non-empty string' });
  }
  const domains = matchedDomains.map((d) => d.trim().slice(0, MAX_DOMAIN_LEN));

  const context = typeof photoContext === 'string' && photoContext.trim()
    ? photoContext.trim().slice(0, MAX_CONTEXT_LEN)
    : 'profile photo';

  try {
    const supabase = getSupabaseAdmin();
    // Direct lookup, not the check_and_increment_usage/reverse_search RPCs —
    // this endpoint doesn't consume or gate any usage counter, it only
    // needs to know the user's current plan. maybeSingle() (not single())
    // so a userId with no row yet (never having reached any usage-gating
    // RPC, which upserts on first call) resolves to null rather than a
    // thrown "no rows" error — and null correctly falls through to the
    // pro_required branch below, the same as an explicit non-Pro row would.
    const { data: userRow, error: userError } = await supabase
      .from('users')
      .select('plan_status')
      .eq('id', userId)
      .maybeSingle();

    if (userError) {
      console.error('inspector-advice.js: user lookup failed:', userError.message);
      return res.status(500).json({ error: 'Server error. Please try again.' });
    }
    if (!userRow || userRow.plan_status !== 'active') {
      return res.status(403).json({ error: 'pro_required' });
    }
  } catch (err) {
    console.error('inspector-advice.js: user lookup error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('inspector-advice.js error: Missing ANTHROPIC_API_KEY environment variable');
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }

  const domainsList = domains.map((d, i) => `${i + 1}. ${d}`).join('\n');
  const userContent = `A user's ${context} was found via reverse image search on the following domain(s):\n${domainsList}\n\nGive them practical removal/reporting guidance following your instructions.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INSPECTOR_TIMEOUT_MS);

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
        max_tokens: 500,
        system: INSPECTOR_SYSTEM,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic API error:', data.error || data);
      return res.status(response.status).json({ error: 'Inspector is unavailable right now. Please try again.' });
    }

    const advice = Array.isArray(data.content)
      ? data.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim()
      : '';

    if (!advice) {
      console.error('inspector-advice.js: empty response from Anthropic');
      return res.status(500).json({ error: 'Inspector is unavailable right now. Please try again.' });
    }

    return res.status(200).json({ advice });
  } catch (err) {
    console.error('inspector-advice.js error:', err);
    const message = err.name === 'AbortError' ? 'Inspector timed out. Please try again.' : 'Server error. Please try again.';
    return res.status(err.name === 'AbortError' ? 504 : 500).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
}

// Named export so tests can assert on the exact server-side prompt content
// without duplicating it — Vercel only ever calls the default export above.
export { INSPECTOR_SYSTEM };
