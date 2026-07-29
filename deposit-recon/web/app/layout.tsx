import './globals.css';

// NOTE: sign-in gate temporarily removed — the app renders straight to the
// dashboard. To re-enable auth later, wrap {children} back in <AuthGate> from
// '@/lib/AuthGate' (the component is still in the repo). This preview is not the
// live investigation surface.

export const metadata = { title: 'deposit-recon', description: 'Security deposit escrow reconciliation' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav style={{ padding: '12px 24px', borderBottom: '1px solid #e5e7eb' }}>
          <strong style={{ marginRight: 24 }}>deposit-recon</strong>
          <a href="/">Tie-out</a>
          <a href="/quarantine">Quarantine</a>
          <a href="/matches">Matches</a>
          <a href="/exceptions">Exceptions</a>
          <a href="/upload">Upload</a>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
