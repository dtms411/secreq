'use client';

import { useRouter } from 'next/navigation';
import { useSession, signOut } from '@/lib/auth';

// Bottom-of-rail identity + sign out. Shows the signed-in investigator's email,
// or a clear DEMO badge when exploring the synthetic data.
export function AccountMenu() {
  const router = useRouter();
  const { email, demo } = useSession();

  async function out() {
    await signOut();
    router.replace('/');
  }

  return (
    <div className="account">
      <div className="account-who">
        {demo ? (
          <><span className="account-badge">DEMO</span><span className="account-mail">exploring sample data</span></>
        ) : (
          <><span className="account-dot" aria-hidden="true" /><span className="account-mail" title={email ?? ''}>{email ?? 'signed in'}</span></>
        )}
      </div>
      <button className="account-signout" onClick={out}>{demo ? 'Exit demo' : 'Sign out'}</button>
      <div className="side-foot">Trust-fund reconciliation<br />under counsel · GOL §7-103/107/108</div>
    </div>
  );
}
