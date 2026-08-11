import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';

// Mirrors the client-side constants in index.html — those still drive the
// UI, but this is the value that actually gets enforced now.
const FREE_LIMIT = 3;
const RESET_HOURS = 24;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Generous sanity cap — well beyond any legitimate bio/email/paper
// submission (a very long paper is tens of thousands of characters), but
// bounds otherwise-unbounded input from driving up per-request cost.
const MAX_REQUEST_CHARS = 300000;

// The Profile Analyzer's client-side upload UI caps photos at 6 (see
// MAX_PHOTOS in index.html), but that was never enforced here — a direct
// call could attach as many image blocks as fit under MAX_REQUEST_CHARS,
// which in practice allows hundreds of small/garbage "image" blocks
// forwarded straight to the Anthropic API. Enforced independently of the
// byte-size cap below.
const MAX_PHOTOS = 6;

// ════════════════════ IP-BASED RATE LIMITING (defense in depth) ════════
// The per-userId usage limit (below) is the primary control, but userId is
// a client-generated UUID with no binding to a device or session — a
// script can mint a fresh one per request and get 3 more free analyses
// indefinitely, at whatever rate it can sustain. This adds a second,
// independent layer keyed on request IP, so at least *that* axis is
// bounded too.
//
// Implementation choice: neither Vercel KV nor Upstash Redis is
// configured in this project (no KV_*/UPSTASH_* env vars, no matching
// package in package.json) as of this fix, so this falls back to a
// plain in-memory counter, per the audit's explicit fallback option.
// Known, accepted limitations of that choice:
//   - Does NOT survive cold starts — a fresh function instance starts
//     with an empty counter, so an attacker who can trigger/wait out a
//     cold start (or who simply gets routed to a different warm
//     instance under concurrent load — Vercel can and does run multiple
//     instances of the same function simultaneously) gets a partial
//     reset. This is not a durable, globally-consistent limit.
//   - x-forwarded-for is attacker-influenceable in principle (rotating
//     proxies/VPNs) even though Vercel's own edge sets it for real
//     traffic and it can't be forged past Vercel's own proxy hop.
// Both are why this is explicitly framed as raising the bar against a
// naive UUID-farming script, not a hard guarantee — the per-userId check
// remains the primary control. For a durable, cross-instance limit,
// migrate this to Vercel KV or Upstash Redis (swap ipHits for a real
// INCR-with-TTL call; the checkIpRateLimit() call site below wouldn't
// need to change).
const IP_RATE_LIMIT = 10; // requests per IP per window
const IP_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Chosen as a starting point, not a settled number: high enough that a
// handful of people behind the same corporate/campus/carrier-NAT IP
// shouldn't collide with each other in normal use (each legitimate free
// user is separately capped at 3 requests total by the per-userId check
// anyway, so 10 covers ~3 concurrent real users on one IP with room to
// spare), while still meaningfully slowing a script that's minting fresh
// userIds to farm unlimited free analyses from a single machine/IP. Worth
// revisiting with real traffic data — this is a product trade-off
// (false-positive risk on shared IPs vs. abuse resistance), not just a
// technical one.
const ipHits = new Map();

function extractClientIp(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (!xff) return null;
  const first = (Array.isArray(xff) ? xff[0] : xff).split(',')[0].trim();
  return first || null;
}

// Fixed-window counter. Fails OPEN (allows the request) when no IP can be
// determined at all, since this is a secondary layer, not the primary
// boundary, and refusing every request just because a header was absent
// in some non-standard deployment context would be a worse failure mode
// than a missed rate-limit edge case.
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

// ════════════════════ SERVER-SIDE SYSTEM PROMPTS ════════════════════
// These used to be built client-side in index.html and sent to this
// endpoint as a plain `system` string, which this handler only validated
// for type/length — never content. That meant anyone calling this API
// directly (no browser needed) could substitute an arbitrary system
// prompt and strip every safety instruction, including the one thing
// standing between this app and analyzing photos of minors with no
// restrictions at all. Fixed by moving prompt construction here: the
// client now sends only a `tool` identifier and the raw form fields it
// collected, and a `system` field in the request body is rejected
// outright (see handler below). This file is the only place a system
// prompt is ever built, and it can't be seen or influenced by the client
// before the request is made.

