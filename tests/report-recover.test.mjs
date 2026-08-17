// Run with: node --experimental-test-module-mocks --test tests/*.test.mjs
// (also wired up as `npm test`)
//
// Covers the new /api/report-recover endpoint -- Case File's "next step"
// after Evidence Packet: a deterministic action-sequencing checklist plus
// three AI-drafted reference documents (IC3, FTC, bank fraud-dispute
// letter), generated ONLY from facts already compiled by
// api/evidence-packet.js plus a few directly user-typed facts. Pro status
// is verified server-side against plan_status, same pattern as
// api/inspector-advice.js/api/evidence-packet.js.
//
// The most important thing this file proves: the hard "never fabricate"
// constraint is enforced, not just requested -- both a positive test
// (a compliant draft using [CONFIRM] for a missing fact passes through)
// and a negative control (a draft inventing a dollar amount/date/name not
// in the source facts is rejected with 502, never reaching the client).
//
// Every mock is registered via the per-test `t.mock` tracker so it's
// always restored, pass or fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function loadHandler() {
  return import(`../api/report-recover.js?t=${Date.now()}-${Math.random()}`);
}

const withKey = () => { process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'; };

const VALID_UID = '11111111-1111-4111-8111-111111111111';

const SAMPLE_EVIDENCE_PACKET = {
  generatedAt: '2024-03-01T00:00:00.000Z',
  exactMatches: [{ imageIndex: 0, url: 'https://stolenphoto.example.com/a.jpg' }],
  partialMatches: [],
  similarNotConfirmed: [],
  pagesFound: [
    { url: 'https://fakeprofile.example.com/user/123', pageTitle: 'Real Name Here', domain: 'fakeprofile.example.com', domainRegisteredDate: '2023-11-02T00:00:00Z' }
  ],
  submittedTextExcerpt: 'His name was Michael and he said he was an oil rig engineer overseas.'
};

const REQUIRED_OPENING_LINE = 'This draft was generated from what you provided. Review every field — especially any marked [CONFIRM] — before using it. You are responsible for what you submit.';

function validDrafts({ moneyLost }) {
  const base = `${REQUIRED_OPENING_LINE}\n\nVictim: [CONFIRM: your name not specified -- fill in before submitting]\nSubject: Michael\nPlatform: [CONFIRM: platform not specified -- fill in before submitting]\nNarrative: His name was Michael and he said he was an oil rig engineer overseas. Photo found at https://fakeprofile.example.com/user/123 (domain registered 2023-11-02).`;
  return {
    ic3_draft: base,
    ftc_draft: base,
    bank_draft: moneyLost ? `${REQUIRED_OPENING_LINE}\n\nDisputing a transaction. Amount: [CONFIRM: amount not specified -- fill in before submitting]. Date: [CONFIRM: date not specified -- fill in before submitting].` : null
  };
}

const anthropicOk = (obj) => async () => ({
  ok: true,
  json: async () => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] })
});

const baseBody = { userId: VALID_UID, evidencePacket: SAMPLE_EVIDENCE_PACKET, moneyLost: false };

// ════════════════════ Input validation / Pro-gating ════════════════════

test('rejects missing or invalid userId before ever touching Supabase or Anthropic', async (t) => {
  withKey();
  const capture = {};
  stubPro(t, capture);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Anthropic should never be called'); });

  const { default: handler } = await loadHandler();
  for (const userId of [undefined, '', 'not-a-uuid', 123]) {
    const res = mockRes();
    await handler({ method: 'POST', body: { ...baseBody, userId } }, res);
    assert.equal(res.statusCode, 400, `userId=${JSON.stringify(userId)} should be rejected`);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(capture.table, undefined, 'Supabase should never be touched for an invalid userId');
});

test('a free-tier user gets 403 pro_required via a direct server-side plan_status lookup, Anthropic never called', async (t) => {
  withKey();
  stubFree(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Anthropic should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'pro_required');
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a client-supplied isPro/plan_status flag is ignored -- only the server-side lookup decides', async (t) => {
  withKey();
  stubFree(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, isPro: true, plan_status: 'active' } }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('rejects non-POST methods', async (t) => {
  withKey();
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'GET', body: baseBody }, res);
  assert.equal(res.statusCode, 405);
});

