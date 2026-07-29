import { writeFile } from 'node:fs/promises';
import { formatCents } from '../parsers/types.js';

// The counsel-facing report. Output may be read by opposing counsel, an insurer,
// the NY Attorney General, or a purchaser in diligence, so it is built to be
// unambiguous about provenance: machine-read (pdftotext/csv) and model-read
// (ocr/llm) figures are reported separately and never conflated (invariant 5),
// and every count ties back to a table a reader can re-derive.
//
// The pure renderer takes an assembled snapshot; the DB-backed generator loads
// that snapshot. Keeping them separate lets the formatting be tested without a
// database.

export interface TieoutRow {
  name: string; asOf: string | null; checksumOk: boolean | null;
  bankCents: number | null; ledgerCents: number | null; expectedCents: number | null;
  ledgerVarianceCents: number | null; expectedVarianceCents: number | null;
}

export interface ReportData {
  generatedAt: string;
  buildings: TieoutRow[];
  exceptionsBySeverity: { severity: string; count: number }[];
  exceptionsByKind: { kind: string; severity: string; count: number; amountCents: number }[];
  openDeadlines: number;
  matchRate: { bankTxns: number; suggested: number; decided: number; exact: number; fuzzy: number };
  extractionMix: { method: string; count: number }[];
}

const SEV_ORDER = ['critical', 'high', 'medium', 'low'];
const MACHINE_READ = new Set(['pdftotext', 'csv']);

export interface PortfolioTotals {
  bankTotal: number; expectedTotal: number; expectedVar: number;
  reconciled: number; noStatement: number;
}

/**
 * Portfolio totals that RECONCILE. A building with no statement has no known
 * bank balance (bank_cents null) and no defined variance, so it is excluded
 * from all three sums and reported separately. This guarantees the identity
 *   expectedVar === bankTotal − expectedTotal
 * because every included building has expected_variance = bank − expected, so
 * the summed variance equals the summed bank minus the summed expected. Mixing
 * in a no-statement building (expected counted, bank/variance not) would break
 * that identity — the exact "numbers that don't add up" failure this system is
 * meant to avoid.
 */
export function reconcilePortfolio(
  buildings: { bankCents: number | null; expectedCents: number | null; expectedVarianceCents: number | null }[],
): PortfolioTotals {
  const r = buildings.filter(b => b.bankCents != null);
  return {
    bankTotal: r.reduce((a, b) => a + (b.bankCents ?? 0), 0),
    expectedTotal: r.reduce((a, b) => a + (b.expectedCents ?? 0), 0),
    expectedVar: r.reduce((a, b) => a + (b.expectedVarianceCents ?? 0), 0),
    reconciled: r.length,
    noStatement: buildings.length - r.length,
  };
}

export function renderReport(d: ReportData): { markdown: string; json: string } {
  const L: string[] = [];
  const money = (c: number | null | undefined) => formatCents(c ?? 0);

  L.push('# Security Deposit Escrow — Reconciliation Report');
  L.push('');
  L.push(`_Generated ${d.generatedAt}. Figures are integer cents; credits positive, debits negative._`);
  L.push('');

  // Portfolio totals — reconciled over buildings that have a statement, so
  // Escrow held − Lease universe === Expected variance, exactly.
  const { bankTotal, expectedTotal, expectedVar, reconciled, noStatement } = reconcilePortfolio(d.buildings);
  const quarantined = d.buildings.filter(b => b.checksumOk === false).length;

  L.push('## Portfolio');
  L.push('');
  L.push(`- Buildings: **${d.buildings.length}**${noStatement ? ` (${reconciled} reconciled; ${noStatement} without a statement, excluded from totals)` : ''}`);
  L.push(`- Escrow held (latest statements): **${money(bankTotal)}**`);
  L.push(`- Lease universe expects: **${money(expectedTotal)}**`);
  L.push(`- Expected variance (bank − lease universe): **${money(expectedVar)}** ${expectedVar < 0 ? '— escrow holds less than the leases imply' : ''}`);
  if (quarantined) L.push(`- ⚠ Latest statement failed the checksum gate for **${quarantined}** building(s).`);
  L.push('');

  // Provenance — machine-read vs model-read
  L.push('## Provenance of figures');
  L.push('');
  L.push('Machine-read figures come from a text layer or CSV; model-read figures were transcribed by OCR or proposed by a model and must be read as such.');
  L.push('');
  L.push('| Extraction method | Statements | Class |');
  L.push('|---|--:|---|');
  for (const m of d.extractionMix) {
    L.push(`| ${m.method} | ${m.count} | ${MACHINE_READ.has(m.method) ? 'machine-read' : 'model-read'} |`);
  }
  L.push('');

  // Tie-out table
  L.push('## Tie-out by building');
  L.push('');
  L.push('| Building | As of | Bank | Ledger | Expected | Ledger var. | Expected var. | ck |');
  L.push('|---|---|--:|--:|--:|--:|--:|:-:|');
  for (const b of [...d.buildings].sort((a, z) => (a.expectedVarianceCents ?? 0) - (z.expectedVarianceCents ?? 0))) {
    L.push(`| ${b.name} | ${b.asOf ?? 'no statement'} | ${money(b.bankCents)} | ${money(b.ledgerCents)} | ${money(b.expectedCents)} | ${money(b.ledgerVarianceCents)} | ${money(b.expectedVarianceCents)} | ${b.checksumOk === false ? '!!' : ''} |`);
  }
  L.push('');

  // Exceptions
  L.push('## Exceptions');
  L.push('');
  const sev = d.exceptionsBySeverity.slice().sort((a, z) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(z.severity));
  L.push(sev.length ? sev.map(s => `**${s.severity}**: ${s.count}`).join('  ·  ') : '_none recorded_');
  L.push('');
  if (d.exceptionsByKind.length) {
    L.push('| Kind | Severity | Count | Amount implicated |');
    L.push('|---|---|--:|--:|');
    for (const k of [...d.exceptionsByKind].sort((a, z) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(z.severity) || z.count - a.count)) {
      L.push(`| ${k.kind} | ${k.severity} | ${k.count} | ${money(k.amountCents)} |`);
    }
    L.push('');
  }

  // Matching + deadlines
  L.push('## Matching & deadlines');
  L.push('');
  const mr = d.matchRate;
  const autoRate = mr.bankTxns ? ((mr.suggested / mr.bankTxns) * 100).toFixed(1) : '0.0';
  L.push(`- Bank transactions: **${mr.bankTxns}**; matches proposed: **${mr.suggested}** (${autoRate}%); human-decided: **${mr.decided}**.`);
  L.push(`  - Every proposed match requires human approval before it counts.`);
  L.push(`- Open 14-day refund deadlines being tracked: **${d.openDeadlines}**.`);
  L.push('');
  L.push('---');
  L.push('_This report is a computed reconciliation, not a legal conclusion. Every figure traces to a source document, page, and line in the underlying database._');

  return { markdown: L.join('\n') + '\n', json: JSON.stringify(d, null, 2) + '\n' };
}

