import { extractPayer, nameSimilarity, normalizeName } from '../match/rules.js';
import { findContinuityBreaks, type PeriodRow } from '../reports/continuity.js';

// The findings. Each detector is a pure function over a normalized dataset so
// it can be tested with a synthetic positive and negative case, exactly as the
// brief requires. The DB-backed runner (run.ts) loads the dataset once and
// dispatches all of them, then writes the results to `exceptions`.
//
// Ordering here is by value, highest first. A detector never resolves anything
// and never moves money -- it raises a flag with enough detail for a human to
// act. Bank activity and the tenant sub-ledger are independent sources; their
// disagreement is the finding, so detectors read both and assert nothing.

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface Detected {
  kind: string;
  severity: Severity;
  buildingId?: string | null;
  leaseId?: string | null;
  bankTransactionId?: string | null;
  amountCents?: number | null;
  /** Deterministic identity so the runner can insert idempotently. */
  signature: string;
  detail: Record<string, unknown>;
}

export interface AccountRef { id: string; buildingId: string | null; type: 'escrow' | 'operating'; last4: string; isInterestBearing?: boolean; }
export interface BuildingRef { id: string; name: string; interestRequired: boolean; }
export interface TxnRef {
  id: string; buildingId: string | null; accountId: string; accountType: 'escrow' | 'operating';
  amountCents: number; postedOn: string; descriptor: string; checkNo?: string | null; counterparty?: string | null;
}
export interface LeaseRef {
  id: string; buildingId: string; unit: string; tenantName: string;
  signedOn?: string | null; termStart: string; vacatedOn?: string | null; keysReturnedOn?: string | null;
  monthlyRentCents: number; expectedDepositCents: number;
}
export interface LedgerRef { id: string; leaseId: string; entryType: string; amountCents: number; entryDate: string; }
export interface MatchRef { bankTransactionId: string; leaseId: string | null; }
export interface StatementRef { bankAccountId: string; periodStart: string; periodEnd: string; openingCents: number; closingCents: number; }

export interface Dataset {
  accounts: AccountRef[];
  txns: TxnRef[];
  leases: LeaseRef[];
  ledger: LedgerRef[];
  matches: MatchRef[];
  statements: StatementRef[];
  buildings?: BuildingRef[];
}

export interface DetectorOptions {
  bankWithinDays: number;     // move-out proximity for unexplained_debit
  depositWithinDays: number;  // signing -> credit window for deposit_never_banked
  transferWithinDays: number; // pairing window for inter_building_transfer
  payeeThreshold: number;     // name similarity below this = mismatch
  staleAfterDays: number;     // held past this after move-out = stale
}

export const DEFAULT_DETECTOR_OPTS: DetectorOptions = {
  bankWithinDays: 45, depositWithinDays: 30, transferWithinDays: 5, payeeThreshold: 0.4, staleAfterDays: 30,
};

// --------------------------------------------------------------- helpers

function days(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}
function isRefundLike(t: TxnRef): boolean {
  return t.amountCents < 0 && /refund|check\s*paid|return|disburse/i.test(t.descriptor);
}
function isInterest(t: TxnRef): boolean {
  return t.amountCents > 0 && /interest/i.test(t.descriptor);
}
function leaseById(ds: Dataset): Map<string, LeaseRef> {
  return new Map(ds.leases.map(l => [l.id, l]));
}
function leaseForTxn(ds: Dataset, txnId: string): LeaseRef | undefined {
  const m = ds.matches.find(x => x.bankTransactionId === txnId);
  if (!m?.leaseId) return undefined;
  return ds.leases.find(l => l.id === m.leaseId);
}

// ---------------------------------------------------- 1. unexplained_debit (critical)
// An escrow debit with no move-out record it could belong to. A refund leaving
// escrow should correspond to a lease that ended near that date; if none does,
// money left the trust account for no reason on file.
export function unexplainedDebit(ds: Dataset, o: DetectorOptions): Detected[] {
  const out: Detected[] = [];
  for (const t of ds.txns) {
    if (t.accountType !== 'escrow' || !isRefundLike(t)) continue;
    const moveOut = ds.leases.some(l =>
      l.buildingId === t.buildingId &&
      (l.keysReturnedOn || l.vacatedOn) &&
      days((l.keysReturnedOn ?? l.vacatedOn)!, t.postedOn) <= o.bankWithinDays,
    );
    if (!moveOut) {
      out.push({
        kind: 'unexplained_debit', severity: 'critical',
        buildingId: t.buildingId, bankTransactionId: t.id, amountCents: t.amountCents,
        signature: `unexplained_debit:${t.id}`,
        detail: { posted_on: t.postedOn, descriptor: t.descriptor, note: 'no move-out within window' },
      });
    }
  }
  return out;
}

