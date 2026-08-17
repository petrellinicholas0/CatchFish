// Pro-only "next step" after Case File's Evidence Packet: turns the
// already-compiled evidence (api/evidence-packet.js's output, forwarded
// verbatim by the client -- same "client forwards raw material it
// already computed" pattern as api/inspector-advice.js's matchedDomains)
// plus a few directly user-provided facts (was money sent, how much,
// which platform, when) into (a) a ranked action-sequencing checklist
// and (b) three downloadable reference drafts (IC3, FTC, a bank
// fraud-dispute letter) the user can copy from into the real forms.
//
// CatchFish never submits anything anywhere on the user's behalf: this
// endpoint only ever returns text for the client to render, copy, or
// download via a plain Blob -- there is no outbound fetch to ic3.gov,
// ftc.gov, any bank, or any other third party anywhere in this file (or
// anywhere else in the codebase). See tests/report-recover.test.mjs for
// an explicit assertion that the only network call this handler ever
// makes is to api.anthropic.com.
//
// HARD CONSTRAINT (the most important thing in this file): the model may
// only reformat facts it was actually given -- never infer, estimate,
// round, or invent a more specific detail than what's provided. Enforced
// two ways, not just requested in the prompt: (1) the checklist itself
// is 100% deterministic JS below, not model output at all, so it can't
// be fabricated; (2) the three drafts go through validateReportRecoverDraft()
// after generation, which scans for dollar amounts, dates, and
// name-shaped text that don't trace back to a fact this endpoint was
// actually given, and rejects the whole response (502) if any are found
// -- mirroring api/analyze.js's isSuggestionProseLike/
// validateImprovementSuggestions pattern for Paper Check's Improvement
// Suggestions (same "reject outright rather than risk serving fabricated
// content" posture, adapted to a different kind of fabrication risk).

import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same bounds as api/evidence-packet.js -- this endpoint receives that
// endpoint's own output back from the client, which could in principle
// forward a fabricated/oversized payload instead of a real one.
const MAX_ENTRIES_PER_CATEGORY = 50;
const SUBMITTED_TEXT_MAX_LEN = 5000;

// The new structured facts this endpoint alone collects -- short,
// directly-user-typed fields, same "bound otherwise-unbounded input"
// posture as MAX_CONTEXT_LEN in api/inspector-advice.js.
const MAX_FIELD_LEN = 200;

const REPORT_RECOVER_TIMEOUT_MS = 30000;

// ════════════════════ ACTION-SEQUENCING CHECKLIST (deterministic) ══════
// Pure sequencing of facts the client/user already supplied -- no model
// call, no new classifier, exactly per spec ("sequencing existing facts
// into an order, not new analysis"). If money was lost, the bank step is
// both first AND flagged urgent (many banks/payment apps have a short
// reversal window); if not, that step is omitted entirely rather than
// shown as irrelevant filler.
function buildChecklist({ moneyLost, platform }) {
  const steps = [];
  if (moneyLost) {
    steps.push({
      label: "Contact your bank or payment provider's fraud department",
      why: 'Time-sensitive — many banks and payment apps only have a short window to reverse a fraudulent transaction.',
      urgent: true
    });
  }
  steps.push({
    label: platform ? `Report the account to ${platform}` : 'Report the account to the platform where you met',
    why: 'Reporting the profile/account can get it taken down and may help other users avoid the same person.',
    urgent: false
  });
  steps.push({
    label: 'File a report with IC3 (the FBI\'s Internet Crime Complaint Center)',
    why: 'IC3 is the federal government\'s central intake for internet-crime reports and can connect related cases across victims.',
    urgent: false
  });
  steps.push({
    label: 'File a report with the FTC (Federal Trade Commission)',
    why: 'FTC reports feed into consumer-protection enforcement and public fraud-trend tracking.',
    urgent: false
  });
  return steps;
}

// ════════════════════ FACTS: single source of truth ════════════════════
// Both the prompt text handed to the model and the allowlist the
// post-generation validator checks against are built from this same
// object, so they can never drift out of sync with each other.
function boundedArray(arr) {
  return Array.isArray(arr) ? arr.slice(0, MAX_ENTRIES_PER_CATEGORY) : [];
}

function extractUrlList(arr) {
  return boundedArray(arr)
    .map((m) => (m && typeof m.url === 'string' ? m.url.trim().slice(0, 500) : ''))
    .filter(Boolean);
}

