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

// Run a data-loading callback only after the auth session is hydrated, and again
// whenever the session changes (e.g. SIGNED_IN after a full page reload). Without
// this, a query can fire before the restored session's token is attached — it
// then runs as `anon`, RLS returns nothing, and the UI mistakes "not yet
// authenticated" for "no data" and shows the demo fallback. Returns an
// unsubscribe fn for the effect cleanup.
export function onAuthedLoad(run: () => void): () => void {
  supabase.auth.getSession().then(() => run(), () => run());
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    if (session) run();
  });
  return () => data.subscription.unsubscribe();
}
