// Run with: node --experimental-test-module-mocks --test tests/*.test.mjs
// (also wired up as `npm test`)
//
// Covers the new /api/research-coach endpoint -- a Pro-only, pre-writing
// companion to Paper Check's instructor/writer modes. Entirely separate
// from api/analyze.js, gated the same way as api/inspector-advice.js and
// api/evidence-packet.js: a direct server-side plan_status lookup, never
// a client-supplied flag.
//
// The single most important property tested here is the defensive
// prose-length check: a model response that ignores its instructions (or
// was successfully prompt-injected into writing actual paper content)
// must be rejected outright, never served to the client. Both the reject
// case (a deliberately-crafted paragraph) and the pass case (a compliant
// fragment-only response) are tested explicitly, not just the happy path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProseLike, validatePlanShape, MAX_WORDS_PER_FIELD } from '../api/research-coach.js';

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function stubSupabase(t, maybeSingleImpl, capture) {
  t.mock.module('../lib/supabaseAdmin.js', {
    namedExports: {
      getSupabaseAdmin: () => ({
        from: (table) => {
          if (capture) capture.table = table;
          return {
            select: (cols) => {
              if (capture) capture.select = cols;
              return {
                eq: (col, val) => {
                  if (capture) capture.eq = { col, val };
                  return { maybeSingle: maybeSingleImpl };
                }
              };
            }
          };
        }
      })
    }
  });
}

function stubPro(t, capture) {
  stubSupabase(t, async () => ({ data: { plan_status: 'active' }, error: null }), capture);
}
function stubFree(t, capture) {
  stubSupabase(t, async () => ({ data: { plan_status: 'free' }, error: null }), capture);
}

const anthropicOk = (planObj) => async () => ({
  ok: true,
  json: async () => ({ content: [{ type: 'text', text: JSON.stringify(planObj) }] })
});

async function loadHandler() {
  return import(`../api/research-coach.js?t=${Date.now()}-${Math.random()}`);
}

const withKey = () => { process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'; };

const VALID_UID = '11111111-1111-4111-8111-111111111111';
const baseBody = { userId: VALID_UID, school: 'State U', course: 'ECON 201', textbook: '', assignment: 'Write a 5-page paper on inflation.', topic: 'How central bank policy affects inflation expectations' };

const compliantPlan = {
  research_questions: [
    'How do central banks communicate policy changes to the public?',
    'What historical episodes show inflation expectations shifting quickly?'
  ],
  outline: [
    { header: 'Introduction', purpose: 'Frame the research question and its relevance' },
    { header: 'Literature Review', purpose: 'Summarize existing findings on the topic' }
  ],
  source_categories: [
    'Peer-reviewed economics journals from the last 10 years',
    'Central bank policy statements and speeches'
  ],
  self_check_questions: [
    'Does every section tie back to the assignment prompt?',
    'Have I cited a source for every factual claim?'
  ]
};

// A deliberately-crafted response where one field is actual paper prose
// (multiple connected sentences), simulating the model ignoring its
// instructions or being prompt-injected into writing real content.
const proseLeakPlan = {
  research_questions: ['How do central banks communicate policy changes to the public?'],
  outline: [
    {
      header: 'Introduction',
      purpose: 'Inflation has long been one of the most closely watched indicators in modern macroeconomics. Central banks around the world have adopted increasingly transparent communication strategies over the past two decades. This section will explore how those strategies shape public expectations.'
    }
  ],
  source_categories: ['Peer-reviewed economics journals'],
  self_check_questions: ['Does every section tie back to the assignment prompt?']
};

test('rejects missing or invalid userId before ever calling Supabase or Anthropic', async (t) => {
  withKey();
  const capture = {};
  stubPro(t, capture);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should never be called'); });

  const { default: handler } = await loadHandler();
  for (const userId of [undefined, '', 'not-a-uuid', 123]) {
    const res = mockRes();
    await handler({ method: 'POST', body: { ...baseBody, userId } }, res);
    assert.equal(res.statusCode, 400, `userId=${JSON.stringify(userId)} should be rejected`);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(capture.table, undefined, 'Supabase should never be touched for an invalid userId');
});

test('rejects missing/empty topic before ever calling Supabase', async (t) => {
  withKey();
  const capture = {};
  stubPro(t, capture);
  const { default: handler } = await loadHandler();
  for (const topic of [undefined, '', '   ']) {
    const res = mockRes();
    await handler({ method: 'POST', body: { ...baseBody, topic } }, res);
    assert.equal(res.statusCode, 400, `topic=${JSON.stringify(topic)} should be rejected`);
  }
  assert.equal(capture.table, undefined);
});

test('a free-tier user gets 403 pro_required via a direct server-side plan_status lookup, and Anthropic is never called', async (t) => {
  const capture = {};
  stubFree(t, capture);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Anthropic should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'pro_required');
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(capture.table, 'users');
  assert.equal(capture.select, 'plan_status');
  assert.equal(capture.eq.col, 'id');
  assert.equal(capture.eq.val, VALID_UID);
});

test('a userId with no row yet is treated as not-Pro, not an error', async (t) => {
  stubSupabase(t, async () => ({ data: null, error: null }));
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Anthropic should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a client-supplied isPro-style flag is ignored -- only the server-side lookup decides', async (t) => {
  stubFree(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Anthropic should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, isPro: true, plan_status: 'active' } }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a Supabase lookup error fails closed (500), never proceeds to Anthropic', async (t) => {
  stubSupabase(t, async () => ({ data: null, error: { message: 'connection refused' } }));
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Anthropic should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a Pro user with a compliant, fragment-only model response gets a 200 with the exact plan', async (t) => {
  withKey();
  stubPro(t);
  let capturedBody;
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return anthropicOk(compliantPlan)();
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, compliantPlan);
  assert.equal(capturedBody.model, 'claude-sonnet-5');
  assert.match(capturedBody.system, /Research Coach/);
  assert.match(capturedBody.system, /never|NEVER/);
  assert.match(capturedBody.messages[0].content, /central bank policy/i);
});

