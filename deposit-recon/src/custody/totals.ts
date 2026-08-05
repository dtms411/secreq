import type { CustodyRecord } from './parse.js';
import { DEFAULT_CUSTODY_OPTS, type CustodyOptions } from './detectors.js';

// Pure custody roll-ups — no database, so they unit-test directly. The tracker's
// dashboard header (received / in Master / in subaccounts / refund pending) and
// the custody-vs-bank Master reconciliation both live here.

export interface CustodyTotals {
  totalReceivedCents: number;
  inMasterCents: number;
  inSubaccountsCents: number;
  refundPending: number;   // count of records returned/posted but not yet refunded
  refundPendingCents: number;
  closedRecords: number;
  masterAgedOver30: number;
}

function ageDays(iso: string, today: string): number {
  return Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / 86_400_000);
}

/** Pure roll-up of a custody set — the tracker's dashboard header. A deposit's
 *  balance is "in a subaccount" once one is open and the funds are no longer
 *  pooled in Master (amount − in_master). Refunds and closed records drop out of
 *  the held totals. */
export function custodyTotals(records: CustodyRecord[], today: string, o: CustodyOptions = DEFAULT_CUSTODY_OPTS): CustodyTotals {
  let totalReceivedCents = 0, inMasterCents = 0, inSubaccountsCents = 0;
  let refundPending = 0, refundPendingCents = 0, closedRecords = 0, masterAgedOver30 = 0;
  for (const r of records) {
    totalReceivedCents += r.amountCents;
    inMasterCents += r.inMasterCents;
    const hasSub = !!(r.subaccountLast4 || r.subaccountOpenedOn);
    if (hasSub) inSubaccountsCents += Math.max(0, r.amountCents - r.inMasterCents);
    if ((r.stage === 'funds_returned' || r.stage === 'posted') && !r.refundedOn) {
      refundPending++;
      refundPendingCents += r.fundsReturnedCents ?? r.amountCents;
    }
    if (r.stage === 'closed') closedRecords++;
    const since = r.bankClearedOn ?? r.sentToBankOn;
    if (r.inMasterCents > 0 && since && ageDays(since, today) > o.masterAgingDays) masterAgedOver30++;
  }
  return { totalReceivedCents, inMasterCents, inSubaccountsCents, refundPending, refundPendingCents, closedRecords, masterAgedOver30 };
}

export interface CustodyBankRecon {
  custodyMasterCents: number;   // what the tracker claims is pooled in Master
  bankMasterCents: number;      // the Santander Master statement balance
  varianceCents: number;        // bank − custody claim
}

/** Reconcile the tracker's Master-account claim against the actual Santander
 *  Master statement balance. The whole point of keeping custody independent of
 *  the bank: their disagreement is the finding. bank − claimed; a negative
 *  variance means the bank holds LESS than the tracker says is pooled there. */
export function reconcileCustodyToBank(records: CustodyRecord[], bankMasterCents: number): CustodyBankRecon {
  const custodyMasterCents = records.reduce((a, r) => a + r.inMasterCents, 0);
  return { custodyMasterCents, bankMasterCents, varianceCents: bankMasterCents - custodyMasterCents };
}
