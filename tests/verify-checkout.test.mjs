// Run with: node --experimental-test-module-mocks --test tests/*.test.mjs
// (also wired up as `npm test`)
//
// Covers api/verify-checkout.js. No dedicated test file existed for this
// handler before this change, so this locks in the pre-existing
// verified/unverified logic byte-for-byte AND covers the new `plan`
// field, added so the client's checkout-success handler can correctly
// distinguish a real subscription (monthly/annual, grants Pro) from a
// one-time purchase (single/credits5/credits15, must never grant Pro) --
// previously the client unconditionally marked ANY verified session as
// Pro, which was already silently wrong for 'single'.

import { test } from 'node:test';
import assert from 'node:assert/strict';

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function stubStripe(t, sessionOrImpl) {
  t.mock.module('../lib/stripeAdmin.js', {
    namedExports: {
      getStripe: () => ({
        checkout: {
          sessions: {
            retrieve: typeof sessionOrImpl === 'function' ? sessionOrImpl : async () => sessionOrImpl
          }
        }
      })
    }
  });
}

async function loadHandler() {
  return import(`../api/verify-checkout.js?t=${Date.now()}-${Math.random()}`);
}

test('rejects missing sessionId', async (t) => {
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: {} }, res);
  assert.equal(res.statusCode, 400);
});

test('a complete, paid session is verified:true, with its plan from metadata', async (t) => {
  stubStripe(t, { status: 'complete', payment_status: 'paid', metadata: { plan: 'monthly' } });
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { sessionId: 'cs_test_1' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { verified: true, plan: 'monthly' });
});

test('a one-time purchase session (single) is verified:true with plan:"single", not "monthly"/"annual"', async (t) => {
  stubStripe(t, { status: 'complete', payment_status: 'paid', metadata: { plan: 'single' } });
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { sessionId: 'cs_test_2' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { verified: true, plan: 'single' });
});

test('credits5 session verifies correctly and reports plan:"credits5"', async (t) => {
  stubStripe(t, { status: 'complete', payment_status: 'paid', metadata: { plan: 'credits5' } });
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { sessionId: 'cs_test_credits5' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { verified: true, plan: 'credits5' });
});

test('credits15 session verifies correctly and reports plan:"credits15"', async (t) => {
  stubStripe(t, { status: 'complete', payment_status: 'paid', metadata: { plan: 'credits15' } });
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { sessionId: 'cs_test_credits15' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { verified: true, plan: 'credits15' });
});

test('an incomplete session is verified:false', async (t) => {
  stubStripe(t, { status: 'open', payment_status: 'unpaid', metadata: { plan: 'monthly' } });
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { sessionId: 'cs_test_3' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verified, false);
});

test('a session with payment_status "unpaid" is verified:false even if status is "complete"', async (t) => {
  stubStripe(t, { status: 'complete', payment_status: 'unpaid', metadata: { plan: 'monthly' } });
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { sessionId: 'cs_test_4' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verified, false);
});

test('a session with no metadata.plan reports plan:null, not a crash', async (t) => {
  stubStripe(t, { status: 'complete', payment_status: 'paid', metadata: {} });
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { sessionId: 'cs_test_5' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { verified: true, plan: null });
});

test('a Stripe API error degrades to verified:false, plan:null -- a clean 200, never a crash or a leaked error', async (t) => {
  stubStripe(t, async () => { throw new Error('Stripe is down'); });
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'POST', body: { sessionId: 'cs_test_6' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { verified: false, plan: null });
});

test('rejects non-POST methods', async () => {
  const { default: handler } = await loadHandler();
  const res = mockRes();
  await handler({ method: 'GET', body: { sessionId: 'cs_test_7' } }, res);
  assert.equal(res.statusCode, 405);
});