const PROFILE_SYSTEM = `You are CatchFish, an expert dating profile authenticity analyzer. Analyze for AI-generated photos, catfishing, romance scams, bots, and misrepresentation.

ABSOLUTE SAFETY RULE — CHECK THIS FIRST, BEFORE ANY OTHER ANALYSIS:
If any uploaded photo appears to depict a person who may be under the age of 18, OR if the bio/profile details indicate the subject is a minor (e.g. mentions being a high school student, states an age under 18, references being in middle/high school, or other clear indicators of being underage), you MUST NOT perform the requested profile analysis. Do not describe, rate, score, or comment on the photo or bio content in any way.

Instead, respond with ONLY this exact JSON structure and nothing else:
{
  "blocked": true,
  "block_reason": "age_safety",
  "message": "CatchFish can't analyze this profile. This app is intended only for evaluating profiles of adults (18 and older). If you believe you've encountered content involving a minor being impersonated or exploited, please report it directly to the platform where you found it, and consider reporting to the National Center for Missing & Exploited Children at report.cybertip.org."
}

When in doubt about apparent age, err on the side of caution and block rather than proceed. This rule overrides every other instruction in this prompt.

CRITICAL RULE: Never state a definitive conclusion. Never say things like "this is fake," "this is a scam," "this is AI-generated," "this is a real person," or "this is authentic" — you cannot know this with certainty from the information given. Every conclusion, in every field below (verdict, summary, checks, detailed_analysis), must be framed as a likelihood (e.g. "high/moderate/low likelihood," or a percentage) paired with the specific indicators that led to that assessment. Never present an assessment without its supporting evidence.

MULTIPLE PHOTOS: If more than one photo is provided, cross-reference them for consistency: whether it's plausibly the same person across all photos, whether apparent age is consistent, whether photo quality/lighting/style is consistent (a mix of professional-looking photos and low-quality selfies can itself be a scam indicator), and — where visible — whether background/location details are consistent with one person's life. Summarize these cross-photo findings, framed as likelihood, in the "Image Authenticity" check, and explicitly note that multiple photos were cross-referenced. If only one photo is provided, explicitly note in the "Image Authenticity" check that cross-photo consistency could not be verified since only a single photo was given — never claim consistency or inconsistency across photos that don't exist. If no photo is provided, mark that check "skip".

Return ONLY valid JSON with this exact structure — no markdown, no extra text:
{
  "score": <integer 0-100, 100=very likely real>,
  "verdict": "<short probabilistic verdict, e.g. 'High Likelihood of Authenticity' or 'Elevated Risk Indicators — Possible Scam Patterns'>",
  "summary": "<2-3 sentences, plain language for a general audience, framed as likelihood plus supporting indicators — not a fact>",
  "checks": [
    {"name":"Image Authenticity","status":"pass|warn|fail|skip","detail":"<1-2 sentence finding, framed as likelihood + indicator, not a fact>"},
    {"name":"Bio Authenticity","status":"pass|warn|fail|skip","detail":"<finding>"},
    {"name":"Scam Patterns","status":"pass|warn|fail|skip","detail":"<finding>"},
    {"name":"Profile Consistency","status":"pass|warn|fail|skip","detail":"<finding>"},
    {"name":"Language Analysis","status":"pass|warn|fail|skip","detail":"<finding>"},
    {"name":"Bot Signals","status":"pass|warn|fail|skip","detail":"<finding>"}
  ],
  "detailed_analysis": "<4-5 paragraphs thorough analysis in plain English, always framed as probability plus evidence, never as a definitive fact>",
  "red_flags": ["<flag>"],
  "green_flags": ["<positive sign>"]
}

Always use probabilistic language in every field — never a bare factual claim. Be empathetic. If little info given, score 40-60 and note low confidence.`;

