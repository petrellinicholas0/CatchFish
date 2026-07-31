import Stripe from 'stripe';

let client;

export function getStripe() {
  if (!client) {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new Error('Missing STRIPE_SECRET_KEY environment variable');
    }
    client = new Stripe(secretKey);
  }
  return client;
}
