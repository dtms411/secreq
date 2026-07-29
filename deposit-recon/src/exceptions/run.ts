import { db } from '../db.js';
import {
  runAllDetectors, DEFAULT_DETECTOR_OPTS, type DetectorOptions,
  type Dataset, type AccountRef, type TxnRef, type LeaseRef, type LedgerRef, type MatchRef, type StatementRef, type BuildingRef, type Detected,
} from './detectors.js';

// Loads the whole reconciliation dataset, runs every detector, and records the
// findings in `exceptions`. Idempotent: each finding carries a deterministic
// signature stored in detail.signature, and a finding already present is not
// duplicated, so this is safe to run after every ingest.

async function loadDataset(): Promise<Dataset> {
  const [accountsR, txnsR, leasesR, ledgerR, matchesR, statementsR, buildingsR] = await Promise.all([
    db.from('bank_accounts').select('id, building_id, account_type, account_last4, is_interest_bearing'),
    db.from('bank_transactions').select('id, bank_account_id, amount_cents, posted_on, descriptor, check_no, counterparty, bank_accounts(building_id, account_type)'),
    db.from('leases').select('id, building_id, unit, tenant_name, signed_on, term_start, vacated_on, keys_returned_on, monthly_rent_cents, expected_deposit_cents'),
    db.from('deposit_ledger').select('id, lease_id, entry_type, amount_cents, entry_date'),
    db.from('matches').select('bank_transaction_id, lease_id'),
    db.from('statements').select('bank_account_id, period_start, period_end, opening_balance_cents, closing_balance_cents').eq('checksum_ok', true),
    db.from('buildings').select('id, name, interest_required'),
  ]);
  for (const r of [accountsR, txnsR, leasesR, ledgerR, matchesR, statementsR, buildingsR]) if (r.error) throw r.error;

  const accounts: AccountRef[] = (accountsR.data ?? []).map((a: any) => ({
    id: a.id, buildingId: a.building_id, type: a.account_type, last4: a.account_last4,
    isInterestBearing: !!a.is_interest_bearing,
  }));
  const buildings: BuildingRef[] = (buildingsR.data ?? []).map((b: any) => ({
    id: b.id, name: b.name, interestRequired: !!b.interest_required,
  }));
  const txns: TxnRef[] = (txnsR.data ?? []).map((t: any) => ({
    id: t.id, buildingId: t.bank_accounts?.building_id ?? null, accountId: t.bank_account_id,
    accountType: t.bank_accounts?.account_type ?? 'escrow',
    amountCents: Number(t.amount_cents), postedOn: t.posted_on, descriptor: t.descriptor,
    checkNo: t.check_no, counterparty: t.counterparty,
  }));
  const leases: LeaseRef[] = (leasesR.data ?? []).map((l: any) => ({
    id: l.id, buildingId: l.building_id, unit: l.unit, tenantName: l.tenant_name,
    signedOn: l.signed_on, termStart: l.term_start, vacatedOn: l.vacated_on, keysReturnedOn: l.keys_returned_on,
    monthlyRentCents: Number(l.monthly_rent_cents), expectedDepositCents: Number(l.expected_deposit_cents),
  }));
  const ledger: LedgerRef[] = (ledgerR.data ?? []).map((e: any) => ({
    id: e.id, leaseId: e.lease_id, entryType: e.entry_type, amountCents: Number(e.amount_cents), entryDate: e.entry_date,
  }));
  const matches: MatchRef[] = (matchesR.data ?? []).map((m: any) => ({ bankTransactionId: m.bank_transaction_id, leaseId: m.lease_id }));
  const statements: StatementRef[] = (statementsR.data ?? []).map((s: any) => ({
    bankAccountId: s.bank_account_id, periodStart: s.period_start, periodEnd: s.period_end,
    openingCents: Number(s.opening_balance_cents), closingCents: Number(s.closing_balance_cents),
  }));

  return { accounts, txns, leases, ledger, matches, statements, buildings };
}

export interface DetectRunResult {
  found: number;
  inserted: number;
  byKind: Record<string, number>;
  bySeverity: Record<string, number>;
}

export async function runDetectors(write = true, opts: DetectorOptions = DEFAULT_DETECTOR_OPTS): Promise<DetectRunResult> {
  const ds = await loadDataset();
  const found = runAllDetectors(ds, opts);

  const byKind: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const f of found) {
    byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  }

  let inserted = 0;
  if (write) {
    // Existing signatures, so a re-run does not duplicate a finding.
    const { data: existing } = await db.from('exceptions').select('detail');
    const seen = new Set((existing ?? []).map((e: any) => e.detail?.signature).filter(Boolean));
    for (const f of found) {
      if (seen.has(f.signature)) continue;
      await insert(f);
      inserted++;
    }
  }

  const order = ['critical', 'high', 'medium', 'low'];
  console.log(`detectors: ${found.length} finding(s)` + (write ? `, ${inserted} new` : ' (dry run)'));
  for (const sev of order) if (bySeverity[sev]) console.log(`  ${sev}: ${bySeverity[sev]}`);
  for (const [kind, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`    ${kind}  ${n}`);
  return { found: found.length, inserted, byKind, bySeverity };
}

async function insert(f: Detected): Promise<void> {
  const { error } = await db.from('exceptions').insert({
    kind: f.kind,
    severity: f.severity,
    building_id: f.buildingId ?? null,
    lease_id: f.leaseId ?? null,
    bank_transaction_id: f.bankTransactionId ?? null,
    amount_cents: f.amountCents ?? null,
    detail: { signature: f.signature, ...f.detail },
  });
  if (error) throw error;
}
