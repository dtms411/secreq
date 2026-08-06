'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

// 16px line icons, currentColor so they follow the link's active/hover state.
const I = (paths: ReactNode) => (
  <svg className="nav-ico" width="16" height="16" viewBox="0 0 16 16" fill="none"
    stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths}</svg>
);

const LINKS: { href: string; label: string; icon: ReactNode }[] = [
  { href: '/dashboard', label: 'Tie-out', icon: I(<><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></>) },
  { href: '/custody', label: 'Custody', icon: I(<><rect x="2.5" y="7" width="11" height="7" rx="1.5" /><path d="M5 7V5a3 3 0 0 1 6 0v2" /><circle cx="8" cy="10.5" r="0.4" fill="currentColor" /></>) },
  { href: '/quarantine', label: 'Quarantine', icon: I(<><path d="M8 2l5 2v3.5c0 3.2-2.2 5-5 6-2.8-1-5-2.8-5-6V4l5-2z" /><path d="M8 6v3" /><path d="M8 11h.01" /></>) },
  { href: '/matches', label: 'Matches', icon: I(<><path d="M6.5 9.5l3-3" /><path d="M9 4.5l.7-.7a2.5 2.5 0 0 1 3.5 3.5l-.7.7" /><path d="M7 11.5l-.7.7a2.5 2.5 0 0 1-3.5-3.5l.7-.7" /></>) },
  { href: '/exceptions', label: 'Exceptions', icon: I(<><path d="M8 2.5l5.5 10H2.5L8 2.5z" /><path d="M8 6.5v3" /><path d="M8 11.5h.01" /></>) },
  { href: '/upload', label: 'Upload', icon: I(<><path d="M8 10.5V3" /><path d="M5 6l3-3 3 3" /><path d="M3 11v1.5h10V11" /></>) },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav">
      {LINKS.map((l) => (
        <a key={l.href} href={l.href} data-active={path === l.href}>
          {l.icon}
          {l.label}
        </a>
      ))}
    </nav>
  );
}
