import { db } from '../db.js';
import { classify, DEFAULT_OPTS, type MatchOptions, type TxnLike, type LedgerLike, type LeaseLike } from './rules.js';

// Runs the tiered matcher over every unmatched bank transaction, building by
// building, and writes proposals to `matches` with decided_by = null. It never
// decides. Transactions with no proposal are recorded as `unmatched`
// exceptions so nothing silently disappears.
//
// Candidates are scoped to the transaction's own building: a deposit is
// matched against that building's leases and ledger only. Cross-building
// movement is a finding (inter_building_transfer), not a match.

export interface MatchRunResult {
  considered: number;
  exact: number;
  fuzzy: number;
  unmatched: number;
}

export async function runMatching(opts: MatchOptions = DEFAULT_OPTS): Promise<MatchRunResult> {
  // Only transactions without an existing match are considered, so the runner
  // is safe to re-run: an approved match is never overwritten.
  const { data: txns, error: txnErr } = await db
    .from('bank_transactions')
    .select('id, amount_cents, posted_on, descriptor, check_no, bank_account_id, bank_accounts(building_id)')
    .order('posted_on');
  if (txnErr) throw txnErr;

  const { data: matched } = await db.from('matches').select('bank_transaction_id');
  const already = new Set((matched ?? []).map((m: any) => m.bank_transaction_id));

  // Existing `unmatched` exceptions, so a re-run does not record the same
  // unmatched transaction twice (an unmatched txn never gets a `matches` row,
  // so `already` alone would let it re-fire every run).
  const { data: unmatchedEx } = await db
    .from('exceptions').select('bank_transaction_id').eq('kind', 'unmatched');
  const unmatchedSeen = new Set((unmatchedEx ?? []).map((e: any) => e.bank_transaction_id));

  // Preload ledger + leases per building on demand.
  const ledgerByBuilding = new Map<string, LedgerLike[]>();
  const leasesByBuilding = new Map<string, LeaseLike[]>();

  async function ledgerFor(buildingId: string): Promise<LedgerLike[]> {
    if (ledgerByBuilding.has(buildingId)) return ledgerByBuilding.get(buildingId)!;
    const { data } = await db
      .from('deposit_ledger')
      .select('id, lease_id, amount_cents, entry_date, note, leases!inner(building_id)')
      .eq('leases.building_id', buildingId);
    const rows: LedgerLike[] = (data ?? []).map((r: any) => ({
      id: r.id, leaseId: r.lease_id, amountCents: Number(r.amount_cents), entryDate: r.entry_date, note: r.note,
    }));
    ledgerByBuilding.set(buildingId, rows);
    return rows;
  }
  async function leasesFor(buildingId: string): Promise<LeaseLike[]> {
    if (leasesByBuilding.has(buildingId)) return leasesByBuilding.get(buildingId)!;
    const { data } = await db
      .from('leases')
      .select('id, tenant_name, expected_deposit_cents')
      .eq('building_id', buildingId);
    const rows: LeaseLike[] = (data ?? []).map((r: any) => ({
      id: r.id, tenantName: r.tenant_name, expectedDepositCents: Number(r.expected_deposit_cents),
    }));
    leasesByBuilding.set(buildingId, rows);
    return rows;
  }

  const result: MatchRunResult = { considered: 0, exact: 0, fuzzy: 0, unmatched: 0 };

  for (const t of (txns ?? []) as any[]) {
    if (already.has(t.id)) continue;
    const buildingId = t.bank_accounts?.building_id;
    if (!buildingId) continue;
    result.considered++;

    const txn: TxnLike = {
      id: t.id, amountCents: Number(t.amount_cents), postedOn: t.posted_on,
      descriptor: t.descriptor, checkNo: t.check_no,
    };
    const proposal = classify(txn, await ledgerFor(buildingId), await leasesFor(buildingId), opts);

    if (!proposal) {
      result.unmatched++;
      if (unmatchedSeen.has(t.id)) continue; // already recorded on a prior run
      unmatchedSeen.add(t.id);
      await db.from('exceptions').insert({
        kind: 'unmatched',
        severity: 'low',
        building_id: buildingId,
        bank_transaction_id: t.id,
        amount_cents: txn.amountCents,
        detail: { signature: `unmatched:${t.id}`, descriptor: txn.descriptor, posted_on: txn.postedOn, reason: 'no exact or fuzzy candidate' },
      });
      continue;
    }

    await db.from('matches').insert({
      bank_transaction_id: t.id,
      deposit_ledger_id: proposal.ledgerId ?? null,
      lease_id: proposal.leaseId,
      method: proposal.method,
      confidence: proposal.confidence,
      decided_by: null,           // a human sets this; nothing counts until then
    });
    if (proposal.method === 'exact') result.exact++; else result.fuzzy++;
  }

  const autoRate = result.considered ? (result.exact + result.fuzzy) / result.considered : 0;
  console.log(
    `matching: ${result.considered} considered — ` +
    `${result.exact} exact, ${result.fuzzy} fuzzy, ${result.unmatched} unmatched  ` +
    `(auto ${(autoRate * 100).toFixed(1)}%, all pending human approval)`,
  );
  if (autoRate > 0.85 && result.considered >= 20) {
    console.log('  ⚠ auto-match rate over 85% this early — review the rules for over-matching before approving.');
  }
  return result;
}