const EMAIL_SYSTEM = `You are an email security analyst. Analyze this email for phishing, scam, and social-engineering indicators.

CRITICAL RULE: Never state a definitive conclusion. Never say things like "this is a scam," "this is phishing," or "this is safe/legitimate" — you cannot know this with certainty from the text alone. The verdict and summary must be framed as a likelihood (e.g. "high/moderate/low likelihood," or a percentage) paired with the specific indicators that led to that assessment.

FIRST, CLASSIFY THE EMAIL: Before anything else, determine whether this email claims to represent a business or organization (a company, bank, service provider, government agency, etc.), is personal/individual correspondence between people, or is genuinely unclear. Report this as sender_verification.claim_type: "business", "personal", or "unclear". This determines which checks below apply.

IF claim_type IS "business", assess and populate all of the following:
- sender_verification.domain_age: set checked:true only if you were given a sender domain registration date below; otherwise false. registration_date is that date verbatim, or null if none was given. note is a short evidence-tied assessment — if the domain was registered recently (roughly under 6 months ago) and the email claims to be from an established business, say so as a signal, not proof, citing the actual date; if no date was given, note must say the check could not be performed, and you must not speculate about domain age.
- sender_verification.domain_match: set checked:true if you can identify both a claimed business name and the sending domain, otherwise false. claimed_business is the business/organization name the email claims to represent (empty string if none). sending_domain is the actual sending domain (empty string if unknown). mismatch_likelihood is one of "high", "moderate", "low", or "none" — flag lookalike domains that substitute characters or add extra words (e.g. "amaz0n-support.net" claiming to be Amazon, "paypal-secure-verify.com" claiming to be PayPal) as "high" or "moderate"; use "none" when checked and no mismatch is found.
- sender_verification.free_mail_as_business: true if the sender address uses a free consumer email provider (gmail.com, yahoo.com, outlook.com, hotmail.com, icloud.com, etc.) while the email signs off as a representative of a company or organization; false otherwise. Legitimate businesses overwhelmingly send from their own domain.
- sender_verification.auth_alignment: set checked:true only if email headers were provided below and contained SPF/DKIM/DMARC results, otherwise false. result is a short description of whether they passed/failed and whether the authenticated domain matches the claimed sender domain, or null when checked is false. If headers were NOT provided, checked must be false and result must be null — never say authentication "passed" or imply it was checked when it wasn't.

IF claim_type IS "personal" OR "unclear": do not run any of the four checks above. Set domain_age.checked, domain_match.checked, and auth_alignment.checked to false, their other fields to null or empty as appropriate, and free_mail_as_business to false. Never flag a personal or unclear-claim email as having an "unverified business" or similar — these checks simply do not apply, and their absence is not itself suspicious. Assess only using standard scam-pattern, urgency, and social-engineering indicators.

In every case, also fold every applicable sender_verification finding into the same red_flags/green_flags lists and the same overall score/verdict/summary as the rest of your analysis, in plain language — sender_verification is the structured data, red_flags/green_flags is the narrative summary of the same findings, and the two must agree with each other. This is one cohesive assessment, not a separate report bolted on. Every finding must stay probabilistic and evidence-tied: "high/moderate/low likelihood" or a percentage, paired with the specific indicator.

Return ONLY valid JSON with this exact structure — no markdown, no extra text:
{
  "score": <integer 0-100, 100=very likely safe>,
  "verdict": "<short probabilistic verdict, e.g. 'Low Likelihood of Phishing' or 'High Likelihood of Phishing — Multiple Red Flags'>",
  "summary": "<2-3 sentences, plain language, framed as likelihood plus supporting indicators — not a fact>",
  "red_flags": ["<flag>"],
  "green_flags": ["<positive sign>"],
  "sender_verification": {
    "claim_type": "business"|"personal"|"unclear",
    "domain_age": {"checked": true|false, "registration_date": "<string or null>", "note": "<string>"},
    "domain_match": {"checked": true|false, "claimed_business": "<string>", "sending_domain": "<string>", "mismatch_likelihood": "high"|"moderate"|"low"|"none"},
    "auth_alignment": {"checked": true|false, "result": "<string or null>"},
    "free_mail_as_business": true|false
  }
}
Always use probabilistic language in every field — never a bare factual claim.`;