test('missing ANTHROPIC_API_KEY degrades gracefully (500, no crash, no key leaked)', async (t) => {
  delete process.env.ANTHROPIC_API_KEY;
  stubPro(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should never be called'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(fetchMock.mock.callCount(), 0);
  withKey();
});

// ════════════════════ FIX 1: action-sequencing checklist (deterministic) ═

test('checklist: money lost -> bank fraud department is first and marked urgent', async () => {
  const { buildChecklist } = await loadHandler();
  const steps = buildChecklist({ moneyLost: true, platform: 'Hinge' });
  assert.match(steps[0].label, /bank|fraud department/i);
  assert.equal(steps[0].urgent, true);
  assert.equal(steps.length, 4, 'bank + platform + IC3 + FTC');
});

test('checklist: no money lost -> skips straight to platform/IC3/FTC, no bank step at all', async () => {
  const { buildChecklist } = await loadHandler();
  const steps = buildChecklist({ moneyLost: false, platform: 'Hinge' });
  assert.equal(steps.length, 3, 'platform + IC3 + FTC only');
  assert.ok(!steps.some((s) => /bank/i.test(s.label)), 'no bank step should appear when no money was lost');
  assert.equal(steps.every((s) => s.urgent === false), true, 'nothing is urgent when there is no time-sensitive bank step');
});

test('checklist: platform name is used when given, falls back to generic wording when not', async () => {
  const { buildChecklist } = await loadHandler();
  const withPlatform = buildChecklist({ moneyLost: false, platform: 'Hinge' });
  assert.match(withPlatform[0].label, /Hinge/);
  const withoutPlatform = buildChecklist({ moneyLost: false, platform: '' });
  assert.match(withoutPlatform[0].label, /platform where you met/i);
});

test('checklist: IC3 always comes before FTC, regardless of money-lost state', async () => {
  const { buildChecklist } = await loadHandler();
  for (const moneyLost of [true, false]) {
    const steps = buildChecklist({ moneyLost, platform: 'Hinge' });
    const ic3Index = steps.findIndex((s) => /IC3/.test(s.label));
    const ftcIndex = steps.findIndex((s) => /FTC/.test(s.label));
    assert.ok(ic3Index >= 0 && ftcIndex >= 0 && ic3Index < ftcIndex, `IC3 must precede FTC (moneyLost=${moneyLost})`);
  }
});

test('end-to-end: the response checklist reorders correctly based on moneyLost in the actual request', async (t) => {
  withKey();
  stubPro(t);
  t.mock.method(globalThis, 'fetch', async () => anthropicOk(validDrafts({ moneyLost: true }))());

  const { default: handler } = await loadHandler();
  const resWithMoney = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, moneyLost: true, moneyLostAmount: '$500', moneyLostMethod: 'Zelle' } }, resWithMoney);
  assert.equal(resWithMoney.statusCode, 200);
  assert.match(resWithMoney.body.checklist[0].label, /bank|fraud department/i);
  assert.equal(resWithMoney.body.checklist[0].urgent, true);

  const resNoMoney = mockRes();
  t.mock.method(globalThis, 'fetch', async () => anthropicOk(validDrafts({ moneyLost: false }))());
  await handler({ method: 'POST', body: { ...baseBody, moneyLost: false } }, resNoMoney);
  assert.equal(resNoMoney.statusCode, 200);
  assert.ok(!resNoMoney.body.checklist.some((s) => /bank/i.test(s.label)));
});

// ════════════════════ FIX 3: never-fabricate — positive case ════════════

