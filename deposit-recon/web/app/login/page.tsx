'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { enterDemo } from '@/lib/auth';

// Sign-in for the investigation access list. Accounts are provisioned in
// Supabase Auth (invite-only) — there is no public sign-up. Email + password;
// on success we land on the dashboard.
export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) { setErr(error.message); setBusy(false); return; }
      router.push('/dashboard');
    } catch {
      setErr('Could not reach the authentication service. Check the connection, or explore the demo.');
      setBusy(false);
    }
  }

  function demo() { enterDemo(); router.push('/dashboard'); }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <a href="/" className="brand auth-brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
              <rect width="26" height="26" rx="7" fill="#0F6E56" />
              <path d="M8 10h10M8 16h10" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </span>
          <span className="brand-text">SecReq<small>Security Deposit Reconciliation</small></span>
        </a>

        <h1 className="auth-title">Sign in</h1>
        <p className="auth-sub">Access is limited to the investigation team. Accounts are provisioned by the administrator.</p>

        <form onSubmit={submit}>
          <div className="field" style={{ marginBottom: 12 }}>
            <label>Email</label>
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@firm.com" required />
          </div>
          <div className="field" style={{ marginBottom: 4 }}>
            <label>Password</label>
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {err && <div className="form-error" style={{ marginTop: 12 }}>{err}</div>}
          <button className="btn btn-primary btn-block" type="submit" disabled={busy} style={{ marginTop: 18 }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="auth-divider"><span>or</span></div>
        <button className="btn btn-block" onClick={demo}>Explore the demo instead</button>
        <div className="auth-foot">Under counsel · GOL §7-103 / §7-107 / §7-108</div>
      </div>
    </div>
  );
}
