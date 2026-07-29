import './globals.css';
import { Newsreader, IBM_Plex_Sans } from 'next/font/google';
import { Nav } from '@/lib/Nav';

// Editorial serif for display, a clean humanist sans for dense data. Loaded and
// self-hosted by next/font — no runtime request to Google.
const serif = Newsreader({ subsets: ['latin'], weight: ['400', '500', '600'], display: 'swap', variable: '--font-serif' });
const sans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], display: 'swap', variable: '--font-sans' });

// NOTE: sign-in gate temporarily removed — the app renders straight to the
// dashboard. Re-enable later by wrapping {children} in <AuthGate>.
export const metadata = { title: 'SecReq — Security Deposit Reconciliation', description: 'Forensic reconciliation of tenant security deposit escrow' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable}`}>
      <body>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">
              SecReq
              <small>Security Deposit Reconciliation</small>
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
