import './globals.css';
import { AuthGate } from '@/lib/AuthGate';

export const metadata = { title: 'deposit-recon', description: 'Security deposit escrow reconciliation' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthGate>
          <nav style={{ padding: '12px 24px', borderBottom: '1px solid #e5e7eb' }}>
            <strong style={{ marginRight: 24 }}>deposit-recon</strong>
            <a href="/">Tie-out</a>
            <a href="/quarantine">Quarantine</a>
            <a href="/matches">Matches</a>
            <a href="/exceptions">Exceptions</a>
            <a href="/upload">Upload</a>
          </nav>
          <main>{children}</main>
        </AuthGate>
      </body>
    </html>
  );
}
