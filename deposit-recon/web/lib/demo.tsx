// Illustrative demo data for the preview deployment. Rendered only when no
// Supabase database is connected (or a query returns nothing), so real data
// always wins once the project is wired. Names are obviously synthetic and every
// screen shows the DEMO banner — this must never be mistaken for real
// reconciliation output.

export const DEMO = true; // preview build flag; flip off / delete for production

export function DemoBanner() {
  return (
    <div style={{
      background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a',
      borderRadius: 6, padding: '6px 12px', fontSize: 12, margin: '0 0 12px',
    }}>
      <strong>DEMO DATA</strong> — illustrative figures for this preview, not real reconciliation output. No database is connected.
    </div>
  );
}

export const demoTieout = [
  { building_id: 'd1', name: 'DEMO — Maple Court', unit_count: 24, interest_required: true, as_of: '2025-04-30', checksum_ok: true, bank_cents: 4970625, ledger_cents: 4970625, expected_cents: 5100000, ledger_variance_cents: 0, expected_variance_cents: -129375 },
  { building_id: 'd2', name: 'DEMO — Shore Road', unit_count: 18, interest_required: true, as_of: '2025-05-31', checksum_ok: true, bank_cents: 7514410, ledger_cents: 7664410, expected_cents: 7514410, ledger_variance_cents: -150000, expected_variance_cents: 0 },
  { building_id: 'd3', name: 'DEMO — Nostrand Ave', unit_count: 8, interest_required: true, as_of: '2025-03-31', checksum_ok: false, bank_cents: 2400000, ledger_cents: 2400000, expected_cents: 2650000, ledger_variance_cents: 0, expected_variance_cents: -250000 },
  { building_id: 'd4', name: 'DEMO — Bay Ridge Terrace', unit_count: 12, interest_required: true, as_of: null, checksum_ok: null, bank_cents: null, ledger_cents: 0, expected_cents: 1800000, ledger_variance_cents: null, expected_variance_cents: null },
];

export const demoQuarantineStatements = [
  { statement_id: 's3', building_id: 'DEMO — Nostrand Ave', period_start: '2025-03-01', period_end: '2025-03-31', checksum_delta_cents: -3125, extract_method: 'ocr' },
];

export const demoCriticalExceptions = [
  { id: 'e1', kind: 'deposit_never_banked', severity: 'critical', amount_cents: 250000, detail: { message: 'Lease signed 2025-02-01; no escrow credit within 30 days' }, opened_at: '2025-06-01' },
  { id: 'e2', kind: 'unexplained_debit', severity: 'critical', amount_cents: -150000, detail: { message: 'Escrow debit with no linked move-out record' }, opened_at: '2025-06-02' },
  { id: 'e3', kind: 'refund_payee_mismatch', severity: 'critical', amount_cents: -240000, detail: { message: 'Payee "SMITH J" ≠ tenant of record "Rivera M"' }, opened_at: '2025-06-03' },
  { id: 'e4', kind: 'escrow_to_operating', severity: 'high', amount_cents: -500000, detail: { message: 'Transfer out to operating account ....9902' }, opened_at: '2025-06-04' },
];

export const demoMatches = [
  { id: 'm1', method: 'exact', confidence: 0.95, decided_by: null, bank_transactions: { descriptor: 'DEPOSIT - RIVERA M UNIT 4B', amount_cents: 240000, posted_on: '2025-04-03' }, leases: { tenant_name: 'Rivera M', unit: '4B' } },
  { id: 'm2', method: 'fuzzy', confidence: 0.62, decided_by: null, bank_transactions: { descriptor: 'ACH DEP OKONKWO A 2R', amount_cents: 265000, posted_on: '2025-04-17' }, leases: { tenant_name: 'Okonkwo A', unit: '2R' } },
  { id: 'm3', method: 'llm_suggested', confidence: 0.55, decided_by: null, bank_transactions: { descriptor: 'ONLINE XFER REF 5591', amount_cents: 180000, posted_on: '2025-05-12' }, leases: { tenant_name: 'Haley P', unit: '12A' } },
];

export const demoExceptions = [
  ...demoCriticalExceptions.map(e => ({ ...e, status: 'open' })),
  { id: 'e5', kind: 'deposit_exceeds_one_month', severity: 'medium', status: 'open', amount_cents: 30000, detail: { message: 'Deposit $3,300 exceeds one month rent $3,000 (GOL §7-108)' }, opened_at: '2025-06-05' },
  { id: 'e6', kind: 'stale_credit', severity: 'medium', status: 'investigating', amount_cents: 240000, detail: { message: 'Vacated 2025-01-01; balance still held' }, opened_at: '2025-06-06' },
  { id: 'e7', kind: 'interest_account_noncompliant', severity: 'high', status: 'open', amount_cents: null, detail: { message: 'GOL §7-103: 6+ units requires an interest-bearing account' }, opened_at: '2025-06-07' },
  { id: 'e8', kind: 'missing_statement_period', severity: 'medium', status: 'open', amount_cents: null, detail: { message: 'Gap: period ends 2025-02-28, next starts 2025-04-01' }, opened_at: '2025-06-08' },
];
