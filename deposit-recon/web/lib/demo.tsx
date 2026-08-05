// Illustrative demo data for the preview deployment. Rendered only when no
// Supabase database is connected (or a query returns nothing), so real data
// always wins once the project is wired. Names are obviously synthetic and every
// screen shows the DEMO banner — this must never be mistaken for real
// reconciliation output.

export const DEMO = true; // preview build flag; flip off / delete for production

export function DemoBanner() {
  return (
    <div className="demo-banner">
      <strong>DEMO DATA</strong>
      <span>— illustrative figures for this preview, not real reconciliation output. No database is connected.</span>
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

// ---- custody control (the office tracker, tied in) ----------------------
// v_custody_summary is per building; the dashboard header sums these. Figures
// are internally consistent with demoMasterAging below (Σ in_master matches).
export const demoCustodySummary = [
  { building_id: 'd-020', building: 'DEMO — Property-020', total_received_cents: 1845000, in_master_cents: 695000, in_subaccounts_cents: 900000, refund_pending: 1, closed_records: 3, master_aged_over_30: 2 },
  { building_id: 'd-011', building: 'DEMO — Property-011', total_received_cents: 620000, in_master_cents: 90000, in_subaccounts_cents: 440000, refund_pending: 0, closed_records: 1, master_aged_over_30: 1 },
];

// v_master_account_aging — every dollar still pooled in the Santander Master
// account, days outstanding since it cleared. Oldest money is the headline risk.
export const demoMasterAging = [
  { id: 'c1', building: 'DEMO — Property-020', unit: '1A', tenant_name: 'Alvarez R', kind: 'initial', in_master_cents: 250000, since: '2025-01-06', days_in_master: 211, subaccount_last4: null, stage: 'in_master', responsible_employee: 'J. Ruiz', next_action: 'Open subaccount + allocate' },
  { id: 'c2', building: 'DEMO — Property-011', unit: '3R', tenant_name: 'Haley P', kind: 'additional', in_master_cents: 90000, since: '2025-05-01', days_in_master: 96, subaccount_last4: null, stage: 'in_master', responsible_employee: 'M. Diaz', next_action: 'Open subaccount + allocate' },
  { id: 'c3', building: 'DEMO — Property-020', unit: '4C', tenant_name: 'Bianchi L', kind: 'initial', in_master_cents: 265000, since: '2025-06-20', days_in_master: 46, subaccount_last4: null, stage: 'in_master', responsible_employee: 'J. Ruiz', next_action: 'Open subaccount + allocate' },
  { id: 'c4', building: 'DEMO — Property-020', unit: '2B', tenant_name: 'Okonkwo A', kind: 'initial', in_master_cents: 180000, since: '2025-07-28', days_in_master: 8, subaccount_last4: '7788', stage: 'subaccount_pending', responsible_employee: 'M. Diaz', next_action: 'Allocate into 7788' },
];

// Illustrative Santander Master statement balance for the custody-vs-bank tie.
// Tracker claims $7,850.00 pooled; the bank Master shows $7,350.00 → −$500
// unaccounted for. Independence is the point: their disagreement is the finding.
export const demoMasterBankBalanceCents = 735000;

export const demoExceptions = [
  ...demoCriticalExceptions.map(e => ({ ...e, status: 'open' })),
  { id: 'e5', kind: 'deposit_exceeds_one_month', severity: 'medium', status: 'open', amount_cents: 30000, detail: { message: 'Deposit $3,300 exceeds one month rent $3,000 (GOL §7-108)' }, opened_at: '2025-06-05' },
  { id: 'e6', kind: 'stale_credit', severity: 'medium', status: 'investigating', amount_cents: 240000, detail: { message: 'Vacated 2025-01-01; balance still held' }, opened_at: '2025-06-06' },
  { id: 'e7', kind: 'interest_account_noncompliant', severity: 'high', status: 'open', amount_cents: null, detail: { message: 'GOL §7-103: 6+ units requires an interest-bearing account' }, opened_at: '2025-06-07' },
  { id: 'e8', kind: 'missing_statement_period', severity: 'medium', status: 'open', amount_cents: null, detail: { message: 'Gap: period ends 2025-02-28, next starts 2025-04-01' }, opened_at: '2025-06-08' },
  { id: 'e9', kind: 'master_account_float', severity: 'critical', status: 'open', amount_cents: 250000, detail: { message: 'Property-020 1A Alvarez R — $2,500 pooled in Master 211 days, no subaccount' }, opened_at: '2025-06-09' },
  { id: 'e10', kind: 'funds_returned_not_refunded', severity: 'critical', status: 'open', amount_cents: 240000, detail: { message: 'Bank returned $2,400 on 2025-06-01; tenant never refunded — 14-day clock blown' }, opened_at: '2025-06-10' },
  { id: 'e11', kind: 'subaccount_not_opened', severity: 'high', status: 'investigating', amount_cents: 90000, detail: { message: 'Property-011 3R Haley P — cleared to Master, no subaccount after 96 days' }, opened_at: '2025-06-11' },
];
