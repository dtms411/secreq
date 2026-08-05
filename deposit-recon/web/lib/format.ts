// Same money rule as the CLI: integer cents in, formatted string out. No float
// math anywhere near a figure.
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

export function severityColor(sev: string): string {
  return { critical: '#B42318', high: '#B54708', medium: '#8A5A0B', low: '#545E68' }[sev] ?? '#545E68';
}

// Tinted badge: status text on a low-chroma wash of the same hue, with a hairline
// ring. Ships with the severity word as its label, so state is never color-alone.
export function severityStyle(sev: string): { color: string; background: string; boxShadow: string } {
  const m: Record<string, [string, string, string]> = {
    critical: ['#B42318', '#FCEBE8', 'inset 0 0 0 1px #F3CFC9'],
    high: ['#B54708', '#FBEDDF', 'inset 0 0 0 1px #EFD6BB'],
    medium: ['#8A5A0B', '#F6EEDA', 'inset 0 0 0 1px #E7D9B4'],
    low: ['#545E68', '#EAEDEF', 'inset 0 0 0 1px #D9DEE2'],
  };
  const [color, background, boxShadow] = m[sev] ?? m.low;
  return { color, background, boxShadow };
}
