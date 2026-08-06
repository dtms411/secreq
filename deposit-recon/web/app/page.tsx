'use client';

import { useRouter } from 'next/navigation';
import { enterDemo } from '@/lib/auth';

// Public splash + how-it-works. Two ways in: sign in (the investigation access
// list) or explore the synthetic demo. No real data is shown without a session.

const STEPS = [
  { n: 1, t: 'Upload the source documents', d: 'Drag bank statements, rent rolls, and your custody tracker export into the private evidence bucket. Nothing is trusted until it clears the checksum gate.' },
  { n: 2, t: 'Build three independent records', d: 'What the bank says, what your books say, and what the leases independently say should be there. Their independence is what makes the tie-out mean something.' },
  { n: 3, t: 'Track each deposit’s custody', d: 'Every tenant deposit through its whole life — received, pooled in the Santander Master, moved to the tenant’s subaccount, returned, refunded, closed.' },
  { n: 4, t: 'Reconcile & compare', d: 'Bank vs. accounting per tenant, escrow held vs. the lease universe per building, and the Master-account aging — variances surfaced, not buried.' },
  { n: 5, t: 'Triage what’s wrong', d: 'Eighteen detectors raise findings into one queue, and the 14-day statutory refund clock runs daily so a deadline is never missed.' },
];

export default function Splash() {
  const router = useRouter();
  function demo() { enterDemo(); router.push('/dashboard'); }

  return (
    <div className="splash">
      <header className="splash-top">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="30" height="30" viewBox="0 0 26 26" fill="none">
              <rect width="26" height="26" rx="7" fill="#0F6E56" />
              <path d="M8 10h10M8 16h10" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </span>
          <span className="brand-text splash-brand">SecReq<small>Security Deposit Reconciliation</small></span>
        </div>
        <a className="btn" href="/login">Sign in</a>
      </header>

      <section className="hero">
        <div className="hero-kicker">Forensic reconciliation · under counsel</div>
        <h1 className="hero-title">Every tenant security deposit,<br />tied out to the cent.</h1>
        <p className="hero-lede">
          SecReq reconciles what the <strong>bank</strong> holds against what your <strong>books</strong> say and
          what the <strong>leases</strong> independently require — deposit by deposit, building by building, across
          years of statements. Money that was collected and never banked, refunded to the wrong payee, or left
          pooled in the Master account has nowhere to hide.
        </p>
        <div className="hero-cta">
          <a className="btn btn-primary btn-lg" href="/login">Sign in</a>
          <button className="btn btn-lg" onClick={demo}>Explore the demo →</button>
        </div>
        <div className="hero-note">The demo shows synthetic data only. Real reconciliation data requires a sign-in on the investigation access list.</div>
      </section>

      <section className="how">
        <div className="how-head">How it works</div>
        <div className="steps">
          {STEPS.map((s) => (
            <div className="step" key={s.n}>
              <div className="step-n">{s.n}</div>
              <div>
                <div className="step-t">{s.t}</div>
                <div className="step-d">{s.d}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="principles">
        <div className="principle"><div className="principle-t">Integer cents, always</div><div className="principle-d">No floating-point money anywhere in the pipeline — every figure is exact.</div></div>
        <div className="principle"><div className="principle-t">Nothing enters unbalanced</div><div className="principle-d">Opening + transactions must equal closing to the cent, or the statement is quarantined.</div></div>
        <div className="principle"><div className="principle-t">Full provenance</div><div className="principle-d">Every number traces to a document, page, and line — and every edit is audit-logged.</div></div>
        <div className="principle"><div className="principle-t">The model proposes, a human posts</div><div className="principle-d">Automated matches and suggestions are proposals; only a person commits them.</div></div>
      </section>

      <footer className="splash-foot">
        SecReq · Trust-fund reconciliation under counsel · GOL §7-103 / §7-107 / §7-108
      </footer>
    </div>
  );
}
