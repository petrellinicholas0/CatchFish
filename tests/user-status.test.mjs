// Run with: node --experimental-test-module-mocks --test tests/*.test.mjs
// (also wired up as `npm test`)
//
// Covers the new /api/user-status endpoint -- a pure, ungated read of the
// current `credits` balance, added so index.html's usage strip can
// display universal credit-pack balances (see supabase/migrations/
// 0010_add_universal_credit_packs.sql). This is display only: it never
// gates or consumes anything, and check_and_increment_usage remains the
// sole enforcement point.

import { test } from 'node:test';
import assert from 'node:assert/strict';

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

async function loadHandler() {
  return import(`../api/user-status.js?t=${Date.now()}-${Math.random()}`);
}

const VALID_UID = '11111111-1111-4111-8111-111111111111';

test('rejects missing or invalid userId before ever calling Supabase', async (t) => {
  const capture = {};
  stubSupabase(t, async () => ({ data: { credits: 5 }, error: null }), capture);
  const { default: handler } = await loadHandler();
  for (const userId of [undefined, '', 'not-a-uuid', 123]) {
    const res = mockRes();
    await handler({ method: 'POST', body: { userId } }, res);
    assert.equal(res.statusCode, 400, `userId=${JSON.stringify(userId)} should be rejected`);
  }
  assert.equal(capture.table, undefined);
});

test('returns the real credits balance for an existing user', async (t) => {
  const capture = {};
  stubSupabase(t, async () => ({ data: { credits: 17 }, error: null }), capture);
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { credits: 17 });
  assert.equal(capture.table, 'users');
  assert.equal(capture.select, 'credits');
  assert.equal(capture.eq.col, 'id');
  assert.equal(capture.eq.val, VALID_UID);
});

test('a userId with no row yet returns credits:0, not an error', async (t) => {
  stubSupabase(t, async () => ({ data: null, error: null }));
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { credits: 0 });
});

test('a Supabase lookup error fails closed (500), never leaks the raw error', async (t) => {
  stubSupabase(t, async () => ({ data: null, error: { message: 'connection refused' } }));
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID } }, res);

  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(res.body.error, /connection refused/);
});

test('rejects non-POST methods', async () => {
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'GET', body: { userId: VALID_UID } }, res);
  assert.equal(res.statusCode, 405);
});
