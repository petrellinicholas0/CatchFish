import { getStripe } from '../lib/stripeAdmin.js';

// Server-side confirmation that a Stripe Checkout session actually completed
// payment, before the client is allowed to mark itself as Pro. Without this,
// the frontend's success redirect handler had no way to tell a real payment
// apart from someone simply visiting "/?checkout=success" — this endpoint is
// the source of truth Stripe itself confirms, not a client-supplied flag.
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
    return res.status(200).json({ verified });
  } catch (err) {
    console.error('verify-checkout.js error:', err);
    return res.status(200).json({ verified: false });
  }
}
