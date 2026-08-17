// Pro-only, pre-writing companion to Paper Check's instructor/writer
// modes (which analyze an already-written paper via api/analyze.js).
// Research Coach runs BEFORE a paper exists: it takes an assignment and a
// topic/working thesis and returns a research plan -- research questions,
// a suggested outline, source categories, and self-check questions --
// and is instructed to NEVER produce paper prose. Entirely separate
// endpoint from api/analyze.js by design, so the existing instructor/
// writer paths are provably unaffected by this feature.
//
// Pro status is verified here, server-side, directly against the users
// table -- same pattern as api/inspector-advice.js and
// api/evidence-packet.js. The client's S.isPro() check in index.html is
// a courtesy only, never trusted; there is no client-supplied isPro flag
// in this endpoint's contract at all.

import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_FIELD_LEN = 300;
const MAX_ASSIGNMENT_LEN = 5000;
const MAX_TOPIC_LEN = 1000;

// Structured JSON, not a long-form report -- well short of analyze.js's
// 55s for the full paper-review flow.
const RESEARCH_COACH_TIMEOUT_MS = 30000;

// The system prompt's own target for an outline "purpose" fragment is
// "under ~12 words" -- this is the hard enforcement ceiling applied to
// EVERY string field in the response (questions included, which
// legitimately run a little longer than a fragment), with slack built in
// so a single well-formed sentence still passes. Anything over this, or
// any field with more than one sentence-terminator, is treated as having
// crossed from "fragment" into "prose" and is rejected outright rather
// than risk serving actual paper content.
const MAX_WORDS_PER_FIELD = 25;

// ════════════════════ SERVER-SIDE SYSTEM PROMPT ════════════════════
const RESEARCH_COACH_SYSTEM = `You are Research Coach, part of CatchFish's academic tools. A student has an assignment and a topic or working thesis, but has NOT written their paper yet. Your job is to help them plan and think -- never to write any part of the paper itself.

HARD RULE -- NEVER VIOLATE THIS: Do not write sentences or paragraphs of paper content. Never draft an introduction, a thesis statement as prose, a body paragraph, a conclusion, or any other connected prose meant to go into the paper. Every output field must be a short fragment: a single question, a section header, a short (under ~12 words) purpose phrase, or a short category description -- never a full written passage.

The assignment prompt will often literally instruct the student to "write a paper" or "write an essay" -- that is completely normal and expected; it does not mean YOU should write it. Only treat this as a misuse attempt if the topic or assignment text is phrased as a direct request for YOU to produce paper content right now (e.g. "write my introduction," "give me three paragraphs about X," "write the conclusion for me"). In that specific case only: set research_questions to a single short entry redirecting them ("Research Coach helps you plan research -- it doesn't write your paper. Try Instructor or Writer mode once you have a draft."), and leave outline, source_categories, and self_check_questions as empty arrays.

Otherwise, produce a genuine research plan:
- research_questions: 3-6 specific, investigable questions the student should research before writing. Each is a single question, never a paragraph.
- outline: 4-7 suggested section headers for the eventual paper, each paired with a short purpose fragment (under ~12 words) describing what that section should accomplish -- never actual section content or draft text.
- source_categories: 3-6 short descriptions of the TYPES of sources worth looking for (e.g. "peer-reviewed studies on X from the last 10 years," "primary government data on Y"). Never invent specific fake citations, authors, titles, or publications -- describe categories only, never name a source that doesn't verifiably exist.
- self_check_questions: 3-5 short questions the student can use later, after drafting, to check their own work against the assignment and their research.

Respond ONLY with valid JSON, no markdown, no extra text:
{
  "research_questions": ["<question>"],
  "outline": [{"header": "<short section header>", "purpose": "<short fragment, under ~12 words>"}],
  "source_categories": ["<short description>"],
  "self_check_questions": ["<question>"]
}`;

function isProseLike(str) {
  if (typeof str !== 'string') return true;
  const trimmed = str.trim();
  if (!trimmed) return true;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > MAX_WORDS_PER_FIELD) return true;
  // More than one sentence-terminator in a single field reads as
  // multiple connected sentences strung together -- i.e. a paragraph,
  // not a fragment or a single question.
  const sentenceEnders = (trimmed.match(/[.!?]+(?=\s|$)/g) || []).length;
  if (sentenceEnders > 1) return true;
  return false;
}

