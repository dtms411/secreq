'use client';

import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

// RLS grants nothing to `anon`, so the whole UI is behind a sign-in. Magic-link
// (OTP) email keeps credentials out of the app entirely. The set of people who
// can sign in IS the investigation access list, provisioned in Supabase Auth.
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready) return <p style={{ padding: 24 }}>Loading…</p>;

  if (!session) {
    return (
      <div style={{ maxWidth: 360, margin: '10vh auto', padding: 24 }}>
        <h1 style={{ fontSize: 18 }}>deposit-recon</h1>
        <p style={{ color: '#6b7280', fontSize: 14 }}>Investigation access only. Enter your email for a sign-in link.</p>
        {sent ? (
          <p style={{ color: '#166534' }}>Check your email for the link.</p>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await supabase.auth.signInWithOtp({ email });
              setSent(true);
            }}
          >
            <input
              type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@firm.com"
              style={{ width: '100%', padding: 8, border: '1px solid #d1d5db', borderRadius: 6 }}
            />
            <button type="submit" style={{ marginTop: 8, padding: '8px 12px', borderRadius: 6, background: '#111827', color: 'white', border: 0 }}>
              Send link
            </button>
          </form>
        )}
      </div>
    );
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 16px', fontSize: 12, color: '#6b7280' }}>
        {session.user.email}
        <button onClick={() => supabase.auth.signOut()} style={{ marginLeft: 12, color: '#2563eb', background: 'none', border: 0, cursor: 'pointer' }}>
          sign out
        </button>
      </div>
      {children}
    </>
  );
}