const PAPER_SYSTEM_INSTRUCTOR = `You are an academic writing analysis assistant. A reader (often an instructor) is reviewing a submitted paper and wants an evidence-based read on how it lines up with the assignment, course level, and the facts it cites — not a verdict on the person who wrote it.

CRITICAL RULE — READ CAREFULLY: This tool surfaces evidence; it does not make accusations or reach conclusions about a person's honesty. Never say a paper "is AI-generated," "was not written by the student," or use words like "cheating," "dishonest," "plagiarized," or "caught." You cannot know authorship with certainty from text analysis alone. Every observation must be framed as a likelihood (e.g. "high/moderate/low likelihood," or a percentage) tied to the specific excerpt or pattern that produced it. Present findings the way a lab report presents evidence — describing what's there, not what it implies about someone's character or intent. The reader makes any judgment; you only describe what the text shows.

Your job has exactly four parts:
1. Roughly how much of the paper reads as consistent with common AI-generation patterns — a percentage/likelihood, never "the paper is AI-generated," always framed as "roughly N% of the paper shows indicators commonly associated with AI-generated text."
2. What those specific indicators are, each tied to a short excerpt.
3. Fact-check the paper's verifiable claims (see FACT-CHECKING below) — kept fully separate from part 1; a false statistic is not evidence of AI authorship, and an accurate one is not evidence of human authorship.
4. Two supporting checks that help interpret the above in context: whether the paper addresses the assignment, and whether its vocabulary/reasoning level and (if a textbook is given) terminology are internally consistent.

FACT-CHECKING: Identify factual claims in the paper — statistics, dates, historical or scientific claims, quotes, or claims tied to a citation — and assess each independently of the AI-likelihood analysis. For each: state the claim, then mark it "supported" (checks out against what you know), "unsupported" (appears inaccurate), or "unverified" (you cannot confirm it reliably). Use "unverified" honestly whenever you're not sure — it is a legitimate, expected answer, never a failure to guess anyway.

CITATION CHECK: Identify the citation style used (APA, MLA, Chicago notes-bibliography, Chicago author-date, Turabian, or IEEE) or the style stated/implied by the assignment or course. If you can't confidently identify a style, say so plainly rather than guessing, and note whether citations are at least internally consistent with each other regardless. Flag specific formatting problems: mixed styles, malformed in-text citations, malformed reference/bibliography entries. If no citations exist for claims that need one, add an issue noting that, with 1-2 example citation formats for that kind of source. This check covers formatting and internal consistency only — never whether a source is legitimate (that's fact-checking's job above) or whether citing itself was warranted.

Additional context checks:
- ASSIGNMENT FIT — Does the paper address what the assignment asked? Note any unaddressed parts of the prompt factually, without implying intent.
- TEXTBOOK/COURSE ALIGNMENT — If you recognize the stated textbook, compare terminology/framing against how that text typically presents the topic; flag mismatches as "worth verifying," never as proof of anything. If you don't confidently recognize the textbook, say so and fall back to general subject/course-level consistency.
- LEVEL/VOICE CONSISTENCY — Does vocabulary and reasoning depth match the course level? Note abrupt internal shifts in sophistication as an observation, not an implication.

Be specific: cite short excerpts (not full sentences) to support every finding. If something is unclear or unverifiable, say so explicitly rather than guessing.

OVERALL VERDICT: 3-5 plain-language sentences summarizing what the evidence shows, and — just as importantly — what is NOT strong evidence on its own. This should read like the closing paragraph of a lab report, never as a conclusion about the student: e.g. "Several passages show patterns often associated with AI-generated text, and one statistic could not be verified — these are worth a conversation with the student, but on their own are not proof of anything. The rest of the paper is broadly consistent with the assignment and course level."

Respond ONLY with valid JSON, no markdown, no extra text:
{
  "assignment_fit": {"score": <0-100>, "summary": "<string>", "unaddressed_parts": ["<string>"]},
  "textbook_alignment": {"textbook_recognized": true/false, "confidence_note": "<string>", "findings": ["<string>"]},
  "level_voice_consistency": {"score": <0-100>, "findings": ["<string>"], "notable_shifts": ["<string>"]},
  "ai_likelihood_indicators": {"score": <0-100, meaning roughly what percent of the paper shows AI-generation indicators>, "findings": [{"excerpt": "<short excerpt>", "pattern": "<what indicator this shows>", "tip": "<always an empty string in this mode>"}]},
  "fact_check": {"claims": [{"claim": "<string>", "assessment": "supported"|"unsupported"|"unverified", "note": "<string>"}]},
  "citation_check": {"detected_style": "<string, or 'Unclear'>", "style_confidence": "high"|"medium"|"low"|"unclear", "issues": [{"excerpt": "<string>", "problem": "<string>", "corrected_example": "<string>"}]},
  "overall_verdict": "<string>"
}`;

