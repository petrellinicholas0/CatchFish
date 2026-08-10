// Run with: node --experimental-test-module-mocks --test tests/*.test.mjs
// (also wired up as `npm test`)
//
// Covers audit finding #2 (CRITICAL): api/checkout.js used to upsert with
// onConflict: 'email' while writing a client-supplied `id`, so anyone who
// knew an existing user's email could hijack that user's row — inheriting
// their plan_status (including an active paid subscription) for free and
// orphaning the real owner's entitlement. The fix changes the conflict
// target to `id`. This test drives a stateful in-memory mock of the
// `users` table through the real upsert semantics (insert-or-update
// keyed by the declared conflict column) to prove a colliding email with
// a different id now creates a separate row instead of overwriting the
// existing one.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Minimal stand-in for the one Supabase call path api/checkout.js uses:
// .from('users').upsert(data, { onConflict }). Mirrors real Postgres
// upsert semantics for the column actually declared as the conflict
// target: match on that column; if found, update only the columns present
// in `data` (existing columns not included are left untouched); if not
// found, insert a new row.
function makeUsersTableMock(rows) {
  return {
    from(table) {
      assert.equal(table, 'users');
      return {
        async upsert(data, opts) {
          const conflictCol = opts.onConflict;
          const existing = rows.find((r) => r[conflictCol] === data[conflictCol]);
          if (existing) {
            Object.assign(existing, data);
          } else {
            rows.push({ plan_status: 'free', usage_count: 0, ...data });
          }
          return { error: null };
        }
      };
    }
  };
}

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function loadHandler() {
  return import(`../api/checkout.js?t=${Date.now()}-${Math.random()}`);
}

const VICTIM_ID = '11111111-1111-4111-8111-111111111111';
const ATTACKER_ID = '22222222-2222-4222-8222-222222222222';

test('checkout upsert keys on id: a colliding email with a different id creates a separate row, never overwrites the existing one', async () => {
  const rows = [
    { id: VICTIM_ID, email: 'victim@example.com', plan_status: 'active', stripe_customer_id: 'cus_realvictim123', usage_count: 5 }
  ];

  const stripeMock = mock.module('../lib/stripeAdmin.js', {
    namedExports: {
      getStripe: () => ({
        checkout: { sessions: { create: async () => ({ url: 'https://checkout.stripe.com/fake' }) } }
      })
    }
  });
  const supabaseMock = mock.module('../lib/supabaseAdmin.js', {
    namedExports: { getSupabaseAdmin: () => makeUsersTableMock(rows) }
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({
    method: 'POST',
    headers: {},
    body: { plan: 'monthly', userId: ATTACKER_ID, email: 'victim@example.com' }
  }, res);

  assert.equal(res.statusCode, 200, 'checkout should still succeed for the attacker (their own new row)');

  const victimRow = rows.find((r) => r.id === VICTIM_ID);
  const attackerRow = rows.find((r) => r.id === ATTACKER_ID);

  assert.ok(victimRow, 'victim row must still exist');
  assert.equal(victimRow.plan_status, 'active', "victim's paid plan must be untouched");
  assert.equal(victimRow.stripe_customer_id, 'cus_realvictim123');
  assert.equal(victimRow.usage_count, 5);

  assert.ok(attackerRow, 'attacker gets their own new row');
  assert.notEqual(attackerRow.id, victimRow.id);
  assert.equal(attackerRow.plan_status, 'free', 'attacker must NOT inherit the victim\'s paid status');
  assert.equal(rows.length, 2, 'no row was overwritten — a second row was created instead');

  stripeMock.restore();
  supabaseMock.restore();
});

test('checkout upsert: the same device (same id) retrying checkout updates its own row, not a duplicate', async () => {
  const rows = [
    { id: ATTACKER_ID, email: 'typo@example.com', plan_status: 'free', usage_count: 0 }
  ];

  const stripeMock = mock.module('../lib/stripeAdmin.js', {
    namedExports: {
      getStripe: () => ({
        checkout: { sessions: { create: async () => ({ url: 'https://checkout.stripe.com/fake' }) } }
      })
    }
  });
  const supabaseMock = mock.module('../lib/supabaseAdmin.js', {
    namedExports: { getSupabaseAdmin: () => makeUsersTableMock(rows) }
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({
    method: 'POST',
    headers: {},
    body: { plan: 'monthly', userId: ATTACKER_ID, email: 'corrected@example.com' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(rows.length, 1, 'still one row for this device id');
  assert.equal(rows[0].email, 'corrected@example.com');

  stripeMock.restore();
  supabaseMock.restore();
});

test('checkout upsert is called with onConflict: "id"', async () => {
  let capturedOpts = null;
  const stripeMock = mock.module('../lib/stripeAdmin.js', {
    namedExports: {
      getStripe: () => ({
        checkout: { sessions: { create: async () => ({ url: 'https://checkout.stripe.com/fake' }) } }
      })
    }
  });
  const supabaseMock = mock.module('../lib/supabaseAdmin.js', {
    namedExports: {
      getSupabaseAdmin: () => ({
        from: () => ({
          upsert: async (data, opts) => { capturedOpts = opts; return { error: null }; }
        })
      })
    }
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', headers: {}, body: { plan: 'monthly', userId: ATTACKER_ID, email: 'x@y.com' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(capturedOpts.onConflict, 'id');

  stripeMock.restore();
  supabaseMock.restore();
});
