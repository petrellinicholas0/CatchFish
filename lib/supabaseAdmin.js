import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://vojkxzrqguyhosmzwwjh.supabase.co';

let client;

export function getSupabaseAdmin() {
  if (!client) {
    const serviceKey = process.env.SUPABASE_SECRET_KEY;
    if (!serviceKey) {
      throw new Error('Missing SUPABASE_SECRET_KEY environment variable');
    }
    client = createClient(SUPABASE_URL, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  }
  return client;
}