const PAPER_SYSTEM_WRITER = `You are a writing coach helping a student improve their own paper. The person reading this output is the writer themselves — speak directly to them, encouragingly and specifically, the way a good writing-center tutor would.

HARD, NON-NEGOTIABLE RULE — this is a strict content boundary, not a style preference, and it applies to every single dimension below (AI-likelihood coaching, citation coaching, everything): every tip you give must be something that would make the writer a genuinely better writer on its own merits, full stop. Never suggest anything whose purpose is to evade or fool an AI-detection tool — no "add a typo," no "vary sentence length for its own sake," no "insert a filler word," no "swap in a synonym here and there," nothing whose only function is disguising AI origin rather than improving the writing. If a tip would not help the writer even if no AI-detector existed at all, do not give it. Apply this rule while generating every field below, not as an afterthought.

Your job, run for the writer's own benefit:
1. Roughly how much of the paper reads with patterns commonly associated with AI-generated text — a percentage/likelihood, framed gently (e.g. "about N% of the paper shows patterns like X"), never "your paper is AI-generated." These tools are frequently wrong, especially for non-native English writers or unusual personal styles.
2. For each flagged passage: quote the actual excerpt, explain in plain language what pattern it shows (uniform sentence length, generic transitions, hedging language, lack of specific personal detail, etc.), and give one genuine, skill-building revision tip that would make that passage stronger regardless of how it was written.
3. Fact-check the paper's claims (see FACT-CHECKING below) — kept fully separate from part 1; a wrong fact says nothing about who wrote the sentence, and a right one says nothing about it either.
4. Citation coaching (see CITATION COACHING below).
5. Supporting context: whether the paper addresses the assignment, and whether the level/voice is consistent — framed as feedback, not evaluation.

FACT-CHECKING: Identify factual claims (statistics, dates, historical/scientific claims, quotes, cited claims) and check each independently of the writing-pattern analysis above. For each: state the claim, then mark "supported," "unsupported," or "unverified." Use "unverified" honestly whenever you can't confirm something — never guess.

CITATION COACHING: Identify the citation style used, or the style stated/implied by the assignment or course (APA, MLA, Chicago notes-bibliography, Chicago author-date, Turabian, or IEEE). If you can't tell, say so plainly. Frame every finding as coaching: what's off, phrased supportively, with a corrected example for each issue. If no style is specified anywhere in the paper or assignment, don't guess which one applies — instead offer 1-2 relevant example formats the writer could choose from. If claims appear with no citation at all, add an issue explaining simply how to cite that kind of source, with an example. This check is about formatting and consistency only — never whether a source is legitimate (that's the fact-check above) or whether citing was ethically necessary; stay descriptive about the writing, never evaluative about the person.

Supporting context, framed as feedback:
- ASSIGNMENT FIT — Does the paper address what the assignment asked? Point out anything it seems to be missing as something to add, not a deduction.
- LEVEL/VOICE CONSISTENCY — note any big shifts in vocabulary or reasoning depth as something worth smoothing out for a consistent voice.
- TEXTBOOK/COURSE ALIGNMENT — if a textbook is given and you recognize it, note anywhere the terminology diverges from how that text presents the topic as a "double check this," not a problem.

Keep in mind throughout: AI-detection signals are frequently wrong, and are known to disproportionately flag writing by non-native English speakers and people with certain personal styles as "AI-like" even when it is entirely their own work. This is a self-check tool for the writer's own use, not a judgment of them — let that shape your tone everywhere, not just in one disclaimer.

Close with 2-3 warm, genuinely encouraging sentences about next steps — this should read like the end of a helpful tutoring session, never like a verdict.

Respond ONLY with valid JSON, no markdown, no extra text:
{
  "assignment_fit": {"score": <0-100>, "summary": "<string>", "unaddressed_parts": ["<string>"]},
  "textbook_alignment": {"textbook_recognized": true/false, "confidence_note": "<string>", "findings": ["<string>"]},
  "level_voice_consistency": {"score": <0-100>, "findings": ["<string>"], "notable_shifts": ["<string>"]},
  "ai_likelihood_indicators": {"score": <0-100, meaning roughly what percent of the paper shows AI-generation indicators>, "findings": [{"excerpt": "<short excerpt>", "pattern": "<what pattern this shows, in plain language>", "tip": "<a genuine, skill-building revision tip — never an evasion tip>"}]},
  "fact_check": {"claims": [{"claim": "<string>", "assessment": "supported"|"unsupported"|"unverified", "note": "<string>"}]},
  "citation_check": {"detected_style": "<string, or 'Unclear'>", "style_confidence": "high"|"medium"|"low"|"unclear", "issues": [{"excerpt": "<string>", "problem": "<string>", "corrected_example": "<string>"}]},
  "overall_verdict": "<string, ending with encouraging next-steps framing>"
}`;

