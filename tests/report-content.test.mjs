// Run with: node --experimental-test-module-mocks --test tests/*.test.mjs
// (also wired up as `npm test`)
//
// Covers the new /api/report-content endpoint — in-app content flagging,
// required by Google Play's AI-Generated Content policy (users must be
// able to report AI-generated results to the developer without leaving
// the app). Verifies the tool allowlist rejects unrecognized/dangerous
// values before ever reaching Supabase, that reason is required, and
// that a valid report is inserted into content_reports with the right
// shape.
//
// Every mock is registered via the per-test `t.mock` tracker so it's
// always restored, pass or fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function stubSupabase(t, impl) {
  t.mock.module('../lib/supabaseAdmin.js', { namedExports: { getSupabaseAdmin: impl } });
}

async function loadHandler() {
  return import(`../api/report-content.js?t=${Date.now()}-${Math.random()}`);
}

const baseBody = { tool: 'profile_analyzer', userId: 'anon-device-123', reason: 'Inaccurate', note: 'Score seemed way off' };

test('rejects an unrecognized or dangerous tool value before ever calling Supabase', async (t) => {
  const insert = t.mock.fn(async () => ({ error: null }));
  stubSupabase(t, () => ({ from: () => ({ insert }) }));

  const { default: handler } = await loadHandler();
  for (const tool of ['__proto__', 'constructor', 'not_a_real_tool', undefined, 123]) {
    const res = mockRes();
    await handler({ method: 'POST', body: { ...baseBody, tool } }, res);
    assert.equal(res.statusCode, 400, `tool="${tool}" should be rejected, got ${res.statusCode}`);
  }
  assert.equal(insert.mock.callCount(), 0);
});

test('rejects a missing or empty reason', async (t) => {
  const insert = t.mock.fn(async () => ({ error: null }));
  stubSupabase(t, () => ({ from: () => ({ insert }) }));

  const { default: handler } = await loadHandler();
  for (const reason of [undefined, '', '   ']) {
    const res = mockRes();
    await handler({ method: 'POST', body: { ...baseBody, reason } }, res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(insert.mock.callCount(), 0);
});

test('accepts each allowed tool and inserts a well-formed row into content_reports', async (t) => {
  for (const tool of ['profile_analyzer', 'email_check', 'paper_check']) {
    await test(`tool=${tool}`, async (t2) => {
      let capturedTable = null;
      let capturedRow = null;
      stubSupabase(t2, () => ({
        from: (table) => {
          capturedTable = table;
          return { insert: async (row) => { capturedRow = row; return { error: null }; } };
        }
      }));

      const { default: handler } = await loadHandler();
      const res = mockRes();
      await handler({ method: 'POST', body: { ...baseBody, tool } }, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(capturedTable, 'content_reports');
      assert.equal(capturedRow.tool, tool);
      assert.equal(capturedRow.user_id, 'anon-device-123');
      assert.equal(capturedRow.reason, 'Inaccurate');
      assert.equal(capturedRow.note, 'Score seemed way off');
    });
  }
});

test('missing userId/note/resultSummary are stored as null rather than crashing', async (t) => {
  let capturedRow = null;
  stubSupabase(t, () => ({
    from: () => ({ insert: async (row) => { capturedRow = row; return { error: null }; } })
  }));

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { tool: 'email_check', reason: 'Misleading' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(capturedRow.user_id, null);
  assert.equal(capturedRow.note, null);
  assert.equal(capturedRow.result_summary, null);
});

test('degrades gracefully (500, no crash) when the Supabase insert fails', async (t) => {
  stubSupabase(t, () => ({
    from: () => ({ insert: async () => ({ error: { message: 'connection refused' } }) })
  }));

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Failed to submit report');
});

test('rejects non-POST methods', async (t) => {
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'GET', body: baseBody }, res);
  assert.equal(res.statusCode, 405);
});
