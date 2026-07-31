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

    if (!priceId || !userId || !email) {
      return res.status(400).json({ error: 'Missing or invalid plan, userId, or email' });
    }

    const supabase = getSupabaseAdmin();
    const { data: existingUser, error: selectError } = await supabase
      .from('users')
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    if (selectError) {
      return res.status(500).json({ error: 'Failed to look up user record' });
    }

    if (!existingUser) {
      const { error: insertError } = await supabase
        .from('users')
        .insert({ id: userId, email });

      if (insertError) {
        return res.status(500).json({ error: 'Failed to create user record' });
      }
    }

    const stripe = getStripe();
    const mode = plan === 'single' ? 'payment' : 'subscription';
    const origin = req.headers.origin || `https://${req.headers.host}`;

    const sessionParams = {
      mode,
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      client_reference_id: userId,
      metadata: { userId, plan },
      success_url: `${origin}/?checkout=success`,
      cancel_url: `${origin}/?checkout=cancel`
    };

    if (mode === 'subscription') {
      sessionParams.subscription_data = { metadata: { userId, plan } };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
