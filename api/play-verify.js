import { getAndroidPublisher } from '../lib/googlePlayAdmin.js';
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';

const PACKAGE_NAME = 'com.catchfish.app';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KNOWN_PRODUCT_IDS = new Set(['catchfish_monthly', 'catchfish_annual', 'catchfish_single']);

// Subscription states where access should be granted. ACTIVE is the normal
// paid state; IN_GRACE_PERIOD means a renewal charge is still being
// retried but Google itself keeps access alive during that window, so we
// mirror that rather than revoking early.
const ACTIVE_SUBSCRIPTION_STATES = new Set(['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD']);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const { userId, productId, purchaseToken, planType } = req.body || {};

  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    return res.status(400).json({ success: false, error: 'Missing or invalid userId' });
  }
  if (typeof productId !== 'string' || !KNOWN_PRODUCT_IDS.has(productId)) {
    return res.status(400).json({ success: false, error: 'Missing or invalid productId' });
  }
  if (typeof purchaseToken !== 'string' || !purchaseToken) {
    return res.status(400).json({ success: false, error: 'Missing purchaseToken' });
  }
  if (planType !== 'subscription' && planType !== 'onetime') {
    return res.status(400).json({ success: false, error: 'Missing or invalid planType' });
  }

  try {
    const androidpublisher = getAndroidPublisher();
    let verified = false;

    if (planType === 'subscription') {
      // purchases.subscriptions.get (v1) no longer exists in the current
      // androidpublisher client — subscription verification now lives at
      // subscriptionsv2.get, keyed by token alone (no subscriptionId
      // parameter), returning a subscriptionState enum rather than the
      // old numeric paymentState.
      const { data } = await androidpublisher.purchases.subscriptionsv2.get({
        packageName: PACKAGE_NAME,
        token: purchaseToken
      });
      verified = ACTIVE_SUBSCRIPTION_STATES.has(data.subscriptionState);
    } else {
      const { data } = await androidpublisher.purchases.products.get({
        packageName: PACKAGE_NAME,
        productId,
        token: purchaseToken
      });
      verified = data.purchaseState === 0;

      // Only acknowledge if it isn't already (acknowledgementState 0 =
      // not yet acknowledged). Acknowledging an already-acknowledged
      // purchase is rejected by Google's API, which would otherwise turn
      // a harmless retry of this endpoint (e.g. after a network blip)
      // into a false failure for an already-valid purchase.
      if (verified && data.acknowledgementState === 0) {
        await androidpublisher.purchases.products.acknowledge({
          packageName: PACKAGE_NAME,
          productId,
          token: purchaseToken,
          requestBody: {}
        });
      }
    }

    if (!verified) {
      return res.status(402).json({ success: false, error: 'Purchase could not be verified' });
    }

    const supabase = getSupabaseAdmin();
    const { error: upsertError } = await supabase
      .from('users')
      .upsert({ id: userId, plan_status: 'active', play_purchase_token: purchaseToken }, { onConflict: 'id' });

    if (upsertError) {
      console.error('Supabase upsert after Play purchase verification failed:', upsertError.message);
      return res.status(500).json({ success: false, error: 'Server error. Please try again.' });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('play-verify.js error:', err);
    return res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  }
}
