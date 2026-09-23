import { db, actor } from '../db.js';

// Posts per-tenant BANK balances read from a subaccount statement into
// custody_deposits.bank_balance_cents. This is the bank *source* side of the
// bank-vs-accounting reconciliation: it fills only the bank column, keyed to a
// subaccount by its account number, and never touches the office's own custody
// fields (amount received, stage, accounting balance). The accounting column is
// entered separately (on the site or the tracker import); their disagreement is
// the finding.
//
// A balance is posted ONLY after the Python gate (ocr/verify.py) accepted the
// statement — multi-read consensus + the printed grand-total tie. This module
// does not lower that bar; it just writes what the gate already proved.
//
// Idempotent on the natural key (building_id, external_ref=account number): a
// re-run of the same statement updates the same rows in place. Every batch is
// audit-logged, exactly like the tracker import.

export interface BalanceRow {
  account: string;
  unit?: string | null;
  tenant?: string | null;
  balance_cents: number;
}

export interface DbBuilding {
  id: string;
  name: string | null;
  address: string | null;
}

export interface PostResult {
  inserted: number;
  updated: number;
  skipped: number;
}

const digits = (s: string | null | undefined): string => (s ?? '').replace(/\D/g, '');

/** Load the portfolio buildings once, for name → id resolution. */
export async function loadBuildings(): Promise<DbBuilding[]> {
  const { data, error } = await db.from('buildings').select('id, name, address');
  if (error) throw error;
  return (data ?? []) as DbBuilding[];
}

/** Resolve a canonical building name (as returned by the Python resolver,
 *  already matched against the portfolio + entity map) to a building_id in this
 *  database. Exact name first, then an exact digit-stream match against name or
 *  address — so "70-11 108th Street" binds even if the seeded name reads
 *  "70-11 108th St". Returns the unique id, or null when zero or more than one
 *  building matches (the caller then quarantines rather than guessing). */
export function resolveBuildingId(name: string, buildings: DbBuilding[]): string | null {
  const wantName = name.trim().toLowerCase();
  const exact = buildings.filter((b) => (b.name ?? '').trim().toLowerCase() === wantName);
  if (exact.length === 1) return exact[0].id;

  const wantDigits = digits(name);
  if (wantDigits) {
    const hits = buildings.filter(
      (b) => digits(b.name) === wantDigits || digits(b.address) === wantDigits,
    );
    const ids = [...new Set(hits.map((b) => b.id))];
    if (ids.length === 1) return ids[0];
  }
  return null;
}

/** Resolve the set of building_ids a document maps to, from the Python
 *  resolver's canonical names. Exactly one id means it is safe to post; anything
 *  else the caller quarantines. */
export function resolveDocBuildings(
  resolvedNames: string[],
  buildings: DbBuilding[],
): { ids: string[]; unresolved: string[] } {
  const ids = new Set<string>();
  const unresolved: string[] = [];
  for (const n of resolvedNames) {
    const id = resolveBuildingId(n, buildings);
    if (id) ids.add(id);
    else unresolved.push(n);
  }
  return { ids: [...ids], unresolved };
}

export async function postBankBalances(args: {
  rows: BalanceRow[];
  buildingId: string;
  asOf: string | null;
  sourceFile: string;
  dryRun: boolean;
}): Promise<PostResult> {
  const { rows, buildingId, asOf, sourceFile, dryRun } = args;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const r of rows) {
    const account = (r.account ?? '').trim();
    if (!account || r.balance_cents == null) { skipped++; continue; }
    const last4 = account.slice(-4);

    const { data: existing, error: selErr } = await db
      .from('custody_deposits')
      .select('id')
      .eq('building_id', buildingId)
      .eq('external_ref', account)
      .maybeSingle();
    if (selErr) throw selErr;

    if (existing) {
      if (!dryRun) {
        // Bank column only — never overwrite the office's custody fields.
        const { error } = await db.from('custody_deposits').update({
          bank_balance_cents: r.balance_cents,
          balance_as_of: asOf,
          subaccount_last4: last4,
          updated_at: new Date().toISOString(),
        }).eq('id', existing.id);
        if (error) throw error;
      }
      updated++;
    } else {
      if (!dryRun) {
        // No custody row for this subaccount yet — seed one from the bank read.
        // amount_cents is seeded to the bank balance (best available) and can be
        // corrected by the tracker import / on the site; stage reflects that the
        // money is in a segregated per-tenant subaccount.
        const { error } = await db.from('custody_deposits').insert({
          building_id: buildingId,
          unit: r.unit ?? '—',
          tenant_name: r.tenant ?? '(unnamed subaccount)',
          kind: 'initial',
          amount_cents: r.balance_cents,
          bank_balance_cents: r.balance_cents,
          balance_as_of: asOf,
          in_master_cents: 0,
          stage: 'in_subaccount',
          subaccount_last4: last4,
          external_ref: account,
        });
        if (error) throw error;
      }
      inserted++;
    }
  }

  if (!dryRun) {
    await db.from('audit_log').insert({
      actor: actor(), action: 'post_bank_balances', table_name: 'custody_deposits', row_id: null,
      after: { building_id: buildingId, inserted, updated, skipped, as_of: asOf, source: sourceFile },
    });
  }

  return { inserted, updated, skipped };
}
