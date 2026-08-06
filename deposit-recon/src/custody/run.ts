import { db } from '../db.js';
import { formatCents } from '../parsers/types.js';
import {
  runCustodyDetectors, DEFAULT_CUSTODY_OPTS, type CustodyOptions, type CustodyFinding,
} from './detectors.js';
import { custodyTotals, reconcileCustodyToBank, custodyBalanceRecon } from './totals.js';
import type { CustodyRecord, CustodyStage } from './parse.js';

// DB-backed custody runner. Loads custody_deposits, runs the pure lifecycle
// detectors, and records findings in the same `exceptions` triage queue the
// reconciliation detectors use (idempotent via detail.signature). Also prints
// the Master-account aging report — the tracker's headline control — and a
// custody-vs-bank reconciliation the human can act on.
//
// Custody rows are the office's claims. This runner never advances a stage or
// moves money; it flags what is stuck and totals what is where.

// -------------------------------------------------- load + shape

function toRecord(d: any): CustodyRecord {
  return {
    externalRef: d.external_ref, buildingKey: d.buildings?.name ?? '', buildingId: d.building_id,
    leaseId: d.lease_id, unit: d.unit, tenantName: d.tenant_name, kind: d.kind,
    amountCents: Number(d.amount_cents),
    receivedOn: d.received_on, sentToBankOn: d.sent_to_bank_on, bankClearedOn: d.bank_cleared_on,
    inMasterCents: Number(d.in_master_cents ?? 0),
    subaccountLast4: d.subaccount_last4, subaccountOpenedOn: d.subaccount_opened_on, allocatedOn: d.allocated_on,
    stage: d.stage as CustodyStage, responsibleEmployee: d.responsible_employee, nextAction: d.next_action,
    bankBalanceCents: d.bank_balance_cents == null ? null : Number(d.bank_balance_cents),
    accountingBalanceCents: d.accounting_balance_cents == null ? null : Number(d.accounting_balance_cents),
    balanceAsOf: d.balance_as_of,
    vacateDate: d.vacate_date, bankAccountClosedOn: d.bank_account_closed_on,
    fundsReturnedOn: d.funds_returned_on, fundsReturnedCents: d.funds_returned_cents == null ? null : Number(d.funds_returned_cents),
    refundedOn: d.refunded_on, refundedCents: d.refunded_cents == null ? null : Number(d.refunded_cents),
    finalStatus: d.final_status,
  };
}

async function loadCustodyRecords(): Promise<CustodyRecord[]> {
  const { data, error } = await db
    .from('custody_deposits')
    .select('*, buildings(name)');
  if (error) throw error;
  return (data ?? []).map(toRecord);
}

// Pure roll-ups (custodyTotals, reconcileCustodyToBank) live in ./totals.js so
// they can be unit-tested without a database; re-exported for callers.
export { custodyTotals, reconcileCustodyToBank, custodyBalanceRecon } from './totals.js';
export type { CustodyTotals, CustodyBankRecon, CustodyBalanceRecon } from './totals.js';

// -------------------------------------------------- detect (write to exceptions)

export interface CustodyDetectResult {
  found: number;
  inserted: number;
  byKind: Record<string, number>;
  bySeverity: Record<string, number>;
}

async function insert(f: CustodyFinding): Promise<void> {
  const { error } = await db.from('exceptions').insert({
    kind: f.kind,
    severity: f.severity,
    building_id: f.buildingId ?? null,
    lease_id: f.leaseId ?? null,
    amount_cents: f.amountCents ?? null,
    detail: { signature: f.signature, ...f.detail },
  });
  if (error) throw error;
}

export async function runCustodyDetect(
  write = true, today: string, opts: CustodyOptions = DEFAULT_CUSTODY_OPTS,
): Promise<CustodyDetectResult> {
  const records = await loadCustodyRecords();
  const found = runCustodyDetectors(records, today, opts);

  const byKind: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const f of found) {
    byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  }

  let inserted = 0;
  if (write) {
    const { data: existing } = await db.from('exceptions').select('detail');
    const seen = new Set((existing ?? []).map((e: any) => e.detail?.signature).filter(Boolean));
    for (const f of found) {
      if (seen.has(f.signature)) continue;
      await insert(f);
      inserted++;
    }
  }

  const order = ['critical', 'high', 'medium', 'low'];
  console.log(`custody detectors: ${found.length} finding(s)` + (write ? `, ${inserted} new` : ' (dry run)'));
  for (const sev of order) if (bySeverity[sev]) console.log(`  ${sev}: ${bySeverity[sev]}`);
  for (const [kind, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`    ${kind}  ${n}`);
  return { found: found.length, inserted, byKind, bySeverity };
}

// -------------------------------------------------- aging report (read only)

export async function custodyAging(today: string, bankMasterCents?: number, o: CustodyOptions = DEFAULT_CUSTODY_OPTS): Promise<void> {
  const records = await loadCustodyRecords();
  const t = custodyTotals(records, today, o);

  console.log('Custody control — portfolio summary');
  console.log(`  total security received   ${formatCents(t.totalReceivedCents)}`);
  console.log(`  in Master (pooled)        ${formatCents(t.inMasterCents)}`);
  console.log(`  in tenant subaccounts     ${formatCents(t.inSubaccountsCents)}`);
  console.log(`  refund pending            ${t.refundPending}  (${formatCents(t.refundPendingCents)})`);
  console.log(`  closed records            ${t.closedRecords}`);
  console.log(`  master aged > ${o.masterAgingDays}d          ${t.masterAgedOver30}`);

  if (bankMasterCents != null) {
    const rec = reconcileCustodyToBank(records, bankMasterCents);
    console.log('\nMaster account — custody vs bank');
    console.log(`  tracker claims pooled     ${formatCents(rec.custodyMasterCents)}`);
    console.log(`  Santander Master balance  ${formatCents(rec.bankMasterCents)}`);
    console.log(`  variance (bank − claim)   ${formatCents(rec.varianceCents)}`);
  }

  const br = custodyBalanceRecon(records);
  if (br.comparedCount || br.bankStatedCents || br.accountingExpectedCents) {
    console.log('\nBank vs accounting — per-tenant balances');
    console.log(`  bank stated (Σ)           ${formatCents(br.bankStatedCents)}`);
    console.log(`  accounting expected (Σ)   ${formatCents(br.accountingExpectedCents)}`);
    console.log(`  variance (bank − books)   ${formatCents(br.varianceCents)}`);
    console.log(`  compared ${br.comparedCount}   pending ${br.pendingCount}`);
  }

  const aging = records
    .filter(r => r.inMasterCents > 0)
    .map(r => {
      const since = r.bankClearedOn ?? r.sentToBankOn ?? null;
      const days = since ? Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000) : null;
      return { r, since, days };
    })
    .sort((a, b) => (b.days ?? -1) - (a.days ?? -1));

  if (aging.length) {
    console.log('\nMaster-account aging — every dollar still pooled, oldest first');
    for (const { r, since, days } of aging) {
      const flag = days != null && days > o.masterAgingDays ? '  !!' : '';
      console.log(`  ${(days ?? '—').toString().padStart(4)}d  ${formatCents(r.inMasterCents).padStart(13)}  ${r.unit}  ${r.tenantName}  (since ${since ?? '—'})${flag}`);
    }
  }
}
