import { parse } from 'csv-parse/sync';
import { toCents, ParseError } from '../parsers/types.js';

// Parser for the office's Tenant Security Deposit Control tracker export. The
// tracker is an operational spreadsheet: one row per deposit, tracking its
// journey from received -> sent to bank -> cleared -> Master (pooled) ->
// per-tenant subaccount -> (on move-out) returned -> refunded -> closed.
//
// This is a custody SOURCE, ingested through a stable column map exactly like
// leases. It is NOT the lease universe: the tie-out keeps its power only because
// bank, sub-ledger, and lease files are independent. Custody rows are the
// office's claims about where each deposit is; they are reconciled against the
// bank, never merged into the baseline.

export type CustodyStage =
  | 'received' | 'sent_to_bank' | 'bank_cleared' | 'in_master' | 'subaccount_pending'
  | 'in_subaccount' | 'active' | 'vacated' | 'bank_closing' | 'funds_returned'
  | 'posted' | 'refunded' | 'closed';

const STAGES = new Set<string>([
  'received', 'sent_to_bank', 'bank_cleared', 'in_master', 'subaccount_pending',
  'in_subaccount', 'active', 'vacated', 'bank_closing', 'funds_returned',
  'posted', 'refunded', 'closed',
]);

export type DepositKind = 'initial' | 'additional';

// Normalized record. Money is always integer cents; dates are ISO YYYY-MM-DD or
// undefined. buildingId/leaseId are resolved later by the loader (against the
// independent buildings + leases), never guessed by the parser.
export interface CustodyRecord {
  externalRef?: string | null;   // the tracker's own row id/key
  buildingKey: string;           // matched to buildings.name/bbl by the loader
  buildingId?: string | null;
  leaseId?: string | null;
  unit: string;
  tenantName: string;
  kind: DepositKind;
  amountCents: number;

  receivedOn?: string | null;
  sentToBankOn?: string | null;
  bankClearedOn?: string | null;

  inMasterCents: number;         // unallocated, still pooled in Master
  subaccountLast4?: string | null;
  subaccountOpenedOn?: string | null;
  allocatedOn?: string | null;

  stage: CustodyStage;
  responsibleEmployee?: string | null;
  nextAction?: string | null;

  // per-tenant bank ↔ accounting reconciliation (independently entered)
  bankBalanceCents?: number | null;        // what the bank statement shows
  accountingBalanceCents?: number | null;  // what the books say should be there
  balanceAsOf?: string | null;

  vacateDate?: string | null;
  bankAccountClosedOn?: string | null;
  fundsReturnedOn?: string | null;
  fundsReturnedCents?: number | null;
  refundedOn?: string | null;
  refundedCents?: number | null;
  finalStatus?: string | null;
}

export interface CustodyParseResult {
  records: CustodyRecord[];
  problems: { line: number; reason: string }[];
  notes: { line: number; note: string }[];
}

export interface CustodyColumnMap {
  externalRef?: string;
  buildingKey: string;
  unit: string;
  tenantName: string;
  kind?: string;
  amount: string;
  receivedOn?: string;
  sentToBankOn?: string;
  bankClearedOn?: string;
  inMaster?: string;
  subaccountLast4?: string;
  subaccountOpenedOn?: string;
  allocatedOn?: string;
  stage?: string;
  responsibleEmployee?: string;
  nextAction?: string;
  bankBalance?: string;
  accountingBalance?: string;
  balanceAsOf?: string;
  vacateDate?: string;
  bankAccountClosedOn?: string;
  fundsReturnedOn?: string;
  fundsReturned?: string;
  refundedOn?: string;
  refunded?: string;
  finalStatus?: string;
}

