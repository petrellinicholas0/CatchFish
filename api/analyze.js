import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';

// Mirrors the client-side constants in index.html — those still drive the
// UI, but this is the value that actually gets enforced now. Previously
// cf_usage/cf_pro were plain localStorage values with nothing checking them
// server-side, so anyone could flip cf_pro to true or just call this
// endpoint directly, unlimited times, with no accounting at all.
const FREE_LIMIT = 3;
const RESET_HOURS = 24;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { system, messages, userId } = req.body || {};

  if (typeof system !== 'string' || !system || !Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'Missing or invalid system/messages' });
  }

  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    return res.status(400).json({ error: 'Missing or invalid userId' });
  }

  // Generous sanity cap — well beyond any legitimate bio/email/paper
  // submission (a very long paper is tens of thousands of characters), but
  // bounds otherwise-unbounded input from driving up per-request cost.
  const MAX_REQUEST_CHARS = 300000;
  if (system.length + JSON.stringify(messages).length > MAX_REQUEST_CHARS) {
    return res.status(413).json({ error: 'Submission too large' });
  }

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.rpc('check_and_increment_usage', {
      p_user_id: userId,
      p_free_limit: FREE_LIMIT,
      p_reset_hours: RESET_HOURS
    });

    if (error) {
      console.error('usage check failed:', error.message);
      return res.status(500).json({ error: 'Server error. Please try again.' });
    }

    const usage = Array.isArray(data) ? data[0] : data;
    if (!usage || !usage.o_allowed) {
      return res.status(402).json({ error: 'Free usage limit reached', limitReached: true });
    }
  } catch (err) {
    console.error('usage check error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        system,
        messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic API error:', data.error || data);
      return res.status(response.status).json({ error: 'Analysis service error. Please try again.' });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('analyze.js error:', err);
    const message = err.name === 'AbortError' ? 'Analysis timed out. Please try again.' : 'Server error. Please try again.';
    return res.status(err.name === 'AbortError' ? 504 : 500).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
}