test('real test: a compliant draft using [CONFIRM] for a missing date/amount passes through unchanged', async (t) => {
  withKey();
  stubPro(t);
  // No moneyLostAmount/incidentDate given at all -- the model is expected
  // to use [CONFIRM] placeholders, exactly what validDrafts() produces.
  t.mock.method(globalThis, 'fetch', async () => anthropicOk(validDrafts({ moneyLost: false }))());

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, moneyLost: false } }, res);

  assert.equal(res.statusCode, 200);
  assert.match(res.body.drafts.ic3, /\[CONFIRM/, 'the missing platform must show as a [CONFIRM] placeholder');
  assert.doesNotMatch(res.body.drafts.ic3, /\$\d/, 'no fabricated dollar figure should appear');
  assert.match(res.body.drafts.ic3, /^This draft was generated from what you provided/, 'must open with the mandatory review line');
});

// ════════════════════ FIX 3: never-fabricate — negative controls ════════

test('negative control: a fabricated dollar amount not in the source facts is rejected (502), never reaches the client', async (t) => {
  withKey();
  stubPro(t);
  const fabricated = validDrafts({ moneyLost: false });
  // No moneyLostAmount was ever given -- this $500 is invented.
  fabricated.ic3_draft += '\nThe user lost approximately $500 in this scam.';
  t.mock.method(globalThis, 'fetch', async () => anthropicOk(fabricated)());

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, moneyLost: false } }, res);

  assert.equal(res.statusCode, 502, 'a fabricated dollar amount must be rejected outright');
  assert.equal(res.body.drafts, undefined, 'no draft content must ever reach the client on rejection');
});

test('negative control: a fabricated date not in the source facts is rejected (502)', async (t) => {
  withKey();
  stubPro(t);
  const fabricated = validDrafts({ moneyLost: false });
  fabricated.ic3_draft += '\nThe incident occurred on June 14, 2024.';
  t.mock.method(globalThis, 'fetch', async () => anthropicOk(fabricated)());

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, moneyLost: false } }, res);

  assert.equal(res.statusCode, 502);
});

test('negative control: a fabricated name not in the source facts is rejected (502)', async (t) => {
  withKey();
  stubPro(t);
  const fabricated = validDrafts({ moneyLost: false });
  // "Michael" is in the source text; "Robert Anderson" is invented.
  fabricated.ic3_draft += '\nThe subject also used the alias Robert Anderson.';
  t.mock.method(globalThis, 'fetch', async () => anthropicOk(fabricated)());

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, moneyLost: false } }, res);

  assert.equal(res.statusCode, 502);
});

test('a legitimate reformatting of a real source date (ISO -> prose) is NOT flagged as fabrication', async (t) => {
  withKey();
  stubPro(t);
  const reformatted = validDrafts({ moneyLost: false });
  // 2023-11-02 (domainRegisteredDate in SAMPLE_EVIDENCE_PACKET) reformatted as prose.
  reformatted.ic3_draft += '\nThe matching page domain was registered on November 2, 2023.';
  t.mock.method(globalThis, 'fetch', async () => anthropicOk(reformatted)());

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, moneyLost: false } }, res);

  assert.equal(res.statusCode, 200, 'reformatting a real source date must not be mistaken for fabrication');
});

test('a real dollar amount the user actually provided, reformatted, is NOT flagged as fabrication', async (t) => {
  withKey();
  stubPro(t);
  const drafts = validDrafts({ moneyLost: true });
  drafts.bank_draft = drafts.bank_draft.replace('[CONFIRM: amount not specified -- fill in before submitting]', '$2,500.00');
  t.mock.method(globalThis, 'fetch', async () => anthropicOk(drafts)());

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, moneyLost: true, moneyLostAmount: '$2,500', moneyLostMethod: 'wire transfer' } }, res);

  assert.equal(res.statusCode, 200, 'a real user-provided amount, reformatted, must not be flagged');
});

test('bank_draft must be null when moneyLost is false -- a non-null bank_draft is rejected', async (t) => {
  withKey();
  stubPro(t);
  const bad = validDrafts({ moneyLost: false });
  bad.bank_draft = 'a draft that should not exist';
  t.mock.method(globalThis, 'fetch', async () => anthropicOk(bad)());

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, moneyLost: false } }, res);

  assert.equal(res.statusCode, 502);
});

