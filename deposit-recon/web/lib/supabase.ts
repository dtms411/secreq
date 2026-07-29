import { createClient } from '@supabase/supabase-js';

// Browser client, anon key only. Every query runs as `anon` until a user signs
// in, then as `authenticated`; RLS (migration 0003) does the rest. The service
// key is never present in this app.
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  { auth: { persistSession: true, autoRefreshToken: true } },
);
