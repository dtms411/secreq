import { readFile } from 'node:fs/promises';
import { db, actor } from '../db.js';
import { parseCustody, type CustodyColumnMap, type CustodyRecord } from './parse.js';

// Imports the office custody tracker into `custody_deposits`. Each record's
// building is resolved against the independent buildings table (by name or
// BBL); a record whose building cannot be resolved is reported, never attached
// to a guessed building. Idempotent on the tracker's natural key
// (building, unit, tenant, kind, amount, received_on) — the same unique key the
// table enforces — so re-importing a refreshed export updates in place instead
// of duplicating.
//
// custody_deposits is operational and MUTABLE (rows advance through stages), so
// unlike the append-only extraction tables this loader upserts. Every import is
// still audit-logged.

export interface CustodyLoadResult {
  inserted: number;
  updated: number;
  unresolvedBuilding: CustodyRecord[];
  problems: { line: number; reason: string }[];
  notes: { line: number; note: string }[];
}

async function buildingIndex(): Promise<Map<string, string>> {
  const { data, error } = await db.from('buildings').select('id, name, bbl');
  if (error) throw error;
  const idx = new Map<string, string>();
  for (const b of data ?? []) {
    if (b.name) idx.set(b.name.toLowerCase().trim(), b.id);
    if (b.bbl) idx.set(String(b.bbl).trim(), b.id);
  }
  return idx;
}

function toRow(r: CustodyRecord, buildingId: string, sourceDocumentId?: string) {
  return {
    building_id: buildingId,
    lease_id: r.leaseId ?? null,
    unit: r.unit,
    tenant_name: r.tenantName,
    kind: r.kind,
    amount_cents: r.amountCents,
    received_on: r.receivedOn ?? null,
    sent_to_bank_on: r.sentToBankOn ?? null,
    bank_cleared_on: r.bankClearedOn ?? null,
    in_master_cents: r.inMasterCents,
    subaccount_last4: r.subaccountLast4 ?? null,
    subaccount_opened_on: r.subaccountOpenedOn ?? null,
    allocated_on: r.allocatedOn ?? null,
    stage: r.stage,
    responsible_employee: r.responsibleEmployee ?? null,
    next_action: r.nextAction ?? null,
    bank_balance_cents: r.bankBalanceCents ?? null,
    accounting_balance_cents: r.accountingBalanceCents ?? null,
    balance_as_of: r.balanceAsOf ?? null,
    vacate_date: r.vacateDate ?? null,
    bank_account_closed_on: r.bankAccountClosedOn ?? null,
    funds_returned_on: r.fundsReturnedOn ?? null,
    funds_returned_cents: r.fundsReturnedCents ?? null,
    refunded_on: r.refundedOn ?? null,
    refunded_cents: r.refundedCents ?? null,
    final_status: r.finalStatus ?? null,
    external_ref: r.externalRef ?? null,
    source_document_id: sourceDocumentId ?? null,
    updated_at: new Date().toISOString(),
  };
}

export async function loadCustody(
  path: string,
  cm: CustodyColumnMap,
  sourceDocumentId?: string,
): Promise<CustodyLoadResult> {
  const text = await readFile(path, 'utf8');
  const { records, problems, notes } = parseCustody(text, cm);
  const idx = await buildingIndex();

  let inserted = 0;
  let updated = 0;
  const unresolvedBuilding: CustodyRecord[] = [];

  for (const r of records) {
    const buildingId = idx.get(r.buildingKey.toLowerCase().trim()) ?? idx.get(r.buildingKey.trim());
    if (!buildingId) { unresolvedBuilding.push(r); continue; }

    const { data: dup } = await db
      .from('custody_deposits')
      .select('id')
      .eq('building_id', buildingId)
      .eq('unit', r.unit)
      .eq('tenant_name', r.tenantName)
      .eq('kind', r.kind)
      .eq('amount_cents', r.amountCents)
      .eq('received_on', r.receivedOn ?? null)
      .maybeSingle();

    const row = toRow(r, buildingId, sourceDocumentId);
    if (dup) {
      const { error } = await db.from('custody_deposits').update(row).eq('id', dup.id);
      if (error) throw error;
      updated++;
    } else {
      const { error } = await db.from('custody_deposits').insert(row);
      if (error) throw error;
      inserted++;
    }
  }

  await db.from('audit_log').insert({
    actor: actor(), action: 'load_custody', table_name: 'custody_deposits', row_id: null,
    after: { inserted, updated, unresolved: unresolvedBuilding.length, source: path },
  });

  return { inserted, updated, unresolvedBuilding, problems, notes };
}