function buildFacts(body) {
  const ep = body.evidencePacket && typeof body.evidencePacket === 'object' ? body.evidencePacket : {};

  const exactMatches = extractUrlList(ep.exactMatches);
  const partialMatches = extractUrlList(ep.partialMatches);
  const similarNotConfirmed = extractUrlList(ep.similarNotConfirmed);
  const pagesFound = boundedArray(ep.pagesFound).map((p) => ({
    url: p && typeof p.url === 'string' ? p.url.trim().slice(0, 500) : '',
    pageTitle: p && typeof p.pageTitle === 'string' ? p.pageTitle.trim().slice(0, 300) : '',
    domain: p && typeof p.domain === 'string' ? p.domain.trim().slice(0, 300) : '',
    domainRegisteredDate: p && typeof p.domainRegisteredDate === 'string' ? p.domainRegisteredDate.trim().slice(0, 100) : ''
  }));
  const submittedTextExcerpt = typeof ep.submittedTextExcerpt === 'string' ? ep.submittedTextExcerpt.trim().slice(0, SUBMITTED_TEXT_MAX_LEN) : '';

  const moneyLost = body.moneyLost === true;
  const moneyLostAmount = typeof body.moneyLostAmount === 'string' ? body.moneyLostAmount.trim().slice(0, MAX_FIELD_LEN) : '';
  const moneyLostMethod = typeof body.moneyLostMethod === 'string' ? body.moneyLostMethod.trim().slice(0, MAX_FIELD_LEN) : '';
  const platform = typeof body.platform === 'string' ? body.platform.trim().slice(0, MAX_FIELD_LEN) : '';
  const incidentDate = typeof body.incidentDate === 'string' ? body.incidentDate.trim().slice(0, MAX_FIELD_LEN) : '';

  return { exactMatches, partialMatches, similarNotConfirmed, pagesFound, submittedTextExcerpt, moneyLost, moneyLostAmount, moneyLostMethod, platform, incidentDate };
}

function factsToPromptText(f) {
  const lines = [];
  lines.push(`Money reported lost: ${f.moneyLost ? 'YES' : 'NO'}`);
  if (f.moneyLost) {
    lines.push(`Amount lost, as typed by the user (use verbatim, or [CONFIRM] if blank): ${f.moneyLostAmount || '(not provided)'}`);
    lines.push(`Payment method, as typed by the user (use verbatim, or [CONFIRM] if blank): ${f.moneyLostMethod || '(not provided)'}`);
  }
  lines.push(`Platform where contact happened, as typed by the user (use verbatim, or [CONFIRM] if blank): ${f.platform || '(not provided)'}`);
  lines.push(`Date of incident, as typed by the user (use verbatim, or [CONFIRM] if blank): ${f.incidentDate || '(not provided)'}`);
  lines.push('');
  lines.push("User's own submitted bio/message text, verbatim -- this is the ONLY place a name, handle, or specific detail about the other party may legitimately come from:");
  lines.push(f.submittedTextExcerpt || '(none provided)');
  lines.push('');
  lines.push(`Exact photo matches found elsewhere online (URLs): ${f.exactMatches.length ? f.exactMatches.join(', ') : '(none)'}`);
  lines.push(`Partial/cropped photo matches found (URLs): ${f.partialMatches.length ? f.partialMatches.join(', ') : '(none)'}`);
  lines.push('Pages where a match was found:');
  if (f.pagesFound.length) {
    f.pagesFound.forEach((p) => lines.push(`- ${p.url} (domain: ${p.domain || 'unknown'}, title: ${p.pageTitle || 'none'}, domain registered: ${p.domainRegisteredDate || 'unavailable'})`));
  } else {
    lines.push('(none)');
  }
  return lines.join('\n');
}

function factsToAllowedBlob(f) {
  return [
    f.moneyLostAmount, f.moneyLostMethod, f.platform, f.incidentDate, f.submittedTextExcerpt,
    ...f.exactMatches, ...f.partialMatches, ...f.similarNotConfirmed,
    ...f.pagesFound.map((p) => `${p.url} ${p.domain} ${p.pageTitle} ${p.domainRegisteredDate}`)
  ].filter(Boolean).join(' \n ');
}

