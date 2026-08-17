// Pure read, no gating, no RPC. Exists because api/analyze.js never
// surfaced the server's `credits` balance to the client (only an
// allow/deny decision) -- there was previously no way for index.html to
// know a user's current credit count at all, which the universal credit
// packs feature needs in order to display it in the usage strip (see
// supabase/migrations/0010_add_universal_credit_packs.sql). Called on
// page load, after a checkout-success purchase, and after each analysis
// while not Pro, so the displayed count stays accurate without ever
// trusting a client-side counter for anything that matters -- this is
// display only; check_and_increment_usage's server-side tier-3 check
// remains the sole source of enforcement.

import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId } = req.body || {};
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    return res.status(400).json({ error: 'Missing or invalid userId' });
  }

  try {
    const supabase = getSupabaseAdmin();
    // maybeSingle() so a userId with no row yet (never having reached
    // check_and_increment_usage or a purchase) resolves to a clean 0
    // rather than an error.
    const { data, error } = await supabase
      .from('users')
      .select('credits')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      console.error('user-status.js: lookup failed:', error.message);
      return res.status(500).json({ error: 'Server error. Please try again.' });
    }

    return res.status(200).json({ credits: data?.credits ?? 0 });
  } catch (err) {
    console.error('user-status.js error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
}
