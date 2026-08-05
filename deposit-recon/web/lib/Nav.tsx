'use client';

import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Tie-out' },
  { href: '/custody', label: 'Custody' },
  { href: '/quarantine', label: 'Quarantine' },
  { href: '/matches', label: 'Matches' },
  { href: '/exceptions', label: 'Exceptions' },
  { href: '/upload', label: 'Upload' },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav">
      {LINKS.map((l) => (
        <a key={l.href} href={l.href} data-active={path === l.href}>{l.label}</a>
      ))}
    </nav>
  );
}
