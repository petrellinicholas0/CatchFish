// Run with: node --experimental-test-module-mocks --test tests/*.test.mjs
// (also wired up as `npm test`)
//
// Covers two fixes in api/webhook.js:
//
// 1. A revenue leak: checkout.session.completed used to set plan_status:
//    'active' for ANY completed session, including the $0.99 'single'
//    plan (Stripe mode: 'payment', one-time, so there's no subscription
//    object and customer.subscription.deleted never fires to revoke it
//    later) — turning a $0.99 purchase into a permanent, unlimited Pro
//    subscription. The fix branches on session.metadata.plan: monthly/
//    annual keep the existing behavior, single grants exactly one credit
//    via the atomic grant_single_purchase_credit RPC and never touches
//    plan_status, and an unrecognized/missing plan does nothing
//    destructive.
//
// 2. A billing-lag gap: customer.subscription.updated wasn't handled at
//    all, so a subscriber with a failing card kept full active access
//    until Stripe's dunning process exhausted retries and eventually
//    fired customer.subscription.deleted, which can take a substantial
//    amount of time. The fix downgrades plan_status to 'free' on
//    'past_due'/'unpaid'/'canceled', using the same stripe_customer_id
//    lookup as the existing subscription.deleted handler, while leaving
//    'active'/'trialing' untouched.
//
// Every mock is registered via the per-test `t.mock` tracker so it's
// always restored, pass or fail. req/res are minimal stand-ins; the
// handler only touches req.method, req.headers, and Node's Readable
// interface (for the raw-body buffer() helper) on req, and
// status()/json() on res.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

function mockReq(event) {
  const req = Readable.from([Buffer.from(JSON.stringify(event))]);
  req.method = 'POST';
  req.headers = { 'stripe-signature': 'sig_test' };
  return req;
}

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function stubStripe(t, event) {
  t.mock.module('../lib/stripeAdmin.js', {
    namedExports: {
      getStripe: () => ({
        webhooks: { constructEvent: () => event }
      })
    }
  });
}

function stubSupabase(t, { update, rpc } = {}) {
  t.mock.module('../lib/supabaseAdmin.js', {
    namedExports: {
      getSupabaseAdmin: () => ({
        from: (table) => ({
          update: (data) => ({
            eq: async (col, val) => {
              if (update) update(table, data, col, val);
              return { error: null };
            }
          })
        }),
        rpc: async (fn, args) => {
          if (rpc) rpc(fn, args);
          return { error: null };
        }
      })
    }
  });
}

async function loadHandler() {
  return import(`../api/webhook.js?t=${Date.now()}-${Math.random()}`);
}

const USER_ID = '11111111-1111-4111-8111-111111111111';

function checkoutCompletedEvent(overrides = {}) {
  return {
    type: 'checkout.session.completed',
    data: {
      object: {
        client_reference_id: USER_ID,
        customer: 'cus_test123',
        metadata: { userId: USER_ID, plan: 'monthly' },
        ...overrides
      }
    }
  };
}

const withEnv = (t) => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
};

test('monthly plan: sets plan_status active + stripe_customer_id, never calls the credit RPC', async (t) => {
  withEnv(t);
  const updateCalls = [];
  const rpcCalls = [];
  stubStripe(t, checkoutCompletedEvent({ metadata: { userId: USER_ID, plan: 'monthly' } }));
  stubSupabase(t, {
    update: (table, data, col, val) => updateCalls.push({ table, data, col, val }),
    rpc: (fn, args) => rpcCalls.push({ fn, args })
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler(mockReq({}), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].table, 'users');
  assert.equal(updateCalls[0].data.plan_status, 'active');
  assert.equal(updateCalls[0].data.stripe_customer_id, 'cus_test123');
  assert.equal(updateCalls[0].col, 'id');
  assert.equal(updateCalls[0].val, USER_ID);
  assert.equal(rpcCalls.length, 0, 'monthly must never touch the credit RPC');
});

test('annual plan: same active-status behavior as monthly', async (t) => {
  withEnv(t);
  const updateCalls = [];
  stubStripe(t, checkoutCompletedEvent({ metadata: { userId: USER_ID, plan: 'annual' } }));
  stubSupabase(t, { update: (table, data, col, val) => updateCalls.push({ table, data, col, val }) });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler(mockReq({}), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].data.plan_status, 'active');
});

test('single plan: grants exactly one credit via RPC, never sets plan_status', async (t) => {
  withEnv(t);
  const updateCalls = [];
  const rpcCalls = [];
  stubStripe(t, checkoutCompletedEvent({ metadata: { userId: USER_ID, plan: 'single' } }));
  stubSupabase(t, {
    update: (table, data, col, val) => updateCalls.push({ table, data, col, val }),
    rpc: (fn, args) => rpcCalls.push({ fn, args })
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler(mockReq({}), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalls.length, 0, 'single-purchase must never write plan_status directly');
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].fn, 'grant_single_purchase_credit');
  assert.equal(rpcCalls[0].args.p_user_id, USER_ID);
  assert.equal(rpcCalls[0].args.p_stripe_customer_id, 'cus_test123');
});

test('single plan: an RPC error is logged but still returns 200 to Stripe (avoids pointless retries on a data problem)', async (t) => {
  withEnv(t);
  stubStripe(t, checkoutCompletedEvent({ metadata: { userId: USER_ID, plan: 'single' } }));
  t.mock.module('../lib/supabaseAdmin.js', {
    namedExports: {
      getSupabaseAdmin: () => ({
        from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }),
        rpc: async () => ({ error: { message: 'boom' } })
      })
    }
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler(mockReq({}), res);

  assert.equal(res.statusCode, 200);
});

