'use client';

import { useEffect, useState, createContext, useContext } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';

// Access model. The app is gated: you either have a real Supabase session (the
// investigation access list, provisioned in Supabase Auth) or you are in DEMO
// mode — an explicit "explore the demo" choice that shows only the synthetic
// data, never a real database. Demo mode is a client flag; it grants no
// database access because RLS still sees an anon request.

const DEMO_KEY = 'secreq:demo';

export function isDemo(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(DEMO_KEY) === '1';
}
export function enterDemo() { if (typeof window !== 'undefined') window.localStorage.setItem(DEMO_KEY, '1'); }
export function exitDemo() { if (typeof window !== 'undefined') window.localStorage.removeItem(DEMO_KEY); }

export interface SessionState { email: string | null; demo: boolean; loading: boolean; }
const Ctx = createContext<SessionState>({ email: null, demo: false, loading: true });
export const useSession = () => useContext(Ctx);

/** Wraps the authenticated app. Sends unauthenticated, non-demo visitors to the
 *  splash. While the session is resolving it renders nothing, so a protected
 *  screen never flashes before the check completes. */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<SessionState>({ email: null, demo: false, loading: true });

  useEffect(() => {
    let alive = true;
    const settle = (email: string | null) => {
      if (!alive) return;
      const demo = isDemo();
      setState({ email, demo, loading: false });
      if (!email && !demo) router.replace('/');
    };

    supabase.auth.getSession()
      .then(({ data }) => settle(data.session?.user?.email ?? null))
      .catch(() => settle(null));

    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => settle(s?.user?.email ?? null));
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, [router]);

  if (state.loading) {
    return <div className="auth-loading">Loading…</div>;
  }
  if (!state.email && !state.demo) return null; // redirecting to splash

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export async function signOut() {
  exitDemo();
  try { await supabase.auth.signOut(); } catch { /* demo / no backend */ }
}
