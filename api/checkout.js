import { getStripe } from '../lib/stripeAdmin.js';
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';

const PRICE_IDS = {
  monthly: 'price_1U06X1PJRgYrBGozCXwXcR7I',
  annual: 'price_1U06XePJRgYrBGozMJ8gpUpj',
  single: 'price_1U06YHPJRgYrBGozPu4PX5je'
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
    const { error: upsertError } = await supabase
      .from('users')
      .upsert({ id: userId, email }, { onConflict: 'email' });

    if (upsertError) {
      console.error('Supabase upsert into users failed:', upsertError.message);
      return res.status(500).json({ error: 'Failed to prepare user record' });
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