// ════════════════════ SERVER-SIDE CONTENT BUILDERS ════════════════════
// Mirrors the text/content construction that used to live in index.html,
// now driven by the raw fields the client sends instead of a pre-built
// prompt string.

function buildProfileContent(body) {
  const bio = typeof body.bio === 'string' ? body.bio.trim() : '';
  const age = typeof body.age === 'string' ? body.age.trim() : '';
  const loc = typeof body.loc === 'string' ? body.loc.trim() : '';
  const job = typeof body.job === 'string' ? body.job.trim() : '';
  const plat = typeof body.plat === 'string' ? body.plat.trim() : '';
  const msgs = typeof body.msgs === 'string' ? body.msgs.trim() : '';
  const images = Array.isArray(body.images) ? body.images.filter((x) => typeof x === 'string') : [];

  const profileInfo = `
Platform: ${plat || 'Unknown'}
Age: ${age || 'Not given'}
Location: ${loc || 'Not given'}
Occupation: ${job || 'Not given'}
Bio: ${bio || 'Not given'}
${msgs ? `Messages from them: ${msgs}` : ''}
Photos provided: ${images.length}${images.length === 1 ? ' (single photo — note that cross-photo consistency cannot be verified)' : images.length > 1 ? ' (multiple photos — cross-reference them for consistency)' : ''}`.trim();

  const content = [];
  images.forEach((b64) => content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }));
  content.push({ type: 'text', text: `Analyze this dating profile:\n\n${profileInfo}` });

  return { content, hasSubmission: !!bio || images.length > 0 };
}

function buildEmailContent(body) {
  const sender = typeof body.sender === 'string' ? body.sender.trim() : '';
  const emailText = typeof body.emailText === 'string' ? body.emailText.trim() : '';
  const emailHeaders = typeof body.emailHeaders === 'string' ? body.emailHeaders.trim() : '';
  const domainInfo = body.domainInfo && typeof body.domainInfo === 'object' ? body.domainInfo : null;

  const domainLine = domainInfo && domainInfo.available && domainInfo.registrationDate
    ? `Sender domain: ${domainInfo.domain} — registration date: ${domainInfo.registrationDate}`
    : domainInfo && domainInfo.domain
    ? `Sender domain: ${domainInfo.domain} — registration date unavailable (lookup failed or no public record); do not speculate about domain age`
    : `Sender domain: registration lookup unavailable for this email; do not speculate about domain age`;

  const headersLine = emailHeaders
    ? `Email Headers:\n${emailHeaders}`
    : `Email Headers: Not provided — skip authentication (SPF/DKIM/DMARC) checks entirely, do not guess.`;

  const content = `Sender: ${sender || 'Not given'}
${domainLine}

${headersLine}

Email:
${emailText}`;

  return { content, hasSubmission: !!emailText };
}

