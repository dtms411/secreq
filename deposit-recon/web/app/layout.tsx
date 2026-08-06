import './globals.css';
import { Manrope, Inter } from 'next/font/google';

// All sans-serif: Manrope for display (headings, figures, brand), Inter for the
// dense UI + tabular data. Self-hosted by next/font — no runtime Google request.
const display = Manrope({ subsets: ['latin'], weight: ['500', '600', '700', '800'], display: 'swap', variable: '--font-display' });
const ui = Inter({ subsets: ['latin'], weight: ['400', '500', '600'], display: 'swap', variable: '--font-ui' });

export const metadata = {
  title: 'SecReq — Security Deposit Reconciliation',
  description: 'Forensic reconciliation of tenant security deposit escrow — bank, books, and leases, tied out.',
};

// Bare root shell. The sidebar app frame lives in the (app) route group so the
// public splash and login pages render without it.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${ui.variable}`}>
      <body>{children}</body>
    </html>
  );
}