// Validates both the JSON shape AND the prose-length safety property in
// one pass -- any failure means "do not return this to the client."
function validatePlanShape(plan) {
  if (!plan || typeof plan !== 'object') {
    return { ok: false, reason: 'response is not an object' };
  }
  const { research_questions, outline, source_categories, self_check_questions } = plan;

  if (!Array.isArray(research_questions)) return { ok: false, reason: 'research_questions is not an array' };
  for (const q of research_questions) {
    if (isProseLike(q)) return { ok: false, reason: `research_questions entry looks like prose: ${JSON.stringify(q)}` };
  }

  if (!Array.isArray(outline)) return { ok: false, reason: 'outline is not an array' };
  for (const item of outline) {
    if (!item || typeof item !== 'object') return { ok: false, reason: 'outline entry is not an object' };
    if (isProseLike(item.header)) return { ok: false, reason: `outline header looks like prose: ${JSON.stringify(item.header)}` };
    if (isProseLike(item.purpose)) return { ok: false, reason: `outline purpose looks like prose: ${JSON.stringify(item.purpose)}` };
  }

  if (!Array.isArray(source_categories)) return { ok: false, reason: 'source_categories is not an array' };
  for (const s of source_categories) {
    if (isProseLike(s)) return { ok: false, reason: `source_categories entry looks like prose: ${JSON.stringify(s)}` };
  }

  if (!Array.isArray(self_check_questions)) return { ok: false, reason: 'self_check_questions is not an array' };
  for (const q of self_check_questions) {
    if (isProseLike(q)) return { ok: false, reason: `self_check_questions entry looks like prose: ${JSON.stringify(q)}` };
  }

  return { ok: true };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, school, course, textbook, assignment, topic } = req.body || {};

  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    return res.status(400).json({ error: 'Missing or invalid userId' });
  }
  const topicTrimmed = typeof topic === 'string' ? topic.trim() : '';
  if (!topicTrimmed) {
    return res.status(400).json({ error: 'Missing topic' });
  }

  try {
    const supabase = getSupabaseAdmin();
    // Direct lookup, not an RPC -- same pattern as api/inspector-advice.js
    // and api/evidence-packet.js. maybeSingle() so a userId with no row
    // yet resolves to null (treated as not-Pro) rather than throwing.
    const { data: userRow, error: userError } = await supabase
      .from('users')
      .select('plan_status')
      .eq('id', userId)
      .maybeSingle();

    if (userError) {
      console.error('research-coach.js: user lookup failed:', userError.message);
      return res.status(500).json({ error: 'Server error. Please try again.' });
    }
    if (!userRow || userRow.plan_status !== 'active') {
      return res.status(403).json({ error: 'pro_required' });
    }
  } catch (err) {
    console.error('research-coach.js: user lookup error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('research-coach.js error: Missing ANTHROPIC_API_KEY environment variable');
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }

  const schoolT = typeof school === 'string' ? school.trim().slice(0, MAX_FIELD_LEN) : '';
  const courseT = typeof course === 'string' ? course.trim().slice(0, MAX_FIELD_LEN) : '';
  const textbookT = typeof textbook === 'string' ? textbook.trim().slice(0, MAX_FIELD_LEN) : '';
  const assignmentT = typeof assignment === 'string' ? assignment.trim().slice(0, MAX_ASSIGNMENT_LEN) : '';
  const topicT = topicTrimmed.slice(0, MAX_TOPIC_LEN);

  const userContent = `School/University: ${schoolT || 'Not given'}
Class/Course: ${courseT || 'Not given'}
Textbook: ${textbookT || 'Not given'}

Assignment Prompt:
${assignmentT || 'Not given'}

Topic or Working Thesis:
${topicT}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESEARCH_COACH_TIMEOUT_MS);

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
        system: RESEARCH_COACH_SYSTEM,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic API error:', data.error || data);
      return res.status(response.status).json({ error: 'Research Coach is unavailable right now. Please try again.' });
    }

    const raw = Array.isArray(data.content)
      ? data.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
      : '';

    let plan;
    try {
      plan = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch (parseErr) {
      console.error('research-coach.js: failed to parse model response as JSON:', parseErr.message);
      return res.status(502).json({ error: "Research Coach couldn't generate a valid plan. Please try again." });
    }

    // The defensive check: if the model ignored its instructions (or was
    // successfully prompt-injected into complying with a "write my
    // paper" request), reject the response outright rather than risk
    // serving actual paper prose to the client. Logged server-side only
    // -- this is non-sensitive academic-planning content, not user PII
    // or credentials, so no special handling is needed for where the log
    // goes; it's just for future tuning of the word/sentence thresholds.
    const validation = validatePlanShape(plan);
    if (!validation.ok) {
      console.error('research-coach.js: response failed the prose-length safety check:', validation.reason);
      return res.status(502).json({ error: "Research Coach couldn't generate a valid plan. Please try again." });
    }

    return res.status(200).json(plan);
  } catch (err) {
    console.error('research-coach.js error:', err);
    const message = err.name === 'AbortError' ? 'Research Coach timed out. Please try again.' : 'Server error. Please try again.';
    return res.status(err.name === 'AbortError' ? 504 : 500).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
}

// Named exports so tests can assert on the exact prompt/validation logic
// without duplicating it -- Vercel only ever calls the default export.
export { RESEARCH_COACH_SYSTEM, isProseLike, validatePlanShape, MAX_WORDS_PER_FIELD };
