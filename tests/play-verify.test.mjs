// Run with: node --experimental-test-module-mocks --test tests/*.test.mjs
// (also wired up as `npm test`)
//
// Covers the new /api/play-verify endpoint (Google Play Billing support
// for installed TWA users). Verifies both the subscription and one-time
// purchase paths, that a purchase is only ever acknowledged once, that
// invalid input never reaches Google's API or Supabase, and that the
// upsert on success uses onConflict: 'id' (never 'email' — see the
// account-takeover fix this mirrors in api/checkout.js).
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

function stubGooglePlay(t, impl) {
  t.mock.module('../lib/googlePlayAdmin.js', { namedExports: { getAndroidPublisher: impl } });
}

// Minimal stand-in for the two Supabase call shapes api/play-verify.js
// uses: .from('users').select('id').eq(col, val).maybeSingle() for the
// redemption lookup, and .from('users').upsert(data, opts) for the grant.
// Mirrors real Postgres unique-constraint semantics for play_purchase_token
// (migration 0011): an upsert that would write a token already present on
// a DIFFERENT row fails with a unique-violation (code 23505), same as the
// live database would once the constraint is applied.
function stubSupabase(t, rows) {
  t.mock.module('../lib/supabaseAdmin.js', {
    namedExports: {
      getSupabaseAdmin: () => ({
        from: () => ({
          select: () => ({
            eq: (col, val) => ({
              async maybeSingle() {
                const match = rows.find((r) => r[col] === val);
                return { data: match ? { id: match.id } : null, error: null };
              }
            })
          }),
          async upsert(data, opts) {
            assert.equal(opts.onConflict, 'id', 'must always upsert keyed by id, never email');
            const tokenOwner = data.play_purchase_token
              ? rows.find((r) => r.play_purchase_token === data.play_purchase_token && r.id !== data.id)
              : null;
            if (tokenOwner) {
              return { error: { code: '23505', message: 'duplicate key value violates unique constraint "users_play_purchase_token_key"' } };
            }
            const existing = rows.find((r) => r.id === data.id);
            if (existing) Object.assign(existing, data);
            else rows.push({ plan_status: 'free', ...data });
            return { error: null };
          }
        })
      })
    }
  });
}

async function loadHandler() {
  return import(`../api/play-verify.js?t=${Date.now()}-${Math.random()}`);
}

const VALID_UID = '11111111-1111-4111-8111-111111111111';
const baseBody = { userId: VALID_UID, productId: 'catchfish_monthly', purchaseToken: 'tok_abc123', planType: 'subscription' };

test('rejects missing/invalid userId before ever calling Google or Supabase', async (t) => {
  const getAP = t.mock.fn();
  stubGooglePlay(t, getAP);
  const { default: handler } = await loadHandler();
  for (const userId of [undefined, '', 'not-a-uuid', 123]) {
    const res = mockRes();
    await handler({ method: 'POST', body: { ...baseBody, userId } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
  }
  assert.equal(getAP.mock.callCount(), 0);
});

test('rejects an unrecognized productId (defense against the same key-confusion class as PRICE_IDS)', async (t) => {
  const getAP = t.mock.fn();
  stubGooglePlay(t, getAP);
  const { default: handler } = await loadHandler();
  for (const productId of ['__proto__', 'constructor', 'not_a_real_sku']) {
    const res = mockRes();
    await handler({ method: 'POST', body: { ...baseBody, productId } }, res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(getAP.mock.callCount(), 0);
});

test('rejects missing purchaseToken and invalid planType', async (t) => {
  const getAP = t.mock.fn();
  stubGooglePlay(t, getAP);
  const { default: handler } = await loadHandler();

  const res1 = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, purchaseToken: '' } }, res1);
  assert.equal(res1.statusCode, 400);

  const res2 = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, planType: 'lifetime' } }, res2);
  assert.equal(res2.statusCode, 400);

  assert.equal(getAP.mock.callCount(), 0);
});

