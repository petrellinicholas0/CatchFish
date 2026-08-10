import { getStripe } from '../lib/stripeAdmin.js';
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';

const PRICE_IDS = {
  monthly: 'price_1TzMqVPJRgYrBGoz6zGWYRH1',
  annual: 'price_1TzMtHPJRgYrBGoz45yV4QbQ',
  single: 'price_1TzMu4PJRgYrBGozYQ5XgKTs'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { plan, userId, email } = req.body || {};
    const priceId = PRICE_IDS[plan];
    const validEmail = typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

    if (!priceId || !userId || !validEmail) {
      return res.status(400).json({ error: 'Missing or invalid plan, userId, or email' });
    }

    const supabase = getSupabaseAdmin();
    const { error: upsertError } = await supabase
      .from('users')
      .upsert({ id: userId, email }, { onConflict: 'email' });

    if (upsertError) {
      console.error('Supabase upsert into users failed:', upsertError.message);
      return res.status(500).json({ error: 'Failed to prepare user record' });
    }

    const stripe = getStripe();
    const mode = plan === 'single' ? 'payment' : 'subscription';
    // Never derive this from the request (Origin/Host headers are
    // attacker-controlled on a direct API call, not just browser-sent) —
    // Stripe will redirect here after a real payment, so an attacker-chosen
    // value would hand them the completed checkout session straight from
    // Stripe's own redirect. Only trust values set in the deployment
    // environment itself.
    const origin = process.env.APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://catch-fish-two.vercel.app');

    const sessionParams = {
      mode,
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      client_reference_id: userId,
      metadata: { userId, plan },
      success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?checkout=cancel`,
      allow_promotion_codes: true
    };

    if (mode === 'subscription') {
      sessionParams.subscription_data = { metadata: { userId, plan } };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('checkout.js error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
}
