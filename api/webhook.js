import { getStripe } from '../lib/stripeAdmin.js';
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';

export const config = {
  api: { bodyParser: false }
};

function buffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (chunk) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig = req.headers['stripe-signature'];

  if (!webhookSecret || !sig) {
    return res.status(400).json({ error: 'Missing webhook signature' });
  }

  let event;
  try {
    const stripe = getStripe();
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  try {
    const supabase = getSupabaseAdmin();

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.client_reference_id || session.metadata?.userId;
        const plan = session.metadata?.plan;

        if (!userId) {
          break;
        }

        if (plan === 'monthly' || plan === 'annual') {
          await supabase
            .from('users')
            .update({
              plan_status: 'active',
              stripe_customer_id: session.customer
            })
            .eq('id', userId);
        } else if (plan === 'single') {
          // 'single' is Stripe mode: 'payment' (one-time) — there's no
          // subscription object for it, so customer.subscription.deleted
          // never fires to revoke access later. Granting plan_status:
          // 'active' here would turn a $0.99 purchase into a permanent,
          // unlimited Pro subscription. Grant exactly one analysis credit
          // instead, atomically (see grant_single_purchase_credit), and
          // leave plan_status untouched — it stays 'free' unless the user
          // separately has an active subscription.
          const { error: creditError } = await supabase.rpc('grant_single_purchase_credit', {
            p_user_id: userId,
            p_stripe_customer_id: session.customer
          });
          if (creditError) {
            console.error('Failed to grant single-purchase credit:', creditError.message);
          }
        } else if (plan === 'credits5' || plan === 'credits15') {
          // Same one-time-purchase reasoning as 'single' immediately
          // above — mode: 'payment', no subscription object, so
          // plan_status must never change here. add_credits (see
          // supabase/migrations/0010_add_universal_credit_packs.sql) adds
          // to the SAME universal `credits` balance that
          // grant_single_purchase_credit and check_and_increment_usage's
          // tier-3 already use — these packs are not a separate credit
          // system, just a bigger grant of the same thing.
          const amount = plan === 'credits5' ? 5 : 15;
          const { error: creditError } = await supabase.rpc('add_credits', {
            p_user_id: userId,
            p_amount: amount,
            p_stripe_customer_id: session.customer
          });
          if (creditError) {
            console.error(`Failed to add ${amount} credits:`, creditError.message);
          }
        } else {
          // Unrecognized or missing plan on a completed session — do
          // nothing destructive rather than guessing (in particular,
          // never default to granting active status).
          console.warn(`checkout.session.completed: unrecognized or missing plan "${plan}" for user ${userId}; no entitlement change applied`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;

        await supabase
          .from('users')
          .update({ plan_status: 'free' })
          .eq('stripe_customer_id', subscription.customer);
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;

        // A failing card doesn't cancel a subscription outright — Stripe
        // moves it through 'past_due' (and eventually 'unpaid', depending
        // on the account's dunning settings) while it retries the charge,
        // and only fires customer.subscription.deleted once that retry
        // schedule is exhausted, which can be days to weeks later. Without
        // this, a user with a failing card keeps full active access for
        // that entire window. 'canceled' is handled here too as a safety
        // net alongside the dedicated subscription.deleted handler above,
        // in case that event is ever missed. Same lookup pattern as
        // subscription.deleted (by stripe_customer_id, not the metadata
        // userId) for consistency. 'active'/'trialing' (normal renewals,
        // or subscription.updated firing for unrelated reasons like a
        // metadata change) are deliberately left untouched — this handler
        // only ever downgrades, never grants access.
        if (subscription.status === 'past_due' || subscription.status === 'unpaid' || subscription.status === 'canceled') {
          await supabase
            .from('users')
            .update({ plan_status: 'free' })
            .eq('stripe_customer_id', subscription.customer);
        }
        break;
      }

      default:
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('webhook.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
