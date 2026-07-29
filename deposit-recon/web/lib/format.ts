// Same money rule as the CLI: integer cents in, formatted string out. No float
// math anywhere near a figure.
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

export function severityColor(sev: string): string {
  return { critical: '#8C2F22', high: '#A9531E', medium: '#856A1C', low: '#5F5A4F' }[sev] ?? '#5F5A4F';
}

// Tinted badge: warm text on a low-chroma wash of the same hue. Ships with the
// severity word as its label, so state is never color-alone.
export function severityStyle(sev: string): { color: string; background: string } {
  const m: Record<string, [string, string]> = {
    critical: ['#8C2F22', '#F1E0DB'],
    high: ['#A9531E', '#F3E7D8'],
    medium: ['#856A1C', '#EFE9D3'],
    low: ['#5F5A4F', '#E9E4D8'],
  };
  const [color, background] = m[sev] ?? m.low;
  return { color, background };
}