// ---------------------------------------------------- 2. deposit_never_banked (critical)
// A lease was signed but no escrow credit for the deposit shows up within 30
// days. This is the pattern the independent lease universe exists to catch:
// collected, never banked.
export function depositNeverBanked(ds: Dataset, o: DetectorOptions): Detected[] {
  const out: Detected[] = [];
  for (const l of ds.leases) {
    const anchor = l.signedOn ?? l.termStart;
    const banked = ds.txns.some(t =>
      t.accountType === 'escrow' && t.buildingId === l.buildingId &&
      t.amountCents === l.expectedDepositCents &&
      days(t.postedOn, anchor) <= o.depositWithinDays,
    );
    if (!banked) {
      out.push({
        kind: 'deposit_never_banked', severity: 'critical',
        buildingId: l.buildingId, leaseId: l.id, amountCents: l.expectedDepositCents,
        signature: `deposit_never_banked:${l.id}`,
        detail: { unit: l.unit, tenant: l.tenantName, anchor, within_days: o.depositWithinDays },
      });
    }
  }
  return out;
}

// ---------------------------------------------------- 3. refund_payee_mismatch (critical)
// The refund left escrow but the payee is not the tenant of record. Requires a
// lease linkage (an approved or proposed match); without one, refund_payee is
// unknowable and left to matching, not asserted here.
export function refundPayeeMismatch(ds: Dataset, o: DetectorOptions): Detected[] {
  const out: Detected[] = [];
  for (const t of ds.txns) {
    if (!isRefundLike(t)) continue;
    const lease = leaseForTxn(ds, t.id);
    if (!lease) continue;
    const payee = t.counterparty ? normalizeName(t.counterparty) : extractPayer(t.descriptor);
    if (!payee) continue;
    const sim = nameSimilarity(payee, lease.tenantName);
    if (sim < o.payeeThreshold) {
      out.push({
        kind: 'refund_payee_mismatch', severity: 'critical',
        buildingId: t.buildingId, leaseId: lease.id, bankTransactionId: t.id, amountCents: t.amountCents,
        signature: `refund_payee_mismatch:${t.id}`,
        detail: { payee, tenant_of_record: lease.tenantName, similarity: Number(sim.toFixed(3)) },
      });
    }
  }
  return out;
}

// ---------------------------------------------------- 4. refund_without_vacate (high)
// A refund for a tenant who never vacated and never returned keys.
export function refundWithoutVacate(ds: Dataset, _o: DetectorOptions): Detected[] {
  const out: Detected[] = [];
  for (const t of ds.txns) {
    if (!isRefundLike(t)) continue;
    const lease = leaseForTxn(ds, t.id);
    if (!lease) continue;
    if (!lease.vacatedOn && !lease.keysReturnedOn) {
      out.push({
        kind: 'refund_without_vacate', severity: 'high',
        buildingId: t.buildingId, leaseId: lease.id, bankTransactionId: t.id, amountCents: t.amountCents,
        signature: `refund_without_vacate:${t.id}`,
        detail: { tenant: lease.tenantName, posted_on: t.postedOn },
      });
    }
  }
  return out;
}

// ---------------------------------------------------- 5. duplicate_refund (high)
// Two or more refunds against the same lease.
export function duplicateRefund(ds: Dataset, _o: DetectorOptions): Detected[] {
  const byLease = new Map<string, TxnRef[]>();
  for (const t of ds.txns) {
    if (!isRefundLike(t)) continue;
    const lease = leaseForTxn(ds, t.id);
    if (!lease) continue;
    (byLease.get(lease.id) ?? byLease.set(lease.id, []).get(lease.id)!).push(t);
  }
  const out: Detected[] = [];
  for (const [leaseId, txns] of byLease) {
    if (txns.length < 2) continue;
    const total = txns.reduce((a, t) => a + t.amountCents, 0);
    out.push({
      kind: 'duplicate_refund', severity: 'high',
      buildingId: txns[0].buildingId, leaseId, amountCents: total,
      signature: `duplicate_refund:${leaseId}`,
      detail: { count: txns.length, transaction_ids: txns.map(t => t.id), posted: txns.map(t => t.postedOn) },
    });
  }
  return out;
}

