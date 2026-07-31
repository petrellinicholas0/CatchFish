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
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }

  try {
    const supabase = getSupabaseAdmin();

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.client_reference_id || session.metadata?.userId;

        if (userId) {
          await supabase
            .from('users')
            .update({
              plan_status: 'active',
              stripe_customer_id: session.customer
            })
            .eq('id', userId);
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

      default:
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
