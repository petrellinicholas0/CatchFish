import { createClient } from '@supabase/supabase-js';

let client;

export function getSupabaseAdmin() {
  if (!client) {
    const supabaseUrl = process.env.APP_SUPABASE_URL;
    const serviceKey = process.env.APP_SUPABASE_SECRET_KEY;
    if (!supabaseUrl) {
      throw new Error('Missing APP_SUPABASE_URL environment variable');
    }
    if (!serviceKey) {
      throw new Error('Missing APP_SUPABASE_SECRET_KEY environment variable');
    }
    client = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  }
  return client;
}