test('bank_draft is required (and validated) when moneyLost is true', async (t) => {
  withKey();
  stubPro(t);
  const missingBank = validDrafts({ moneyLost: true });
  missingBank.bank_draft = null;
  t.mock.method(globalThis, 'fetch', async () => anthropicOk(missingBank)());

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, moneyLost: true, moneyLostAmount: '$500', moneyLostMethod: 'Zelle' } }, res);

  assert.equal(res.statusCode, 502);
});

test('overclaiming language ("guaranteed", "we handle it", "100%") is rejected server-side', async (t) => {
  withKey();
  stubPro(t);
  for (const phrase of ['This is guaranteed to work.', 'CatchFish will handle this for you.', 'This will 100% get your money back.', 'We will submit this on your behalf.']) {
    const bad = validDrafts({ moneyLost: false });
    bad.ic3_draft += '\n' + phrase;
    t.mock.method(globalThis, 'fetch', async () => anthropicOk(bad)());

    const { default: handler } = await loadHandler();
    const res = mockRes();
    await handler({ method: 'POST', body: { ...baseBody, moneyLost: false } }, res);
    assert.equal(res.statusCode, 502, `phrase "${phrase}" should be rejected`);
  }
});

// ════════════════════ FIX 4: no submission/auto-send capability ═════════

