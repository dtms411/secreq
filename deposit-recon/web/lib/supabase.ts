import { createClient } from '@supabase/supabase-js';

// Browser client, anon key only. Every query runs as `anon` until a user signs
// in, then as `authenticated`; RLS (migration 0003) does the rest. The service
// key is never present in this app.
// Placeholders keep createClient from throwing at import time when the env vars
// are not yet set (e.g. a first deploy before the Supabase project exists). The
// app renders; sign-in and queries simply fail against the placeholder host
// until the real NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY are configured in Vercel.
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key',
  { auth: { persistSession: true, autoRefreshToken: true } },
);
