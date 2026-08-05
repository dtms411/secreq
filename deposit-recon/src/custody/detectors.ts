// Custody-side detectors — the operational-lifecycle findings the office
// tracker was built to surface. Where the reconciliation detectors ask "does
// the bank agree with the leases", these ask "is any deposit STUCK in its
// journey": collected but not banked, cleared but still pooled in the Santander
// Master account, allocated late, returned by the bank but never refunded to
// the tenant.
//
// Same discipline as the reconciliation detectors: each is a PURE function over
// a normalized CustodyRecord[] plus a `today`, so it tests with a synthetic
// positive and negative case. A detector never advances a stage and never moves
// money — it raises a flag with enough detail for a human to act. The findings
// share the `exceptions` shape (kind/severity/building/lease/detail/signature)
// so the same triage queue and idempotent-insert path carry them.
//
// Independence note: custody records are the office's CLAIMS about where each
// deposit is. They are reconciled AGAINST the bank (see run.ts), never
// substituted for the independent lease universe.

import type { CustodyRecord, CustodyStage } from './parse.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface CustodyFinding {
  kind: string;
  severity: Severity;
  buildingId?: string | null;
  leaseId?: string | null;
  amountCents?: number | null;
  /** Deterministic identity so the runner inserts idempotently. */
  signature: string;
  detail: Record<string, unknown>;
}

export interface CustodyOptions {
  masterAgingDays: number;    // dollars sitting in Master beyond this = float
  bankingDays: number;        // received -> sent to bank beyond this = not banked
  subaccountOpenDays: number; // cleared -> per-tenant subaccount opened
  allocationDays: number;     // in Master with a subaccount -> allocated
  refundDays: number;         // funds back from bank -> refunded to tenant (statutory 14)
  vacateCloseDays: number;    // vacated -> subaccount closed / disposed
}

export const DEFAULT_CUSTODY_OPTS: CustodyOptions = {
  masterAgingDays: 30,
  bankingDays: 5,
  subaccountOpenDays: 30,
  allocationDays: 30,
  refundDays: 14,
  vacateCloseDays: 45,
};

// --------------------------------------------------------------- helpers

/** Signed whole days from `iso` to `today` (positive = in the past). UTC,
 *  date-only, so it never drifts with the host timezone. */
function ageDays(iso: string, today: string): number {
  return Math.floor(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / 86_400_000,
  );
}

/** Stable identity for a record even before it has a DB id: the source
 *  tracker's own key if present, else the natural key. Keeps signatures
 *  deterministic so a re-run does not duplicate a finding. */
function key(r: CustodyRecord): string {
  return (
    r.externalRef?.trim() ||
    [r.buildingKey, r.unit, r.tenantName, r.kind, r.receivedOn ?? '?'].join('|')
  );
}

/** The date a deposit became the bank's (and the Master aging clock started):
 *  when it cleared, or failing that when it was sent. */
function inMasterSince(r: CustodyRecord): string | null {
  return r.bankClearedOn ?? r.sentToBankOn ?? null;
}

const OPEN_SUBACCOUNT_STAGES: CustodyStage[] = [
  'in_subaccount', 'active', 'subaccount_pending',
];

// ------------------------------------------------ 1. master_account_float (high)
// Money that cleared the bank but is still pooled in the Santander Master
// account past the aging threshold. This is the tracker's headline control:
// funds must be allocated out of Master into the tenant's own subaccount
// promptly. The longer it lingers commingled, the weaker the trust segregation.
export function masterAccountFloat(records: CustodyRecord[], today: string, o: CustodyOptions): CustodyFinding[] {
  const out: CustodyFinding[] = [];
  for (const r of records) {
    if (r.inMasterCents <= 0) continue;
    const since = inMasterSince(r);
    if (!since) continue;
    const age = ageDays(since, today);
    if (age > o.masterAgingDays) {
      out.push({
        kind: 'master_account_float',
        severity: age > o.masterAgingDays * 3 ? 'critical' : 'high',
        buildingId: r.buildingId ?? null, leaseId: r.leaseId ?? null,
        amountCents: r.inMasterCents,
        signature: `master_account_float:${key(r)}`,
        detail: {
          unit: r.unit, tenant: r.tenantName, in_master_cents: r.inMasterCents,
          since, days_in_master: age, threshold_days: o.masterAgingDays,
          responsible_employee: r.responsibleEmployee ?? null,
        },
      });
    }
  }
  return out;
}