test('the ONLY network call the handler ever makes is to api.anthropic.com -- confirmed by call count, not just absence of an error', async (t) => {
  withKey();
  stubPro(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages', 'no other destination should ever be fetched');
    return anthropicOk(validDrafts({ moneyLost: false }))();
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, moneyLost: false, incidentDate: '2024-01-05', platform: 'Hinge' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(fetchMock.mock.callCount(), 1, 'exactly one network call total -- nothing is ever sent to IC3/FTC/a bank/anywhere else');
});

test('static check: the source file never constructs a URL to a filing destination, has no email-sending capability, and makes exactly one outbound fetch() call (the Anthropic one)', async () => {
  const filePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'api', 'report-recover.js');
  const source = fs.readFileSync(filePath, 'utf8');
  // Mentioning IC3/FTC by name in the system prompt (telling the model what
  // form style to draft for) is expected and correct -- what must never
  // exist is an actual URL literal pointing at one of those destinations.
  assert.doesNotMatch(source, /https?:\/\/[^\s"'`]*(?:ic3\.gov|ftc\.gov)/i, 'this file must never construct a URL to a filing destination -- it only ever drafts text');
  assert.doesNotMatch(source, /nodemailer|sendgrid|sendMail|smtp/i, 'no email-sending capability should exist in this file');
  const fetchCalls = source.match(/fetch\(/g) || [];
  assert.equal(fetchCalls.length, 1, 'exactly one fetch() call in the whole file (the Anthropic call)');
});

// ════════════════════ Fabrication-detector unit tests ═══════════════════

test('extractDollarAmounts: finds $-prefixed and "N dollars" forms, ignores non-money numbers', async () => {
  const { extractDollarAmounts } = await loadHandler();
  assert.deepEqual(extractDollarAmounts('I lost $2,500.00 and later another 300 dollars.'), [2500, 300]);
  assert.deepEqual(extractDollarAmounts('Photo 1 and photo 2 were found.'), []);
});

test('extractDateComponents: ISO, MM/DD/YYYY, and prose dates all normalize to the same {year,month} form', async () => {
  const { extractDateComponents } = await loadHandler();
  assert.deepEqual(extractDateComponents('Registered 2023-11-02.'), ['2023-11']);
  assert.deepEqual(extractDateComponents('Registered 11/2/2023.'), ['2023-11']);
  assert.deepEqual(extractDateComponents('Registered November 2, 2023.'), ['2023-11']);
  assert.deepEqual(extractDateComponents('Registered 2 November 2023.'), ['2023-11']);
});

test('extractCandidateNames: filters out common institutional/template boilerplate', async () => {
  const { extractCandidateNames } = await loadHandler();
  const names = extractCandidateNames('Filed with the Internet Crime Complaint Center and the Federal Trade Commission. Best Regards, Robert Anderson.');
  assert.ok(names.includes('Robert Anderson'), 'a genuine name-shaped phrase should still be caught');
  assert.ok(!names.some((n) => /Internet Crime|Federal Trade|Best Regards/.test(n)), 'known boilerplate phrases must not be flagged');
});

test('validateReportRecoverDraft: [CONFIRM: ...] bracketed content is never itself flagged', async () => {
  const { validateReportRecoverDraft } = await loadHandler();
  const result = validateReportRecoverDraft('Amount: [CONFIRM: exact amount not specified, e.g. $9,999 -- fill in before submitting]', '');
  assert.equal(result.ok, true, 'text inside a [CONFIRM] bracket must never trigger the fabrication check');
});

test('validateReportRecoverDraft: rejects an empty or non-string draft', async () => {
  const { validateReportRecoverDraft } = await loadHandler();
  assert.equal(validateReportRecoverDraft('', 'facts').ok, false);
  assert.equal(validateReportRecoverDraft('   ', 'facts').ok, false);
  assert.equal(validateReportRecoverDraft(null, 'facts').ok, false);
  assert.equal(validateReportRecoverDraft(42, 'facts').ok, false);
});

// ════════════════════ buildFacts: bounding / defaults ════════════════════

test('buildFacts: bounds oversized arrays and truncates oversized strings rather than crashing', async () => {
  const { buildFacts } = await loadHandler();
  const oversized = {
    evidencePacket: {
      exactMatches: Array.from({ length: 100 }, (_, i) => ({ imageIndex: i, url: `https://x.example.com/${i}` })),
      submittedTextExcerpt: 'x'.repeat(10000)
    },
    moneyLostAmount: 'y'.repeat(1000),
    platform: 'z'.repeat(1000)
  };
  const facts = buildFacts(oversized);
  assert.ok(facts.exactMatches.length <= 50);
  assert.ok(facts.submittedTextExcerpt.length <= 5000);
  assert.ok(facts.moneyLostAmount.length <= 200);
  assert.ok(facts.platform.length <= 200);
});

test('buildFacts: malformed/missing evidencePacket never crashes, defaults to empty facts', async () => {
  const { buildFacts } = await loadHandler();
  assert.doesNotThrow(() => buildFacts({}));
  assert.doesNotThrow(() => buildFacts({ evidencePacket: null }));
  assert.doesNotThrow(() => buildFacts({ evidencePacket: 'not an object' }));
  const facts = buildFacts({});
  assert.deepEqual(facts.exactMatches, []);
  assert.equal(facts.moneyLost, false);
});

test('buildFacts: moneyLost is strictly boolean-true-only -- a truthy string does not count', async () => {
  const { buildFacts } = await loadHandler();
  assert.equal(buildFacts({ moneyLost: 'true' }).moneyLost, false, 'only the literal boolean true should set moneyLost');
  assert.equal(buildFacts({ moneyLost: true }).moneyLost, true);
});

// ════════════════════ System prompt content checks ════════════════════

test('REPORT_RECOVER_SYSTEM states the hard never-fabricate rule and the mandatory opening line', async () => {
  const { REPORT_RECOVER_SYSTEM } = await loadHandler();
  assert.match(REPORT_RECOVER_SYSTEM, /never infer, estimate, guess/i);
  assert.match(REPORT_RECOVER_SYSTEM, /\[CONFIRM/);
  assert.match(REPORT_RECOVER_SYSTEM, /This draft was generated from what you provided/);
  assert.match(REPORT_RECOVER_SYSTEM, /never submitted anywhere by CatchFish/i);
  assert.match(REPORT_RECOVER_SYSTEM, /guarantee/i);
});

test('a malformed JSON response is a clean 502, not a crash', async (t) => {
  withKey();
  stubPro(t);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'not valid json {{{' }] }) }));

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 502);
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
