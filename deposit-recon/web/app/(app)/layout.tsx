import { Nav } from '@/lib/Nav';
import { AuthGate } from '@/lib/auth';
import { AccountMenu } from '@/lib/AccountMenu';

// The authenticated application frame: graphite rail + content, gated by
// AuthGate. Public pages (splash, login) live outside this group and never see
// the sidebar.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <div className="shell">
        <aside className="sidebar">
          <a href="/dashboard" className="brand">
            <span className="brand-mark" aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
                <rect width="26" height="26" rx="7" fill="#0F6E56" />
                <path d="M8 10h10M8 16h10" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </span>
            <span className="brand-text">
              SecReq
              <small>Security Deposit Reconciliation</small>
            </span>
          </a>
          <Nav />
          <AccountMenu />
        </aside>
        <div className="content">{children}</div>
      </div>
    </AuthGate>
  );
}