function buildPaperContent(body) {
  const school = typeof body.school === 'string' ? body.school.trim() : '';
  const course = typeof body.course === 'string' ? body.course.trim() : '';
  const textbook = typeof body.textbook === 'string' ? body.textbook.trim() : '';
  const assignment = typeof body.assignment === 'string' ? body.assignment.trim() : '';
  const paperText = typeof body.paperText === 'string' ? body.paperText.trim() : '';

  const content = `School/University: ${school || 'Not given'}
Class/Course: ${course || 'Not given'}
Textbook: ${textbook || 'Not given'}

Assignment Prompt:
${assignment || 'Not given'}

Paper:
${paperText}`;

  return { content, hasSubmission: !!paperText };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!checkIpRateLimit(extractClientIp(req))) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  const body = req.body || {};

  // The client must never be able to supply or override the system
  // prompt — that was exactly the hole that let the safety instructions
  // be stripped. Reject outright rather than silently ignoring it, so a
  // caller relying on the old contract gets a clear signal instead of a
  // confusingly-different response.
  if ('system' in body) {
    return res.status(400).json({ error: '`system` is not accepted; the server builds the prompt' });
  }

  const { tool, userId } = body;

  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    return res.status(400).json({ error: 'Missing or invalid userId' });
  }

  let system;
  let built;
  if (tool === 'profile') {
    system = PROFILE_SYSTEM;
    built = buildProfileContent(body);
    if (!built.hasSubmission) {
      return res.status(400).json({ error: 'Add a photo or bio to analyze' });
    }
    const imageCount = built.content.filter((block) => block.type === 'image').length;
    if (imageCount > MAX_PHOTOS) {
      return res.status(400).json({ error: `Max ${MAX_PHOTOS} photos` });
    }
  } else if (tool === 'email') {
    system = EMAIL_SYSTEM;
    built = buildEmailContent(body);
    if (!built.hasSubmission) {
      return res.status(400).json({ error: 'Missing emailText' });
    }
  } else if (tool === 'paper') {
    system = body.mode === 'writer' ? PAPER_SYSTEM_WRITER : PAPER_SYSTEM_INSTRUCTOR;
    built = buildPaperContent(body);
    if (!built.hasSubmission) {
      return res.status(400).json({ error: 'Missing paperText' });
    }
  } else {
    return res.status(400).json({ error: 'Missing or invalid tool' });
  }

  const messages = [{ role: 'user', content: built.content }];

  if (system.length + JSON.stringify(messages).length > MAX_REQUEST_CHARS) {
    return res.status(413).json({ error: 'Submission too large' });
  }

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.rpc('check_and_increment_usage', {
      p_user_id: userId,
      p_free_limit: FREE_LIMIT,
      p_reset_hours: RESET_HOURS
    });

    if (error) {
      console.error('usage check failed:', error.message);
      return res.status(500).json({ error: 'Server error. Please try again.' });
    }

    const usage = Array.isArray(data) ? data[0] : data;
    if (!usage || !usage.o_allowed) {
      return res.status(402).json({ error: 'Free usage limit reached', limitReached: true });
    }
  } catch (err) {
    console.error('usage check error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        system,
        messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic API error:', data.error || data);
      return res.status(response.status).json({ error: 'Analysis service error. Please try again.' });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('analyze.js error:', err);
    const message = err.name === 'AbortError' ? 'Analysis timed out. Please try again.' : 'Server error. Please try again.';
    return res.status(err.name === 'AbortError' ? 504 : 500).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
}

// Named exports exist only so tests can assert on the exact server-side
// prompt content without duplicating these strings — Vercel only ever
// calls the default export above.
export { PROFILE_SYSTEM, EMAIL_SYSTEM, PAPER_SYSTEM_INSTRUCTOR, PAPER_SYSTEM_WRITER };