// ════════════════════ SERVER-SIDE SYSTEM PROMPT ════════════════════
const REPORT_RECOVER_SYSTEM = `You are drafting reference documents for a CatchFish user reporting a suspected romance scam or catfishing situation, based ONLY on facts already provided below. You are not a lawyer, not law enforcement, and these documents are never submitted anywhere by CatchFish -- they are drafts the user reviews and copies from into the real IC3.gov complaint form, the real ReportFraud.ftc.gov form, or their own bank's fraud-dispute process.

ABSOLUTE HARD RULE -- THE MOST IMPORTANT INSTRUCTION HERE: you may ONLY use facts given to you in the FACTS block below, reformatted into each document's structure. Never infer, estimate, guess, round, or "clean up" any fact into something more specific than what was actually given. If a detail a real IC3/FTC/bank form would ask for (an exact date, a dollar amount, a name, an account number, etc.) is missing, vague, or not given below, write the literal placeholder text "[CONFIRM: <what's missing>]" in that spot -- for example "[CONFIRM: exact date not specified -- fill in before submitting]" -- never fill it with a plausible-sounding guess. When in doubt, use a placeholder. A specific-sounding invented detail is worse than an honest gap.

Draft three documents:
1. ic3_draft -- organized the way IC3 (Internet Crime Complaint Center) intake typically asks for: victim info (use [CONFIRM] for the user's own name/contact info -- you were never given that), subject/suspect info (from the facts given, or [CONFIRM] if unknown), how contact happened (platform, from facts given), a narrative timeline using ONLY the facts given, in the order given, and financial loss details ([CONFIRM] if no dollar amount was given).
2. ftc_draft -- organized the way ReportFraud.ftc.gov typically asks for: what happened (narrative from facts given), how contact happened, the platform, whether money was involved, and any identifying information about the other party from the facts given.
3. bank_draft -- ONLY if money was lost (see the FACTS block) -- a fraud-dispute letter to a bank/payment provider: the transaction being disputed as fraudulent, date/amount (from facts given, or [CONFIRM]), payment method, a brief factual narrative, and a request to investigate and reverse the charge if eligible. If the FACTS block says money was NOT lost, set bank_draft to null -- never invent a transaction to write about.

Every non-null draft must:
- Open with this exact sentence, verbatim, as its first line: "This draft was generated from what you provided. Review every field — especially any marked [CONFIRM] — before using it. You are responsible for what you submit."
- Be plain text only, no markdown formatting.
- Never claim, imply, or suggest that filing this way guarantees any outcome, that CatchFish is filing this on the user's behalf, or that this replaces legal advice. Never use "guarantee," "guaranteed," "ensure," "100%," or say CatchFish "handles" or "files" this for the user.
- Stay strictly factual and organizational -- you are formatting the user's own facts into the shape a form expects, never writing persuasive or legal argument.

Respond ONLY with valid JSON, no markdown, no extra text:
{
  "ic3_draft": "<full plain text>",
  "ftc_draft": "<full plain text>",
  "bank_draft": "<full plain text, or null if the FACTS block says no money was lost>"
}`;

// ════════════════════ POST-GENERATION FABRICATION CHECK ════════════════
// Three checks, each scanning the drafts for a specific fabrication risk
// and confirming every instance traces back to something in the facts
// blob. [CONFIRM: ...] placeholders are stripped first -- those are the
// correct, expected output for a missing fact, not something to flag.
const CONFIRM_BRACKET_RE = /\[CONFIRM[^\]]*\]/gi;
const DOLLAR_TOKEN_RE = /\$\s?[\d,]+(?:\.\d{1,2})?|\b[\d,]+(?:\.\d{1,2})?\s*(?:dollars|usd)\b/gi;

function extractDollarAmounts(text) {
  const matches = text.match(DOLLAR_TOKEN_RE) || [];
  return matches.map((m) => parseFloat(m.replace(/[^0-9.]/g, ''))).filter((n) => Number.isFinite(n));
}

// Compares by {year, month} rather than raw text, so a legitimate
// reformatting (an ISO domain-registration date turned into prose, e.g.
// "2021-05-03" -> "May 3, 2021") is never mistaken for an invented date --
// only a date whose year/month don't match anything in the facts is
// treated as fabricated.
const MONTH_MAP = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