test('subscription: SUBSCRIPTION_STATE_ACTIVE grants access and upserts plan_status=active', async (t) => {
  const rows = [];
  stubGooglePlay(t, () => ({
    purchases: {
      subscriptionsv2: {
        get: async ({ packageName, token }) => {
          assert.equal(packageName, 'com.nickpetrelli.catchfish');
          assert.equal(token, 'tok_abc123');
          return { data: { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' } };
        }
      }
    }
  }));
  stubSupabase(t, rows);

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(rows[0].id, VALID_UID);
  assert.equal(rows[0].plan_status, 'active');
  assert.equal(rows[0].play_purchase_token, 'tok_abc123');
});

test('subscription: SUBSCRIPTION_STATE_IN_GRACE_PERIOD still grants access', async (t) => {
  const rows = [];
  stubGooglePlay(t, () => ({
    purchases: { subscriptionsv2: { get: async () => ({ data: { subscriptionState: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD' } }) } }
  }));
  stubSupabase(t, rows);

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(rows[0].plan_status, 'active');
});

test('subscription: CANCELED/EXPIRED states are rejected (402), no Supabase write happens', async (t) => {
  for (const subscriptionState of ['SUBSCRIPTION_STATE_CANCELED', 'SUBSCRIPTION_STATE_EXPIRED', 'SUBSCRIPTION_STATE_ON_HOLD']) {
    await test(`state=${subscriptionState}`, async (t2) => {
      const rows = [];
      let upsertCalled = false;
      stubGooglePlay(t2, () => ({ purchases: { subscriptionsv2: { get: async () => ({ data: { subscriptionState } }) } } }));
      t2.mock.module('../lib/supabaseAdmin.js', {
        namedExports: { getSupabaseAdmin: () => ({ from: () => ({ upsert: async () => { upsertCalled = true; return { error: null }; } }) }) }
      });

      const { default: handler } = await loadHandler();
      const res = mockRes();
      await handler({ method: 'POST', body: baseBody }, res);

      assert.equal(res.statusCode, 402);
      assert.equal(res.body.success, false);
      assert.equal(upsertCalled, false, `${subscriptionState} must not grant access`);
    });
  }
});

test('onetime: purchaseState 0 (purchased) grants access and acknowledges an unacknowledged purchase', async (t) => {
  const rows = [];
  let acknowledgeCallCount = 0;
  stubGooglePlay(t, () => ({
    purchases: {
      products: {
        get: async ({ packageName, productId, token }) => {
          assert.equal(packageName, 'com.nickpetrelli.catchfish');
          assert.equal(productId, 'catchfish_single');
          assert.equal(token, 'tok_onetime');
          return { data: { purchaseState: 0, acknowledgementState: 0 } };
        },
        acknowledge: async () => { acknowledgeCallCount++; return { data: {} }; }
      }
    }
  }));
  stubSupabase(t, rows);

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, productId: 'catchfish_single', purchaseToken: 'tok_onetime', planType: 'onetime' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(acknowledgeCallCount, 1);
  assert.equal(rows[0].plan_status, 'active');
});

test('onetime: an already-acknowledged purchase is NOT re-acknowledged (retry-safe)', async (t) => {
  const rows = [];
  let acknowledgeCallCount = 0;
  stubGooglePlay(t, () => ({
    purchases: {
      products: {
        get: async () => ({ data: { purchaseState: 0, acknowledgementState: 1 } }),
        acknowledge: async () => { acknowledgeCallCount++; return { data: {} }; }
      }
    }
  }));
  stubSupabase(t, rows);

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, productId: 'catchfish_single', purchaseToken: 'tok_onetime', planType: 'onetime' } }, res);

  assert.equal(res.statusCode, 200, 'a retried verify call for an already-acknowledged purchase must still succeed');
  assert.equal(acknowledgeCallCount, 0, 'must not call acknowledge twice');
});

test('onetime: purchaseState 1 (canceled) is rejected, no acknowledge call, no Supabase write', async (t) => {
  let acknowledgeCallCount = 0;
  let upsertCalled = false;
  stubGooglePlay(t, () => ({
    purchases: {
      products: {
        get: async () => ({ data: { purchaseState: 1, acknowledgementState: 0 } }),
        acknowledge: async () => { acknowledgeCallCount++; return { data: {} }; }
      }
    }
  }));
  t.mock.module('../lib/supabaseAdmin.js', {
    namedExports: { getSupabaseAdmin: () => ({ from: () => ({ upsert: async () => { upsertCalled = true; return { error: null }; } }) }) }
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { userId: VALID_UID, productId: 'catchfish_single', purchaseToken: 'tok_onetime', planType: 'onetime' } }, res);

  assert.equal(res.statusCode, 402);
  assert.equal(res.body.success, false);
  assert.equal(acknowledgeCallCount, 0);
  assert.equal(upsertCalled, false);
});

test('degrades gracefully (generic 500, no crash, no raw error leaked) when GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is missing', async (t) => {
  stubGooglePlay(t, () => { throw new Error('Missing GOOGLE_PLAY_SERVICE_ACCOUNT_JSON environment variable'); });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.success, false);
  assert.doesNotMatch(res.body.error, /GOOGLE_PLAY_SERVICE_ACCOUNT_JSON/, 'must not leak internal env var details to the client');
});

test('degrades gracefully when Google rejects the token (e.g. product/subscription not found in Play Console yet)', async (t) => {
  stubGooglePlay(t, () => ({
    purchases: {
      subscriptionsv2: { get: async () => { throw new Error('Requested entity was not found.'); } }
    }
  }));

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.success, false);
});

// ════════════════════ Token-binding fix: one purchase, one identity ═════
// Covers the Pro-minting vulnerability from the security review: a single
// verified purchaseToken must not be usable to grant Pro to more than one
// distinct userId. See migration 0011_unique_play_purchase_token.sql for
// the database-level backstop this application-level check sits on top of.

test('legitimate case: the SAME userId re-verifying the SAME token succeeds (idempotent relaunch)', async (t) => {
  const rows = [{ id: VALID_UID, plan_status: 'active', play_purchase_token: 'tok_abc123' }];
  stubGooglePlay(t, () => ({
    purchases: { subscriptionsv2: { get: async () => ({ data: { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' } }) } }
  }));
  stubSupabase(t, rows);

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 200, 're-verifying your own already-redeemed token must still succeed');
  assert.equal(res.body.success, true);
  assert.equal(rows.length, 1, 'no new row is created');
  assert.equal(rows[0].plan_status, 'active');
});

test('legitimate case: re-verification succeeds even when the client sends the userId in a different letter case', async (t) => {
  const rows = [{ id: VALID_UID, plan_status: 'active', play_purchase_token: 'tok_abc123' }];
  stubGooglePlay(t, () => ({
    purchases: { subscriptionsv2: { get: async () => ({ data: { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' } }) } }
  }));
  stubSupabase(t, rows);

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, userId: VALID_UID.toUpperCase() } }, res);

  assert.equal(res.statusCode, 200, 'case difference alone must not be treated as a different user');
  assert.equal(res.body.success, true);
});

test('abuse case: a DIFFERENT userId submitting an already-redeemed token is blocked (409), no Pro granted', async (t) => {
  const ORIGINAL_OWNER = VALID_UID;
  const ATTACKER_ID = '22222222-2222-4222-8222-222222222222';
  const rows = [{ id: ORIGINAL_OWNER, plan_status: 'active', play_purchase_token: 'tok_abc123' }];
  stubGooglePlay(t, () => ({
    purchases: { subscriptionsv2: { get: async () => ({ data: { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' } }) } }
  }));
  stubSupabase(t, rows);

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { ...baseBody, userId: ATTACKER_ID } }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error, 'purchase_already_redeemed');

  // No new row was created for the attacker, and the original owner's row
  // is completely untouched.
  assert.equal(rows.length, 1, 'the attacker must not get a row granting them Pro');
  assert.equal(rows.find((r) => r.id === ORIGINAL_OWNER).plan_status, 'active');
  assert.ok(!rows.find((r) => r.id === ATTACKER_ID), 'the attacker id must not appear in the users table at all');
});

test('abuse case: repeated attempts with fresh userIds against the same token are each blocked, not just the first', async (t) => {
  const rows = [{ id: VALID_UID, plan_status: 'active', play_purchase_token: 'tok_abc123' }];
  stubGooglePlay(t, () => ({
    purchases: { subscriptionsv2: { get: async () => ({ data: { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' } }) } }
  }));
  stubSupabase(t, rows);

  const { default: handler } = await loadHandler();
  for (const attackerId of ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444']) {
    const res = mockRes();
    await handler({ method: 'POST', body: { ...baseBody, userId: attackerId } }, res);
    assert.equal(res.statusCode, 409, `attacker id ${attackerId} must be blocked`);
  }
  assert.equal(rows.length, 1, 'not one of the repeated attempts should have minted a new Pro identity');
});

test('race-condition backstop: a unique-violation (23505) surfaced by the upsert itself is treated the same as the pre-check catching it', async (t) => {
  // Simulates the narrow window between the SELECT lookup and the UPSERT
  // where a concurrent request for the same token, under a different
  // userId, could land -- the pre-check alone can't close this, only the
  // database's unique constraint can. This proves the upsert-side handling
  // (upsertError.code === '23505') independently of the pre-check branch.
  stubGooglePlay(t, () => ({
    purchases: { subscriptionsv2: { get: async () => ({ data: { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' } }) } }
  }));
  t.mock.module('../lib/supabaseAdmin.js', {
    namedExports: {
      getSupabaseAdmin: () => ({
        from: () => ({
          select: () => ({ eq: () => ({ async maybeSingle() { return { data: null, error: null }; } }) }),
          async upsert() {
            return { error: { code: '23505', message: 'duplicate key value violates unique constraint "users_play_purchase_token_key"' } };
          }
        })
      })
    }
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'purchase_already_redeemed');
});

test('the redemption lookup failing is a clean 500, not a crash, and never reaches the upsert', async (t) => {
  let upsertCalled = false;
  stubGooglePlay(t, () => ({
    purchases: { subscriptionsv2: { get: async () => ({ data: { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' } }) } }
  }));
  t.mock.module('../lib/supabaseAdmin.js', {
    namedExports: {
      getSupabaseAdmin: () => ({
        from: () => ({
          select: () => ({ eq: () => ({ async maybeSingle() { return { data: null, error: { message: 'connection reset' } }; } }) }),
          async upsert() { upsertCalled = true; return { error: null }; }
        })
      })
    }
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: baseBody }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.success, false);
  assert.equal(upsertCalled, false);
});

test('rejects non-POST methods', async (t) => {
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'GET', body: baseBody }, res);
  assert.equal(res.statusCode, 405);
});
