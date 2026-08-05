import './globals.css';
import { Manrope, Inter } from 'next/font/google';
import { Nav } from '@/lib/Nav';

// All sans-serif: Manrope for display (headings, figures, brand), Inter for the
// dense UI + tabular data. Self-hosted by next/font — no runtime Google request.
const display = Manrope({ subsets: ['latin'], weight: ['500', '600', '700', '800'], display: 'swap', variable: '--font-display' });
const ui = Inter({ subsets: ['latin'], weight: ['400', '500', '600'], display: 'swap', variable: '--font-ui' });

// NOTE: sign-in gate temporarily removed — the app renders straight to the
// dashboard. Re-enable later by wrapping {children} in <AuthGate>.
export const metadata = { title: 'SecReq — Security Deposit Reconciliation', description: 'Forensic reconciliation of tenant security deposit escrow' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${ui.variable}`}>
      <body>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">
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
            </div>
            <Nav />
            <div className="side-foot">
              Trust-fund reconciliation<br />under counsel · GOL §7-103/107/108
            </div>
          </aside>
          <div className="content">{children}</div>
        </div>
      </body>
    </html>
  );
}