function extractDateComponents(text) {
  const results = [];
  let m;
  // No trailing \b: a raw ISO timestamp like "2023-11-02T00:00:00Z" (the
  // literal shape RDAP domainRegisteredDate values come in) has no word
  // boundary between the day digits and the following "T" -- both are \w
  // characters, so a trailing \b would silently fail to match a real
  // source date stored in that exact form.
  const isoRe = /\b(\d{4})-(\d{2})-\d{2}/g;
  while ((m = isoRe.exec(text))) results.push(`${m[1]}-${m[2]}`);
  const mdyRe = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g;
  while ((m = mdyRe.exec(text))) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    results.push(`${year}-${m[1].padStart(2, '0')}`);
  }
  const monthFirstRe = /\b([A-Za-z]{3,9})\.?\s+\d{1,2},?\s+(\d{4})\b/g;
  while ((m = monthFirstRe.exec(text))) {
    const key = MONTH_MAP[m[1].slice(0, 3).toLowerCase()];
    if (key) results.push(`${m[2]}-${key}`);
  }
  const dayMonthRe = /\b\d{1,2}\s+([A-Za-z]{3,9})\.?\s+(\d{4})\b/g;
  while ((m = dayMonthRe.exec(text))) {
    const key = MONTH_MAP[m[1].slice(0, 3).toLowerCase()];
    if (key) results.push(`${m[2]}-${key}`);
  }
  return results;
}

// Best-effort, allowlist-based -- catching every possible fabricated name
// with a regex isn't achievable, but this errs toward rejecting (fail
// closed) on any Title-Case 2-3 word phrase that isn't clearly
// boilerplate and doesn't trace back to something the user actually
// provided, rather than risk silently letting an invented name through.
//
// Entries are the EXACT phrase(s) extractCandidateNames' regex would
// actually capture, not arbitrary fragments -- the regex matches 2-3
// consecutive Title-Case words as one unit (e.g. a 4-word institutional
// name like "Internet Crime Complaint Center" is captured as "Internet
// Crime Complaint", not as two overlapping 2-word pieces), so the
// allowlist has to match that same shape or a real institutional name
// gets flagged as if it were a fabricated person's name.
const NAME_ALLOWLIST = new Set([
  'internet crime complaint', 'federal trade commission', 'report fraud', 'fraud department',
  'dear sir', 'best regards', 'sincerely yours', 'yours truly',
  'united states', 'case number', 'account number', 'thank you', 'contact information',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'
]);

function extractCandidateNames(text) {
  // A literal space between words, not \s -- \s also matches newlines,
  // which would otherwise let this regex span across line breaks (e.g.
  // "Michael" at the end of one line + "Platform" starting the next
  // reads as the single bogus "candidate name" "Michael\nPlatform").
  const matches = text.match(/\b[A-Z][a-z]+(?: [A-Z][a-z]+){1,2}\b/g) || [];
  return matches.filter((n) => !NAME_ALLOWLIST.has(n.toLowerCase()));
}

function validateReportRecoverDraft(draftText, allowedBlob) {
  if (typeof draftText !== 'string' || !draftText.trim()) {
    return { ok: false, reason: 'draft is empty or not a string' };
  }
  const stripped = draftText.replace(CONFIRM_BRACKET_RE, ' ');

  const allowedDollarAmounts = new Set(extractDollarAmounts(allowedBlob));
  for (const amount of extractDollarAmounts(stripped)) {
    if (!allowedDollarAmounts.has(amount)) {
      return { ok: false, reason: `dollar amount not found in source facts: ${amount}` };
    }
  }

  const allowedDateComponents = new Set(extractDateComponents(allowedBlob));
  for (const dateKey of extractDateComponents(stripped)) {
    if (!allowedDateComponents.has(dateKey)) {
      return { ok: false, reason: `date not found in source facts: ${dateKey}` };
    }
  }

  const allowedBlobLower = allowedBlob.toLowerCase();
  for (const name of extractCandidateNames(stripped)) {
    if (!allowedBlobLower.includes(name.toLowerCase())) {
      return { ok: false, reason: `possible fabricated name not found in source facts: ${name}` };
    }
  }

  return { ok: true };
}

