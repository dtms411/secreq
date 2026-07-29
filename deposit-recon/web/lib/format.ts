// Same money rule as the CLI: integer cents in, formatted string out. No float
// math anywhere near a figure.
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

export function severityColor(sev: string): string {
  return { critical: '#b91c1c', high: '#c2410c', medium: '#a16207', low: '#4b5563' }[sev] ?? '#4b5563';
}
