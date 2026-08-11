import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';

const ALLOWED_TOOLS = new Set(['profile_analyzer', 'email_check', 'paper_check']);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { tool, userId, reason, note, resultSummary } = req.body || {};

    if (typeof tool !== 'string' || !ALLOWED_TOOLS.has(tool)) {
      return res.status(400).json({ error: 'Missing or invalid tool' });
    }
    if (typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({ error: 'Missing or invalid reason' });
    }

    const supabase = getSupabaseAdmin();
    const { error: insertError } = await supabase.from('content_reports').insert({
      tool,
      user_id: typeof userId === 'string' ? userId : null,
      reason,
      note: typeof note === 'string' ? note : null,
      result_summary: typeof resultSummary === 'string' ? resultSummary : null
    });

    if (insertError) {
      console.error('Supabase insert into content_reports failed:', insertError.message);
      return res.status(500).json({ error: 'Failed to submit report' });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('report-content.js error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
}
