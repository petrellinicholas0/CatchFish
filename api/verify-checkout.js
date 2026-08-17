import { getStripe } from '../lib/stripeAdmin.js';

// Server-side confirmation that a Stripe Checkout session actually completed
// payment, before the client is allowed to mark itself as Pro. Without this,
// the frontend's success redirect handler had no way to tell a real payment
// apart from someone simply visiting "/?checkout=success" — this endpoint is
// the source of truth Stripe itself confirms, not a client-supplied flag.
//
// Also returns which `plan` the session was for (from Stripe's own
// metadata, not anything client-supplied). This used to be omitted
// because the client's success handler unconditionally set cf_pro=true
// for ANY verified session — which was already silently wrong for the
// existing 'single' one-time purchase (a $0.99 buyer's browser would
// locally display "Pro Plan / Unlimited analyses", even though the
// server-side entitlement correctly never grants plan_status:'active'
// for it). Surfacing `plan` here lets the client branch correctly:
// monthly/annual actually grant Pro; single/credits5/credits15 do not.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { sessionId } = req.body || {};
  if (typeof sessionId !== 'string' || !sessionId) {
    return res.status(400).json({ error: 'Missing sessionId' });
  }

  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const verified = session.status === 'complete' && session.payment_status !== 'unpaid';
    const plan = typeof session.metadata?.plan === 'string' ? session.metadata.plan : null;
    return res.status(200).json({ verified, plan });
  } catch (err) {
    console.error('verify-checkout.js error:', err);
    return res.status(200).json({ verified: false, plan: null });
  }
}