// ------------------------------------------------ 2. deposit_not_sent_to_bank (high)
// A deposit was received from the tenant but never sent to the bank within the
// banking window. Cash-in-hand that never reached the trust account — the
// operational front end of "deposit_never_banked".
export function depositNotSentToBank(records: CustodyRecord[], today: string, o: CustodyOptions): CustodyFinding[] {
  const out: CustodyFinding[] = [];
  for (const r of records) {
    if (!r.receivedOn || r.sentToBankOn) continue;
    const age = ageDays(r.receivedOn, today);
    if (age > o.bankingDays) {
      out.push({
        kind: 'deposit_not_sent_to_bank', severity: 'high',
        buildingId: r.buildingId ?? null, leaseId: r.leaseId ?? null,
        amountCents: r.amountCents,
        signature: `deposit_not_sent_to_bank:${key(r)}`,
        detail: {
          unit: r.unit, tenant: r.tenantName, amount_cents: r.amountCents,
          received_on: r.receivedOn, days_held: age, threshold_days: o.bankingDays,
          stage: r.stage, responsible_employee: r.responsibleEmployee ?? null,
        },
      });
    }
  }
  return out;
}

// ------------------------------------------------ 3. subaccount_not_opened (high)
// The deposit cleared into the Master account but no per-tenant subaccount was
// ever opened for it. Without its own subaccount the deposit stays commingled
// with every other tenant's — the exact condition the control system exists to
// eliminate.
export function subaccountNotOpened(records: CustodyRecord[], today: string, o: CustodyOptions): CustodyFinding[] {
  const out: CustodyFinding[] = [];
  for (const r of records) {
    if (!r.bankClearedOn) continue;
    const hasSub = !!(r.subaccountLast4 || r.subaccountOpenedOn);
    if (hasSub) continue;
    const age = ageDays(r.bankClearedOn, today);
    if (age > o.subaccountOpenDays) {
      out.push({
        kind: 'subaccount_not_opened', severity: 'high',
        buildingId: r.buildingId ?? null, leaseId: r.leaseId ?? null,
        amountCents: r.amountCents,
        signature: `subaccount_not_opened:${key(r)}`,
        detail: {
          unit: r.unit, tenant: r.tenantName, amount_cents: r.amountCents,
          bank_cleared_on: r.bankClearedOn, days_since_cleared: age,
          threshold_days: o.subaccountOpenDays, stage: r.stage,
        },
      });
    }
  }
  return out;
}

// ------------------------------------------------ 4. allocation_pending (medium)
// A subaccount exists but funds are still sitting in Master rather than moved
// into it — the allocation step was started and not finished. Distinct from
// master_account_float (which fires when there is no subaccount yet) — here the
// account is open, so this is a bookkeeping loose end, not a segregation gap.
export function allocationPending(records: CustodyRecord[], today: string, o: CustodyOptions): CustodyFinding[] {
  const out: CustodyFinding[] = [];
  for (const r of records) {
    if (r.inMasterCents <= 0) continue;
    const hasSub = !!(r.subaccountLast4 || r.subaccountOpenedOn);
    if (!hasSub) continue; // no subaccount yet -> master_account_float owns it
    const since = r.subaccountOpenedOn ?? inMasterSince(r);
    const age = since ? ageDays(since, today) : null;
    if (age === null || age > o.allocationDays) {
      out.push({
        kind: 'allocation_pending', severity: 'medium',
        buildingId: r.buildingId ?? null, leaseId: r.leaseId ?? null,
        amountCents: r.inMasterCents,
        signature: `allocation_pending:${key(r)}`,
        detail: {
          unit: r.unit, tenant: r.tenantName, in_master_cents: r.inMasterCents,
          subaccount_last4: r.subaccountLast4 ?? null,
          subaccount_opened_on: r.subaccountOpenedOn ?? null,
          days_pending: age, threshold_days: o.allocationDays,
        },
      });
    }
  }
  return out;
}

