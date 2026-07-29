import { readFile } from 'node:fs/promises';
import { db, actor } from './../db.js';
import { parseLeases, type LeaseColumnMap, type LeaseRecord } from './parse.js';

// Loads leases into the independent baseline. Resolves each record's building
// by name or BBL; a record whose building cannot be resolved is reported, never
// attached to a guessed building. Idempotent on the natural key
// (building, unit, tenant, term_start) so re-running a corrected rent roll does
// not duplicate the universe.

export interface LeaseLoadResult {
  inserted: number;
  skippedExisting: number;
  unresolvedBuilding: LeaseRecord[];
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

export async function loadLeases(
  path: string,
  cm: LeaseColumnMap,
  sourceDocumentId?: string,
): Promise<LeaseLoadResult> {
  const text = await readFile(path, 'utf8');
  const { records, problems, notes } = parseLeases(text, cm);
  const idx = await buildingIndex();

  let inserted = 0;
  let skippedExisting = 0;
  const unresolvedBuilding: LeaseRecord[] = [];

  for (const r of records) {
    const buildingId = idx.get(r.buildingKey.toLowerCase().trim()) ?? idx.get(r.buildingKey.trim());
    if (!buildingId) {
      unresolvedBuilding.push(r);
      continue;
    }

    const { data: dup } = await db
      .from('leases')
      .select('id')
      .eq('building_id', buildingId)
      .eq('unit', r.unit)
      .eq('tenant_name', r.tenantName)
      .eq('term_start', r.termStart)
      .maybeSingle();
    if (dup) { skippedExisting++; continue; }

    const { error } = await db.from('leases').insert({
      building_id: buildingId,
      unit: r.unit,
      tenant_name: r.tenantName,
      signed_on: r.signedOn ?? null,
      term_start: r.termStart,
      term_end: r.termEnd ?? null,
      vacated_on: r.vacatedOn ?? null,
      keys_returned_on: r.keysReturnedOn ?? null,
      monthly_rent_cents: r.monthlyRentCents,
      expected_deposit_cents: r.expectedDepositCents,
      is_rent_stabilized: r.isRentStabilized,
      source_document_id: sourceDocumentId ?? null,
    });
    if (error) throw error;
    inserted++;
  }

  await db.from('audit_log').insert({
    actor: actor(), action: 'load_leases', table_name: 'leases', row_id: null,
    after: { inserted, skippedExisting, unresolved: unresolvedBuilding.length, source: path },
  });

  return { inserted, skippedExisting, unresolvedBuilding, problems, notes };
}