test('DEFENSIVE CHECK: a response containing actual paper prose in one field is rejected (502), never served to the client', async (t) => {
  withKey();
  stubPro(t);
  t.mock.method(globalThis, 'fetch', async () => anthropicOk(proseLeakPlan)());

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /couldn't generate a valid plan/i);
  // The leaked prose must never appear anywhere in the response body.
  assert.doesNotMatch(JSON.stringify(res.body), /macroeconomics|transparent communication strategies/);
});

test('DEFENSIVE CHECK: a compliant fragment-only response passes cleanly (the counterpart to the reject test above)', async (t) => {
  withKey();
  stubPro(t);
  t.mock.method(globalThis, 'fetch', async () => anthropicOk(compliantPlan)());

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.outline, compliantPlan.outline);
});

test('a malformed JSON response from the model is a clean 502, not a crash', async (t) => {
  withKey();
  stubPro(t);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'not valid json {{{' }] }) }));

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /couldn't generate a valid plan/i);
});

test('a response with the wrong shape (missing/wrong-typed fields) is rejected, not partially served', async (t) => {
  withKey();
  stubPro(t);
  const badShapes = [
    { research_questions: 'not an array', outline: [], source_categories: [], self_check_questions: [] },
    { research_questions: [], outline: 'not an array', source_categories: [], self_check_questions: [] },
    { research_questions: [], outline: [{ header: 'x' }], source_categories: [], self_check_questions: [] }, // missing purpose
    null,
    'a string, not an object'
  ];
  let nextShape;
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(nextShape) }] }) }));

  const { default: handler } = await loadHandler();
  for (const shape of badShapes) {
    nextShape = shape;
    const res = mockRes();
    await handler({ method: 'POST', body: baseBody }, res);
    assert.equal(res.statusCode, 502, `shape=${JSON.stringify(shape)} should be rejected`);
  }
});

test('an Anthropic API-level error response is a clean error status, no raw error leaked', async (t) => {
  withKey();
  stubPro(t);
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { type: 'authentication_error', message: 'invalid x-api-key' } })
  }));

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 401);
  assert.doesNotMatch(res.body.error, /invalid x-api-key/);
});

test('missing ANTHROPIC_API_KEY degrades gracefully (500, no crash, no key leaked)', async (t) => {
  delete process.env.ANTHROPIC_API_KEY;
  stubPro(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Anthropic should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(fetchMock.mock.callCount(), 0);

  withKey();
});

test('a timeout (AbortError) is a clean 504, not a crash', async (t) => {
  withKey();
  stubPro(t);
  t.mock.method(globalThis, 'fetch', async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 504);
  assert.match(res.body.error, /timed out/i);
});

test('rejects non-POST methods', async (t) => {
  withKey();
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'GET', body: baseBody }, res);
  assert.equal(res.statusCode, 405);
});

// ════════════════════ Unit tests: isProseLike / validatePlanShape ════════════════════

test('isProseLike: rejects fields over MAX_WORDS_PER_FIELD words', () => {
  const longFragment = Array.from({ length: MAX_WORDS_PER_FIELD + 1 }, (_, i) => `word${i}`).join(' ');
  assert.equal(isProseLike(longFragment), true);
});

test('isProseLike: accepts a fragment right at the word boundary', () => {
  const atLimit = Array.from({ length: MAX_WORDS_PER_FIELD }, (_, i) => `word${i}`).join(' ');
  assert.equal(isProseLike(atLimit), false);
});

test('isProseLike: rejects a field with more than one sentence-terminator (multi-sentence paragraph)', () => {
  assert.equal(isProseLike('This is one sentence. This is another sentence.'), true);
});

test('isProseLike: accepts a single question or fragment with at most one terminator', () => {
  assert.equal(isProseLike('How do central banks communicate policy changes?'), false);
  assert.equal(isProseLike('Frame the research question and its relevance'), false);
});

test('isProseLike: rejects non-string and empty values', () => {
  assert.equal(isProseLike(null), true);
  assert.equal(isProseLike(undefined), true);
  assert.equal(isProseLike(42), true);
  assert.equal(isProseLike(''), true);
  assert.equal(isProseLike('   '), true);
});

test('validatePlanShape: accepts the known-good compliant plan', () => {
  assert.deepEqual(validatePlanShape(compliantPlan), { ok: true });
});

test('validatePlanShape: rejects the known-bad prose-leak plan with a reason naming the offending field', () => {
  const result = validatePlanShape(proseLeakPlan);
  assert.equal(result.ok, false);
  assert.match(result.reason, /outline purpose/);
});