// ------------------------------------------------ 5. funds_returned_not_refunded (critical)
// The bank returned the funds (subaccount closed on move-out) but the office
// never refunded the tenant. Money is back in the firm's hands and the statutory
// 14-day refund clock (GOL §7-108) is running or blown. This is the operational
// twin of a stale credit, and it is money the tenant is owed.
export function fundsReturnedNotRefunded(records: CustodyRecord[], today: string, o: CustodyOptions): CustodyFinding[] {
  const out: CustodyFinding[] = [];
  for (const r of records) {
    if (!r.fundsReturnedOn || r.refundedOn) continue;
    const age = ageDays(r.fundsReturnedOn, today);
    const owed = r.fundsReturnedCents ?? r.amountCents;
    out.push({
      kind: 'funds_returned_not_refunded',
      severity: age > o.refundDays ? 'critical' : 'high',
      buildingId: r.buildingId ?? null, leaseId: r.leaseId ?? null,
      amountCents: owed,
      signature: `funds_returned_not_refunded:${key(r)}`,
      detail: {
        unit: r.unit, tenant: r.tenantName, funds_returned_cents: owed,
        funds_returned_on: r.fundsReturnedOn, days_since_return: age,
        statutory_days: o.refundDays, overdue: age > o.refundDays, stage: r.stage,
      },
    });
  }
  return out;
}

// ------------------------------------------------ 6. vacated_subaccount_open (medium)
// The tenant has vacated but their subaccount is still open and undisposed well
// past the point it should have been closed and refunded. The custody-side view
// of a deposit that should have left the building.
export function vacatedSubaccountOpen(records: CustodyRecord[], today: string, o: CustodyOptions): CustodyFinding[] {
  const out: CustodyFinding[] = [];
  for (const r of records) {
    if (!r.vacateDate) continue;
    if (r.refundedOn || r.stage === 'closed' || r.stage === 'refunded') continue;
    const stillOpen = !r.bankAccountClosedOn && OPEN_SUBACCOUNT_STAGES.includes(r.stage);
    if (!stillOpen) continue;
    const age = ageDays(r.vacateDate, today);
    if (age > o.vacateCloseDays) {
      out.push({
        kind: 'vacated_subaccount_open', severity: 'medium',
        buildingId: r.buildingId ?? null, leaseId: r.leaseId ?? null,
        amountCents: r.amountCents,
        signature: `vacated_subaccount_open:${key(r)}`,
        detail: {
          unit: r.unit, tenant: r.tenantName, vacate_date: r.vacateDate,
          days_since_vacate: age, threshold_days: o.vacateCloseDays,
          subaccount_last4: r.subaccountLast4 ?? null, stage: r.stage,
        },
      });
    }
  }
  return out;
}

export type CustodyDetector = (records: CustodyRecord[], today: string, o: CustodyOptions) => CustodyFinding[];

/** In value order, highest first. */
export const CUSTODY_DETECTORS: CustodyDetector[] = [
  fundsReturnedNotRefunded,
  masterAccountFloat,
  depositNotSentToBank,
  subaccountNotOpened,
  allocationPending,
  vacatedSubaccountOpen,
];

export function runCustodyDetectors(
  records: CustodyRecord[],
  today: string,
  o: CustodyOptions = DEFAULT_CUSTODY_OPTS,
): CustodyFinding[] {
  return CUSTODY_DETECTORS.flatMap(d => d(records, today, o));
}
