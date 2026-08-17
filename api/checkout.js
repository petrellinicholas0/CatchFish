import { getStripe } from '../lib/stripeAdmin.js';
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';

const PRICE_IDS = {
  monthly: 'price_1TzMqVPJRgYrBGoz6zGWYRH1',
  annual: 'price_1U3MV1PJRgYrBGozO4ordIz6',
  single: 'price_1TzMu4PJRgYrBGozYQ5XgKTs',
  // Universal, non-expiring credits usable on any tool (Profile Analyzer,
  // Email Check, or Paper Check) -- see supabase/migrations/
  // 0010_add_universal_credit_packs.sql and api/webhook.js's
  // checkout.session.completed handler for how these are granted.
  credits5: 'price_1U5HlzPJRgYrBGozhHAkVeZw',
  credits15: 'price_1U5Hm2PJRgYrBGozOH7KVurJ'
};

// One-time Stripe Checkout purchases (mode: 'payment') -- everything else
// is a recurring subscription (mode: 'subscription'). Keeping this as an
// explicit set (rather than a single `=== 'single'` check) is what lets
// the two new credit packs share the exact same one-time-payment branch
// below without touching the subscription path at all.
const ONE_TIME_PLANS = new Set(['single', 'credits5', 'credits15']);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { plan, userId, email } = req.body || {};
    // PRICE_IDS is a plain object literal, which inherits from
    // Object.prototype — a plan value like '__proto__', 'constructor', or
    // 'toString' would resolve via normal JS property lookup to a truthy
    // inherited value (Object.prototype itself, or a built-in function),
    // bypassing the `!priceId` guard below despite never being a real
    // plan. Object.hasOwn() only matches an actual own property.
    const priceId = typeof plan === 'string' && Object.hasOwn(PRICE_IDS, plan) ? PRICE_IDS[plan] : undefined;
    const validEmail = typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

    if (!priceId || !userId || !validEmail) {
      return res.status(400).json({ error: 'Missing or invalid plan, userId, or email' });
    }

    const supabase = getSupabaseAdmin();
    // Conflict target must be `id`, never `email`. Upserting on email
    // while writing a client-supplied `id` let anyone who knew an existing
    // user's email address hijack that user's row — the conflict-by-email
    // resolution would silently rewrite the row's primary key to whatever
    // id the caller sent, inheriting that row's plan_status (including an
    // already-active paid subscription) for free and orphaning the real
    // owner's entitlement. Keying on `id` means the same email used from a
    // different device creates a separate row instead of merging into an
    // existing one — the correct, safe behavior until real accounts exist.
    const { error: upsertError } = await supabase
      .from('users')
      .upsert({ id: userId, email }, { onConflict: 'id' });

    if (upsertError) {
      console.error('Supabase upsert into users failed:', upsertError.message);
      return res.status(500).json({ error: 'Failed to prepare user record' });
    }

    const stripe = getStripe();
    const mode = ONE_TIME_PLANS.has(plan) ? 'payment' : 'subscription';
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