/** Assemble the snapshot from the database and write both files. */
export async function generateReport(outBase: string, generatedAt: string): Promise<ReportData> {
  const { db } = await import('../db.js');

  const [tie, exc, deadlines, mrate, statements] = await Promise.all([
    db.from('v_building_tieout').select('*'),
    // Resolved findings are excluded from the counts — the report states what
    // is still open, not the full history.
    db.from('exceptions').select('kind, severity, amount_cents, status').neq('status', 'resolved'),
    db.from('v_open_deadlines').select('lease_id'),
    db.from('v_match_rate').select('*').maybeSingle(),
    db.from('statements').select('extract_method').eq('checksum_ok', true),
  ]);

  const buildings: TieoutRow[] = (tie.data ?? []).map((r: any) => ({
    name: r.name, asOf: r.as_of, checksumOk: r.checksum_ok,
    bankCents: r.bank_cents, ledgerCents: r.ledger_cents, expectedCents: r.expected_cents,
    ledgerVarianceCents: r.ledger_variance_cents, expectedVarianceCents: r.expected_variance_cents,
  }));

  const bySev = new Map<string, number>();
  const byKind = new Map<string, { severity: string; count: number; amountCents: number }>();
  for (const e of (exc.data ?? []) as any[]) {
    bySev.set(e.severity, (bySev.get(e.severity) ?? 0) + 1);
    const k = byKind.get(e.kind) ?? { severity: e.severity, count: 0, amountCents: 0 };
    k.count++; k.amountCents += Number(e.amount_cents ?? 0);
    byKind.set(e.kind, k);
  }

  const mix = new Map<string, number>();
  for (const s of (statements.data ?? []) as any[]) mix.set(s.extract_method, (mix.get(s.extract_method) ?? 0) + 1);

  const mr = (mrate.data ?? {}) as any;
  const data: ReportData = {
    generatedAt,
    buildings,
    exceptionsBySeverity: [...bySev.entries()].map(([severity, count]) => ({ severity, count })),
    exceptionsByKind: [...byKind.entries()].map(([kind, v]) => ({ kind, ...v })),
    openDeadlines: (deadlines.data ?? []).length,
    matchRate: {
      bankTxns: Number(mr.bank_txns ?? 0), suggested: Number(mr.suggested ?? 0),
      decided: Number(mr.decided ?? 0), exact: Number(mr.exact ?? 0), fuzzy: Number(mr.fuzzy ?? 0),
    },
    extractionMix: [...mix.entries()].map(([method, count]) => ({ method, count })),
  };

  const { markdown, json } = renderReport(data);
  await writeFile(`${outBase}.md`, markdown, 'utf8');
  await writeFile(`${outBase}.json`, json, 'utf8');
  console.log(`report written: ${outBase}.md, ${outBase}.json`);
  return data;
}