// ---------------------------------------------------- 6. escrow_to_operating (high)
// A transfer out of escrow into a non-escrow (operating) account. Trust funds
// must not fund operations.
export function escrowToOperating(ds: Dataset, _o: DetectorOptions): Detected[] {
  const operatingLast4 = new Set(ds.accounts.filter(a => a.type === 'operating').map(a => a.last4));
  const out: Detected[] = [];
  for (const t of ds.txns) {
    if (t.accountType !== 'escrow' || t.amountCents >= 0) continue;
    const toOperating =
      /transfer|xfer|to\s+oper|to\s+dda|to\s+checking/i.test(t.descriptor) ||
      (t.counterparty ? [...operatingLast4].some(l => t.counterparty!.includes(l)) : false);
    if (toOperating) {
      out.push({
        kind: 'escrow_to_operating', severity: 'high',
        buildingId: t.buildingId, bankTransactionId: t.id, amountCents: t.amountCents,
        signature: `escrow_to_operating:${t.id}`,
        detail: { descriptor: t.descriptor, counterparty: t.counterparty ?? null },
      });
    }
  }
  return out;
}

// ---------------------------------------------------- 7. inter_building_transfer (high)
// A debit in one building's escrow paired with a credit of the same amount in
// another building's escrow shortly after -- classic lapping, plugging one
// account's shortfall with another's funds.
export function interBuildingTransfer(ds: Dataset, o: DetectorOptions): Detected[] {
  const escrow = ds.txns.filter(t => t.accountType === 'escrow');
  const debits = escrow.filter(t => t.amountCents < 0);
  const credits = escrow.filter(t => t.amountCents > 0);
  const out: Detected[] = [];
  const usedCredit = new Set<string>();
  for (const d of debits) {
    const match = credits.find(c =>
      !usedCredit.has(c.id) &&
      c.buildingId !== d.buildingId &&
      c.amountCents === -d.amountCents &&
      days(c.postedOn, d.postedOn) <= o.transferWithinDays,
    );
    if (match) {
      usedCredit.add(match.id);
      out.push({
        kind: 'inter_building_transfer', severity: 'high',
        buildingId: d.buildingId, bankTransactionId: d.id, amountCents: d.amountCents,
        signature: `inter_building_transfer:${d.id}:${match.id}`,
        detail: {
          from_building: d.buildingId, to_building: match.buildingId,
          debit_txn: d.id, credit_txn: match.id, amount_cents: -d.amountCents,
          debit_on: d.postedOn, credit_on: match.postedOn,
        },
      });
    }
  }
  return out;
}

// ---------------------------------------------------- 8. interest_not_allocated (medium)
// Bank interest posted to escrow but never credited to any tenant sub-ledger.
// GOL §7-103 makes the interest the tenant's (less the 1% admin fee).
export function interestNotAllocated(ds: Dataset, _o: DetectorOptions): Detected[] {
  const out: Detected[] = [];
  const allocatedByBuilding = new Map<string, number>();
  const byLease = leaseById(ds);
  for (const e of ds.ledger) {
    if (e.entryType !== 'interest_credit') continue;
    const l = byLease.get(e.leaseId);
    if (!l) continue;
    allocatedByBuilding.set(l.buildingId, (allocatedByBuilding.get(l.buildingId) ?? 0) + e.amountCents);
  }
  for (const t of ds.txns) {
    if (t.accountType !== 'escrow' || !isInterest(t)) continue;
    const allocated = allocatedByBuilding.get(t.buildingId ?? '') ?? 0;
    if (allocated <= 0) {
      out.push({
        kind: 'interest_not_allocated', severity: 'medium',
        buildingId: t.buildingId, bankTransactionId: t.id, amountCents: t.amountCents,
        signature: `interest_not_allocated:${t.id}`,
        detail: { posted_on: t.postedOn, bank_interest_cents: t.amountCents, allocated_cents: allocated },
      });
    }
  }
  return out;
}

// ---------------------------------------------------- 9. deposit_exceeds_one_month (medium)
// GOL §7-108 caps a security deposit at one month's rent.
export function depositExceedsOneMonth(ds: Dataset, _o: DetectorOptions): Detected[] {
  const out: Detected[] = [];
  for (const l of ds.leases) {
    if (l.expectedDepositCents > l.monthlyRentCents) {
      out.push({
        kind: 'deposit_exceeds_one_month', severity: 'medium',
        buildingId: l.buildingId, leaseId: l.id, amountCents: l.expectedDepositCents - l.monthlyRentCents,
        signature: `deposit_exceeds_one_month:${l.id}`,
        detail: { deposit_cents: l.expectedDepositCents, monthly_rent_cents: l.monthlyRentCents },
      });
    }
  }
  return out;
}