function optDate(raw: string | undefined): string | undefined {
  const t = (raw ?? '').trim();
  if (!t || /^(n\/?a|none|-|—|pending|tbd)$/i.test(t)) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const p = t.split(/[\/\-.]/);
  if (p.length === 3) {
    let [mm, dd, yy] = p;
    if (yy.length === 2) yy = `20${yy}`;
    return `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  throw new ParseError(`unparseable date: ${raw}`);
}

/** Money that may be blank/"—" (an optional cents column). Blank -> 0. */
function optCents(raw: string | undefined): number {
  const t = (raw ?? '').trim();
  if (!t || /^(n\/?a|none|-|—)$/i.test(t)) return 0;
  return toCents(t);
}

/** Money column that is absent when blank (not zero) — for the bank / accounting
 *  balances, where "not entered yet" must stay distinct from "$0.00". */
function optCentsOrNull(raw: string | undefined): number | null {
  const t = (raw ?? '').trim();
  if (!t || /^(n\/?a|none|-|—|pending|tbd)$/i.test(t)) return null;
  return toCents(t);
}

function normStage(raw: string | undefined): CustodyStage {
  const t = (raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (STAGES.has(t)) return t as CustodyStage;
  // A few friendly aliases the tracker uses for the same states.
  const alias: Record<string, CustodyStage> = {
    in_master_account: 'in_master', master: 'in_master', pooled: 'in_master',
    pending_subaccount: 'subaccount_pending', awaiting_subaccount: 'subaccount_pending',
    subaccount: 'in_subaccount', allocated: 'in_subaccount', segregated: 'in_subaccount',
    returned: 'funds_returned', closed_out: 'closed', complete: 'closed',
    deposited: 'sent_to_bank', cleared: 'bank_cleared',
  };
  return alias[t] ?? 'received';
}

function normKind(raw: string | undefined): DepositKind {
  return /add|top|extra|additional/i.test((raw ?? '').trim()) ? 'additional' : 'initial';
}

export function parseCustody(text: string, cm: CustodyColumnMap): CustodyParseResult {
  const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  const records: CustodyRecord[] = [];
  const problems: { line: number; reason: string }[] = [];
  const notes: { line: number; note: string }[] = [];

  rows.forEach((row, i) => {
    const line = i + 2; // header is line 1
    const get = (k?: string) => (k ? (row[k] ?? '').trim() : '');
    try {
      const buildingKey = get(cm.buildingKey);
      const unit = get(cm.unit);
      const tenantName = get(cm.tenantName);
      if (!buildingKey || !unit || !tenantName) throw new ParseError('missing building, unit, or tenant');

      const amountCents = toCents(get(cm.amount));
      if (amountCents <= 0) throw new ParseError('deposit amount must be positive');

      const inMasterCents = optCents(get(cm.inMaster));
      if (inMasterCents < 0) throw new ParseError('in-master amount cannot be negative');
      if (inMasterCents > amountCents) {
        notes.push({ line, note: `in-master ${inMasterCents}c exceeds the deposit ${amountCents}c — verify` });
      }

      const receivedOn = optDate(get(cm.receivedOn));
      const sentToBankOn = optDate(get(cm.sentToBankOn));
      const bankClearedOn = optDate(get(cm.bankClearedOn));
      if (sentToBankOn && receivedOn && sentToBankOn < receivedOn) {
        notes.push({ line, note: `sent to bank (${sentToBankOn}) before received (${receivedOn}) — verify` });
      }

      records.push({
        externalRef: get(cm.externalRef) || undefined,
        buildingKey, unit, tenantName,
        kind: normKind(get(cm.kind)),
        amountCents,
        receivedOn, sentToBankOn, bankClearedOn,
        inMasterCents,
        subaccountLast4: get(cm.subaccountLast4) || undefined,
        subaccountOpenedOn: optDate(get(cm.subaccountOpenedOn)),
        allocatedOn: optDate(get(cm.allocatedOn)),
        stage: normStage(get(cm.stage)),
        responsibleEmployee: get(cm.responsibleEmployee) || undefined,
        nextAction: get(cm.nextAction) || undefined,
        bankBalanceCents: cm.bankBalance ? optCentsOrNull(get(cm.bankBalance)) : undefined,
        accountingBalanceCents: cm.accountingBalance ? optCentsOrNull(get(cm.accountingBalance)) : undefined,
        balanceAsOf: optDate(get(cm.balanceAsOf)),
        vacateDate: optDate(get(cm.vacateDate)),
        bankAccountClosedOn: optDate(get(cm.bankAccountClosedOn)),
        fundsReturnedOn: optDate(get(cm.fundsReturnedOn)),
        fundsReturnedCents: cm.fundsReturned && get(cm.fundsReturned) ? optCents(get(cm.fundsReturned)) : undefined,
        refundedOn: optDate(get(cm.refundedOn)),
        refundedCents: cm.refunded && get(cm.refunded) ? optCents(get(cm.refunded)) : undefined,
        finalStatus: get(cm.finalStatus) || undefined,
      });
    } catch (e) {
      problems.push({ line, reason: (e as Error).message });
    }
  });

  return { records, problems, notes };
}