test('unrecognized plan value: no update, no RPC — does not default to granting active status', async (t) => {
  withEnv(t);
  const updateCalls = [];
  const rpcCalls = [];
  stubStripe(t, checkoutCompletedEvent({ metadata: { userId: USER_ID, plan: 'lifetime-deal' } }));
  stubSupabase(t, {
    update: (table, data, col, val) => updateCalls.push({ table, data, col, val }),
    rpc: (fn, args) => rpcCalls.push({ fn, args })
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler(mockReq({}), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalls.length, 0);
  assert.equal(rpcCalls.length, 0);
});

test('missing plan metadata entirely: no update, no RPC', async (t) => {
  withEnv(t);
  const updateCalls = [];
  const rpcCalls = [];
  stubStripe(t, checkoutCompletedEvent({ metadata: { userId: USER_ID } }));
  stubSupabase(t, {
    update: (table, data, col, val) => updateCalls.push({ table, data, col, val }),
    rpc: (fn, args) => rpcCalls.push({ fn, args })
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler(mockReq({}), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalls.length, 0);
  assert.equal(rpcCalls.length, 0);
});

test('missing userId entirely: no update, no RPC (unchanged prior behavior)', async (t) => {
  withEnv(t);
  const updateCalls = [];
  const rpcCalls = [];
  stubStripe(t, checkoutCompletedEvent({ client_reference_id: undefined, metadata: { plan: 'single' } }));
  stubSupabase(t, {
    update: (table, data, col, val) => updateCalls.push({ table, data, col, val }),
    rpc: (fn, args) => rpcCalls.push({ fn, args })
  });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler(mockReq({}), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalls.length, 0);
  assert.equal(rpcCalls.length, 0);
});

test('customer.subscription.deleted still sets plan_status back to free (unchanged)', async (t) => {
  withEnv(t);
  const updateCalls = [];
  stubStripe(t, {
    type: 'customer.subscription.deleted',
    data: { object: { customer: 'cus_test123' } }
  });
  stubSupabase(t, { update: (table, data, col, val) => updateCalls.push({ table, data, col, val }) });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler(mockReq({}), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].data.plan_status, 'free');
  assert.equal(updateCalls[0].col, 'stripe_customer_id');
  assert.equal(updateCalls[0].val, 'cus_test123');
});

// ════════════════════ customer.subscription.updated ═══════════════════
// Covers the fix for a second gap: a subscriber with a failing card kept
// full active access until Stripe's dunning process exhausted retries and
// eventually fired customer.subscription.deleted — which per Stripe's
// default retry schedule can take a substantial amount of time. This adds
// handling for customer.subscription.updated so a 'past_due'/'unpaid'/
// 'canceled' status downgrades plan_status immediately, using the same
// stripe_customer_id lookup pattern as the existing subscription.deleted
// handler, while 'active'/'trialing' (normal renewals, or the event
// firing for unrelated reasons like a metadata change) are left alone.

function subscriptionUpdatedEvent(status) {
  return {
    type: 'customer.subscription.updated',
    data: { object: { customer: 'cus_test123', status } }
  };
}

test('subscription.updated: past_due downgrades plan_status to free', async (t) => {
  withEnv(t);
  const updateCalls = [];
  stubStripe(t, subscriptionUpdatedEvent('past_due'));
  stubSupabase(t, { update: (table, data, col, val) => updateCalls.push({ table, data, col, val }) });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler(mockReq({}), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].table, 'users');
  assert.equal(updateCalls[0].data.plan_status, 'free');
  assert.equal(updateCalls[0].col, 'stripe_customer_id');
  assert.equal(updateCalls[0].val, 'cus_test123');
});

test('subscription.updated: unpaid downgrades plan_status to free', async (t) => {
  withEnv(t);
  const updateCalls = [];
  stubStripe(t, subscriptionUpdatedEvent('unpaid'));
  stubSupabase(t, { update: (table, data, col, val) => updateCalls.push({ table, data, col, val }) });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler(mockReq({}), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].data.plan_status, 'free');
});

test('subscription.updated: canceled downgrades plan_status to free (safety net alongside subscription.deleted)', async (t) => {
  withEnv(t);
  const updateCalls = [];
  stubStripe(t, subscriptionUpdatedEvent('canceled'));
  stubSupabase(t, { update: (table, data, col, val) => updateCalls.push({ table, data, col, val }) });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler(mockReq({}), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].data.plan_status, 'free');
});

test('subscription.updated: active does NOT change plan_status (negative control)', async (t) => {
  withEnv(t);
  const updateCalls = [];
  stubStripe(t, subscriptionUpdatedEvent('active'));
  stubSupabase(t, { update: (table, data, col, val) => updateCalls.push({ table, data, col, val }) });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler(mockReq({}), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalls.length, 0, 'active status must never trigger a write');
});

test('subscription.updated: trialing does NOT change plan_status', async (t) => {
  withEnv(t);
  const updateCalls = [];
  stubStripe(t, subscriptionUpdatedEvent('trialing'));
  stubSupabase(t, { update: (table, data, col, val) => updateCalls.push({ table, data, col, val }) });

  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler(mockReq({}), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalls.length, 0);
});

test('rejects non-POST methods', async (t) => {
  withEnv(t);
  const { default: handler } = await loadHandler();
  const res = mockRes();
  const req = mockReq({});
  req.method = 'GET';
  await handler(req, res);
  assert.equal(res.statusCode, 405);
});

test('missing signature header is rejected before Stripe/Supabase are ever touched', async (t) => {
  withEnv(t);
  const { default: handler } = await loadHandler();
  const res = mockRes();
  const req = mockReq({});
  delete req.headers['stripe-signature'];
  await handler(req, res);
  assert.equal(res.statusCode, 400);
});
