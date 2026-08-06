// Shared custody types + pure roll-ups for the review UI. Mirrors the CLI's
// integer-cents rule: money is always an integer number of cents, parsed from
// the user's dollar input with no float arithmetic. The roll-ups let the demo
// dashboard recompute live from the editable records, so an edit on the site is
// reflected in the tiles and aging immediately (real mode reads the DB views).

export const STAGES = [
  'received', 'sent_to_bank', 'bank_cleared', 'in_master', 'subaccount_pending',
  'in_subaccount', 'active', 'vacated', 'bank_closing', 'funds_returned',
  'posted', 'refunded', 'closed',
] as const;
export type Stage = (typeof STAGES)[number];

export const AGE_LIMIT = 30; // days a deposit may sit in Master before it ages

// DB row shape (snake_case, as Supabase returns it). Edits map straight to columns.
export interface CustodyRow {
  id: string;
  building_id: string | null;
  building?: string | null;   // display label (demo, or joined name)
  unit: string;
  tenant_name: string;
  kind: 'initial' | 'additional';
  amount_cents: number;
  received_on: string | null;
  sent_to_bank_on: string | null;
  bank_cleared_on: string | null;
  in_master_cents: number;
  subaccount_last4: string | null;
  subaccount_opened_on: string | null;
  allocated_on: string | null;
  stage: Stage;
  responsible_employee: string | null;
  next_action: string | null;
  bank_balance_cents: number | null;
  accounting_balance_cents: number | null;
  balance_as_of: string | null;
  vacate_date: string | null;
  bank_account_closed_on: string | null;
  funds_returned_on: string | null;
  funds_returned_cents: number | null;
  refunded_on: string | null;
  refunded_cents: number | null;
  final_status: string | null;
}

/** Dollars string ("$2,500", "2500.5", "") → integer cents. Returns null on
 *  anything unparseable so the form can reject it rather than post a wrong
 *  figure. Blank → 0. Never uses float cents. */
export function dollarsToCents(raw: string): number | null {
  const s = (raw ?? '').trim().replace(/[$,\s]/g, '');
  if (!s) return 0;
  const neg = s.startsWith('-');
  const t = s.replace(/^-/, '');
  if (t === '' || t === '.' || !/^\d*\.?\d*$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  const cents = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isFinite(cents)) return null;
  return neg ? -cents : cents;
}

function ageDays(iso: string | null, today: string): number | null {
  if (!iso) return null;
  return Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / 86_400_000);
}

// Money still sitting in an open per-tenant subaccount: a subaccount exists and
// the deposit has not started leaving (returned / posted / refunded / closed /
// bank closing).
const LEAVING: Stage[] = ['bank_closing', 'funds_returned', 'posted', 'refunded', 'closed'];
function heldInSub(r: CustodyRow): boolean {
  return !!(r.subaccount_last4 || r.subaccount_opened_on) && !LEAVING.includes(r.stage);
}

export interface Rollup {
  received: number; inMaster: number; inSub: number;
  refundPending: number; agedCount: number; buildings: number;
  bankStated: number; accountingExpected: number; balanceVariance: number;
  compared: number; pending: number;
}

/** The dashboard header, computed from records — matches src/custody/totals.ts. */
export function rollup(records: CustodyRow[], today: string): Rollup {
  let received = 0, inMaster = 0, inSub = 0, refundPending = 0, agedCount = 0;
  let bankStated = 0, accountingExpected = 0, compared = 0, pending = 0;
  const b = new Set<string>();
  for (const r of records) {
    received += r.amount_cents;
    inMaster += r.in_master_cents;
    if (heldInSub(r)) inSub += Math.max(0, r.amount_cents - r.in_master_cents);
    if ((r.stage === 'funds_returned' || r.stage === 'posted') && !r.refunded_on) refundPending++;
    const since = r.bank_cleared_on ?? r.sent_to_bank_on;
    const age = ageDays(since, today);
    if (r.in_master_cents > 0 && age != null && age > AGE_LIMIT) agedCount++;
    if (r.building_id) b.add(r.building_id);

    const hasBank = r.bank_balance_cents != null;
    const hasAcct = r.accounting_balance_cents != null;
    if (hasBank) bankStated += r.bank_balance_cents as number;
    if (hasAcct) accountingExpected += r.accounting_balance_cents as number;
    if (hasBank && hasAcct) compared++; else pending++;
  }
  return {
    received, inMaster, inSub, refundPending, agedCount, buildings: b.size,
    bankStated, accountingExpected, balanceVariance: bankStated - accountingExpected, compared, pending,
  };
}

export interface ReconRow {
  id: string; building?: string | null; unit: string; tenant_name: string;
  bank: number | null; accounting: number | null; variance: number | null; as_of: string | null;
}

/** Per-tenant bank vs accounting rows — only where at least one figure exists,
 *  so the comparison table is not padded with un-entered records. */
export function reconRows(records: CustodyRow[]): ReconRow[] {
  return records
    .filter(r => r.bank_balance_cents != null || r.accounting_balance_cents != null)
    .map(r => ({
      id: r.id, building: r.building, unit: r.unit, tenant_name: r.tenant_name,
      bank: r.bank_balance_cents, accounting: r.accounting_balance_cents,
      variance: r.bank_balance_cents != null && r.accounting_balance_cents != null
        ? r.bank_balance_cents - r.accounting_balance_cents : null,
      as_of: r.balance_as_of,
    }))
    .sort((a, b) => (a.variance ?? 1e18) - (b.variance ?? 1e18)); // worst shortfall first
}

export interface AgingRow {
  id: string; building?: string | null; building_id?: string | null;
  unit: string; tenant_name: string; kind: string; in_master_cents: number;
  since: string | null; days_in_master: number | null;
  subaccount_last4: string | null; stage: string;
  responsible_employee: string | null; next_action: string | null;
}

/** Master-account aging rows (every dollar still pooled), oldest first —
 *  matches the v_master_account_aging view. */
export function agingFrom(records: CustodyRow[], today: string): AgingRow[] {
  return records
    .filter(r => r.in_master_cents > 0)
    .map(r => {
      const since = r.bank_cleared_on ?? r.sent_to_bank_on ?? null;
      return {
        id: r.id, building: r.building, building_id: r.building_id,
        unit: r.unit, tenant_name: r.tenant_name, kind: r.kind,
        in_master_cents: r.in_master_cents, since, days_in_master: ageDays(since, today),
        subaccount_last4: r.subaccount_last4, stage: r.stage,
        responsible_employee: r.responsible_employee, next_action: r.next_action,
      };
    })
    .sort((a, b) => (b.days_in_master ?? -1) - (a.days_in_master ?? -1));
}
