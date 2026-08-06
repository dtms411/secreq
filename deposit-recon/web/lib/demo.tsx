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
// Editable custody records. In the preview these are the single source the
// custody screen reads, edits, and adds to; the dashboard tiles and Master
// aging recompute from them live (real mode reads custody_deposits + the views).
import type { CustodyRow } from './custody';

const B = { bank_balance_cents: null as number | null, accounting_balance_cents: null as number | null, balance_as_of: null as string | null };
export const demoCustodyRecords: CustodyRow[] = [
  { id: 'c1', building_id: 'd-020', building: 'DEMO — Property-020', unit: '1A', tenant_name: 'Alvarez R', kind: 'initial', amount_cents: 250000, received_on: '2024-12-20', sent_to_bank_on: '2025-01-02', bank_cleared_on: '2025-01-06', in_master_cents: 250000, subaccount_last4: null, subaccount_opened_on: null, allocated_on: null, stage: 'in_master', responsible_employee: 'J. Ruiz', next_action: 'Open subaccount + allocate', ...B, bank_balance_cents: 250000, accounting_balance_cents: 250000, balance_as_of: '2025-07-31', vacate_date: null, bank_account_closed_on: null, funds_returned_on: null, funds_returned_cents: null, refunded_on: null, refunded_cents: null, final_status: null },
  { id: 'c2', building_id: 'd-020', building: 'DEMO — Property-020', unit: '4C', tenant_name: 'Bianchi L', kind: 'initial', amount_cents: 265000, received_on: '2025-06-14', sent_to_bank_on: '2025-06-16', bank_cleared_on: '2025-06-20', in_master_cents: 265000, subaccount_last4: null, subaccount_opened_on: null, allocated_on: null, stage: 'in_master', responsible_employee: 'J. Ruiz', next_action: 'Open subaccount + allocate', ...B, bank_balance_cents: 260000, accounting_balance_cents: 265000, balance_as_of: '2025-07-31', vacate_date: null, bank_account_closed_on: null, funds_returned_on: null, funds_returned_cents: null, refunded_on: null, refunded_cents: null, final_status: null },
  { id: 'c3', building_id: 'd-020', building: 'DEMO — Property-020', unit: '2B', tenant_name: 'Okonkwo A', kind: 'initial', amount_cents: 180000, received_on: '2025-07-22', sent_to_bank_on: '2025-07-24', bank_cleared_on: '2025-07-28', in_master_cents: 180000, subaccount_last4: '7788', subaccount_opened_on: '2025-07-30', allocated_on: null, stage: 'subaccount_pending', responsible_employee: 'M. Diaz', next_action: 'Allocate into 7788', ...B, bank_balance_cents: 180000, accounting_balance_cents: 180000, balance_as_of: '2025-07-31', vacate_date: null, bank_account_closed_on: null, funds_returned_on: null, funds_returned_cents: null, refunded_on: null, refunded_cents: null, final_status: null },
  { id: 'c4', building_id: 'd-020', building: 'DEMO — Property-020', unit: '5A', tenant_name: 'Rivera M', kind: 'initial', amount_cents: 240000, received_on: '2025-02-24', sent_to_bank_on: '2025-02-26', bank_cleared_on: '2025-03-01', in_master_cents: 0, subaccount_last4: '7789', subaccount_opened_on: '2025-03-05', allocated_on: '2025-03-05', stage: 'in_subaccount', responsible_employee: 'J. Ruiz', next_action: null, ...B, bank_balance_cents: 238000, accounting_balance_cents: 240000, balance_as_of: '2025-07-31', vacate_date: null, bank_account_closed_on: null, funds_returned_on: null, funds_returned_cents: null, refunded_on: null, refunded_cents: null, final_status: null },
  { id: 'c5', building_id: 'd-020', building: 'DEMO — Property-020', unit: '6C', tenant_name: 'Thompson K', kind: 'initial', amount_cents: 200000, received_on: '2024-08-10', sent_to_bank_on: '2024-08-12', bank_cleared_on: '2024-08-16', in_master_cents: 0, subaccount_last4: '7712', subaccount_opened_on: '2024-08-20', allocated_on: '2024-08-20', stage: 'funds_returned', responsible_employee: 'J. Ruiz', next_action: 'Refund tenant — 14-day clock running', ...B, vacate_date: '2025-05-20', bank_account_closed_on: '2025-06-01', funds_returned_on: '2025-06-01', funds_returned_cents: 200000, refunded_on: null, refunded_cents: null, final_status: null },
  { id: 'c6', building_id: 'd-011', building: 'DEMO — Property-011', unit: '3R', tenant_name: 'Haley P', kind: 'additional', amount_cents: 90000, received_on: '2025-04-24', sent_to_bank_on: '2025-04-28', bank_cleared_on: '2025-05-01', in_master_cents: 90000, subaccount_last4: null, subaccount_opened_on: null, allocated_on: null, stage: 'in_master', responsible_employee: 'M. Diaz', next_action: 'Open subaccount + allocate', ...B, bank_balance_cents: 90000, accounting_balance_cents: 90000, balance_as_of: '2025-07-31', vacate_date: null, bank_account_closed_on: null, funds_returned_on: null, funds_returned_cents: null, refunded_on: null, refunded_cents: null, final_status: null },
  { id: 'c7', building_id: 'd-011', building: 'DEMO — Property-011', unit: '2B', tenant_name: 'Okafor N', kind: 'initial', amount_cents: 220000, received_on: '2025-01-15', sent_to_bank_on: '2025-01-17', bank_cleared_on: '2025-01-21', in_master_cents: 0, subaccount_last4: '7790', subaccount_opened_on: '2025-01-25', allocated_on: '2025-01-25', stage: 'active', responsible_employee: 'M. Diaz', next_action: null, ...B, bank_balance_cents: 220000, accounting_balance_cents: 220000, balance_as_of: '2025-07-31', vacate_date: null, bank_account_closed_on: null, funds_returned_on: null, funds_returned_cents: null, refunded_on: null, refunded_cents: null, final_status: null },
  { id: 'c8', building_id: 'd-011', building: 'DEMO — Property-011', unit: '7D', tenant_name: 'Nguyen T', kind: 'initial', amount_cents: 150000, received_on: '2023-06-01', sent_to_bank_on: '2023-06-03', bank_cleared_on: '2023-06-07', in_master_cents: 0, subaccount_last4: '7655', subaccount_opened_on: '2023-06-10', allocated_on: '2023-06-10', stage: 'closed', responsible_employee: 'M. Diaz', next_action: null, ...B, vacate_date: '2025-03-20', bank_account_closed_on: '2025-04-01', funds_returned_on: '2025-04-01', funds_returned_cents: 150000, refunded_on: '2025-04-10', refunded_cents: 150000, final_status: 'Refunded in full' },
];

// Demo buildings to pick from when adding a new deposit on the site.
export const demoBuildings = [
  { id: 'd-020', name: 'DEMO — Property-020' },
  { id: 'd-011', name: 'DEMO — Property-011' },
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