// Cheap, separate check for FIX 5's language-discipline rule -- not a
// fabrication risk, but costs nothing to enforce server-side alongside
// the checks above rather than trusting the prompt alone.
// \b100% (no trailing \b): "%" is a non-word character, so when "100%" is
// followed by whitespace or punctuation (the normal case -- "100%
// guaranteed", "100% get your money back") both sides of the position
// right after "%" are non-word characters, meaning no \b boundary exists
// there at all -- a trailing \b would silently never match.
const BANNED_PHRASE_RE = /\bguarantee(d|s)?\b|\bensure(s|d)?\b|\b100%|\b(?:we|catchfish)\b[^.]{0,30}\b(?:handle|handles|file|files|submit|submits)\b|\bon (?:your|the user'?s) behalf\b/i;

function validateNoOverclaiming(draftText) {
  if (BANNED_PHRASE_RE.test(draftText)) {
    return { ok: false, reason: 'draft contains overclaiming/guarantee language' };
  }
  return { ok: true };
}

function validateAllDrafts(parsed, allowedBlob, moneyLost) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'response is not an object' };
  }
  const { ic3_draft, ftc_draft, bank_draft } = parsed;

  for (const [name, draft] of [['ic3_draft', ic3_draft], ['ftc_draft', ftc_draft]]) {
    const shape = validateReportRecoverDraft(draft, allowedBlob);
    if (!shape.ok) return { ok: false, reason: `${name}: ${shape.reason}` };
    const lang = validateNoOverclaiming(draft);
    if (!lang.ok) return { ok: false, reason: `${name}: ${lang.reason}` };
  }

  if (moneyLost) {
    const shape = validateReportRecoverDraft(bank_draft, allowedBlob);
    if (!shape.ok) return { ok: false, reason: `bank_draft: ${shape.reason}` };
    const lang = validateNoOverclaiming(bank_draft);
    if (!lang.ok) return { ok: false, reason: `bank_draft: ${lang.reason}` };
  } else if (bank_draft !== null && bank_draft !== undefined) {
    return { ok: false, reason: 'bank_draft must be null when no money was lost' };
  }

  return { ok: true };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId } = req.body || {};
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    return res.status(400).json({ error: 'Missing or invalid userId' });
  }

  try {
    const supabase = getSupabaseAdmin();
    // Direct lookup, not an RPC -- same pattern as api/inspector-advice.js
    // and api/evidence-packet.js. This never touches check_and_increment_
    // usage/credits at all.
    const { data: userRow, error: userError } = await supabase
      .from('users')
      .select('plan_status')
      .eq('id', userId)
      .maybeSingle();

    if (userError) {
      console.error('report-recover.js: user lookup failed:', userError.message);
      return res.status(500).json({ error: 'Server error. Please try again.' });
    }
    if (!userRow || userRow.plan_status !== 'active') {
      return res.status(403).json({ error: 'pro_required' });
    }
  } catch (err) {
    console.error('report-recover.js: user lookup error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }

  const facts = buildFacts(req.body || {});
  const checklist = buildChecklist(facts);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('report-recover.js error: Missing ANTHROPIC_API_KEY environment variable');
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }

  const userContent = `FACTS:\n${factsToPromptText(facts)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REPORT_RECOVER_TIMEOUT_MS);

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
        max_tokens: 3000,
        system: REPORT_RECOVER_SYSTEM,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic API error:', data.error || data);
      return res.status(response.status).json({ error: 'Report & Recover is unavailable right now. Please try again.' });
    }

    const raw = Array.isArray(data.content)
      ? data.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
      : '';

    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch (parseErr) {
      console.error('report-recover.js: failed to parse model response as JSON:', parseErr.message);
      return res.status(502).json({ error: "Couldn't generate a valid plan. Please try again." });
    }

    const allowedBlob = factsToAllowedBlob(facts);
    const validation = validateAllDrafts(parsed, allowedBlob, facts.moneyLost);
    if (!validation.ok) {
      console.error('report-recover.js: response failed the fabrication safety check:', validation.reason);
      return res.status(502).json({ error: "Couldn't generate a valid plan. Please try again." });
    }

    return res.status(200).json({
      checklist,
      drafts: {
        ic3: parsed.ic3_draft,
        ftc: parsed.ftc_draft,
        bank: facts.moneyLost ? parsed.bank_draft : null
      }
    });
  } catch (err) {
    console.error('report-recover.js error:', err);
    const message = err.name === 'AbortError' ? 'Report & Recover timed out. Please try again.' : 'Server error. Please try again.';
    return res.status(err.name === 'AbortError' ? 504 : 500).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
}

// Named exports so tests can assert on the exact prompt/checklist/
// validation logic without duplicating it -- Vercel only ever calls the
// default export above.
export {
  REPORT_RECOVER_SYSTEM, buildChecklist, buildFacts, factsToPromptText, factsToAllowedBlob,
  validateReportRecoverDraft, validateNoOverclaiming, validateAllDrafts,
  extractDollarAmounts, extractDateComponents, extractCandidateNames
};