// ---------------------------------------------------- 10. stale_credit (medium)
// A tenant has vacated/returned keys but the sub-ledger still holds a balance
// well past the point it should have been refunded.
export function staleCredit(ds: Dataset, o: DetectorOptions): Detected[] {
  const balByLease = new Map<string, number>();
  for (const e of ds.ledger) balByLease.set(e.leaseId, (balByLease.get(e.leaseId) ?? 0) + e.amountCents);
  const out: Detected[] = [];
  const asOf = ds.statements.reduce((m, s) => (s.periodEnd > m ? s.periodEnd : m), '0000-00-00');
  for (const l of ds.leases) {
    const gone = l.keysReturnedOn ?? l.vacatedOn;
    if (!gone) continue;
    const bal = balByLease.get(l.id) ?? 0;
    if (bal > 0 && asOf !== '0000-00-00' && days(asOf, gone) > o.staleAfterDays) {
      out.push({
        kind: 'stale_credit', severity: 'medium',
        buildingId: l.buildingId, leaseId: l.id, amountCents: bal,
        signature: `stale_credit:${l.id}`,
        detail: { tenant: l.tenantName, gone_on: gone, held_cents: bal, as_of: asOf },
      });
    }
  }
  return out;
}

// ---------------------------------------------------- 11. missing_statement_period (medium)
// A gap in the statement series, per account. Delegates to the same continuity
// logic the backfill uses, so a gap is reported once, consistently.
export function missingStatementPeriod(ds: Dataset, _o: DetectorOptions): Detected[] {
  const byAccount = new Map<string, PeriodRow[]>();
  for (const s of ds.statements) {
    const rows = byAccount.get(s.bankAccountId) ?? byAccount.set(s.bankAccountId, []).get(s.bankAccountId)!;
    rows.push({ periodStart: s.periodStart, periodEnd: s.periodEnd, openingCents: s.openingCents, closingCents: s.closingCents });
  }
  const out: Detected[] = [];
  const buildingOf = new Map(ds.accounts.map(a => [a.id, a.buildingId]));
  for (const [accountId, rows] of byAccount) {
    for (const b of findContinuityBreaks(rows)) {
      out.push({
        kind: 'missing_statement_period', severity: 'medium',
        buildingId: buildingOf.get(accountId) ?? null, amountCents: b.gapCents ?? null,
        signature: `missing_statement_period:${accountId}:${b.kind}:${b.afterPeriodEnd}:${b.nextPeriodStart}`,
        detail: { account_id: accountId, break_kind: b.kind, message: b.detail },
      });
    }
  }
  return out;
}

// ---------------------------------------------------- 12. interest_account_noncompliant (high)
// GOL §7-103: a building of 6+ dwelling units must hold deposits in an
// interest-bearing NY account. An escrow account for such a building that is not
// interest-bearing is a statutory violation for the whole building.
export function interestAccountNoncompliant(ds: Dataset, _o: DetectorOptions): Detected[] {
  const escrowByBuilding = new Map<string, AccountRef[]>();
  for (const a of ds.accounts) {
    if (a.type !== 'escrow' || !a.buildingId) continue;
    (escrowByBuilding.get(a.buildingId) ?? escrowByBuilding.set(a.buildingId, []).get(a.buildingId)!).push(a);
  }
  const out: Detected[] = [];
  for (const b of ds.buildings ?? []) {
    if (!b.interestRequired) continue;
    const accts = escrowByBuilding.get(b.id) ?? [];
    if (accts.length && !accts.some(a => a.isInterestBearing)) {
      out.push({
        kind: 'interest_account_noncompliant', severity: 'high',
        buildingId: b.id,
        signature: `interest_account_noncompliant:${b.id}`,
        detail: { building: b.name, note: 'GOL §7-103: 6+ units requires an interest-bearing account', accounts: accts.map(a => a.last4) },
      });
    }
  }
  return out;
}

export type Detector = (ds: Dataset, o: DetectorOptions) => Detected[];

/** In value order, highest first. */
export const DETECTORS: Detector[] = [
  unexplainedDebit,
  depositNeverBanked,
  refundPayeeMismatch,
  refundWithoutVacate,
  duplicateRefund,
  escrowToOperating,
  interBuildingTransfer,
  interestNotAllocated,
  depositExceedsOneMonth,
  staleCredit,
  missingStatementPeriod,
  interestAccountNoncompliant,
];

export function runAllDetectors(ds: Dataset, o: DetectorOptions = DEFAULT_DETECTOR_OPTS): Detected[] {
  return DETECTORS.flatMap(d => d(ds, o));
}
