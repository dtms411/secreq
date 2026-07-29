import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { db, actor } from './db.js';

// Seeds the reference tables: buildings and their bank accounts. These are the
// only tables that are edited by hand rather than derived from evidence, so the
// loader is idempotent (skip if already present) and does no more than mirror
// the two template CSVs in seeds/.

async function rows(path: string): Promise<Record<string, string>[]> {
  return parse(await readFile(path, 'utf8'), { columns: true, skip_empty_lines: true, trim: true });
}

export async function seedBuildings(path: string): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0, skipped = 0;
  for (const r of await rows(path)) {
    const { data: existing } = await db.from('buildings').select('id').eq('name', r.name).maybeSingle();
    if (existing) { skipped++; continue; }
    const { error } = await db.from('buildings').insert({
      name: r.name, address: r.address, borough: r.borough || null, bbl: r.bbl || null,
      unit_count: Number(r.unit_count), acquired_on: r.acquired_on || null,
      // interest_required is a generated column (unit_count >= 6); do not set it.
    });
    if (error) throw error;
    inserted++;
  }
  return { inserted, skipped };
}

export async function seedAccounts(path: string): Promise<{ inserted: number; skipped: number; unresolved: string[] }> {
  const { data: buildings } = await db.from('buildings').select('id, name');
  const byName = new Map((buildings ?? []).map((b: any) => [String(b.name).toLowerCase().trim(), b.id]));
  let inserted = 0, skipped = 0;
  const unresolved: string[] = [];

  for (const r of await rows(path)) {
    const buildingId = byName.get(r.building_name.toLowerCase().trim());
    if (!buildingId) { unresolved.push(r.building_name); continue; }
    const { data: existing } = await db
      .from('bank_accounts').select('id')
      .eq('building_id', buildingId).eq('account_last4', r.account_last4).eq('account_type', r.account_type)
      .maybeSingle();
    if (existing) { skipped++; continue; }
    const { error } = await db.from('bank_accounts').insert({
      building_id: buildingId,
      bank_name: r.bank_name,
      account_last4: r.account_last4,
      account_type: r.account_type,               // 'escrow' | 'operating'
      is_interest_bearing: /^(y|yes|true|1)$/i.test(r.is_interest_bearing ?? ''),
      opened_on: r.opened_on || null,
    });
    if (error) throw error;
    inserted++;
  }
  return { inserted, skipped, unresolved };
}

export async function seed(buildingsCsv: string, accountsCsv: string): Promise<void> {
  const b = await seedBuildings(buildingsCsv);
  const a = await seedAccounts(accountsCsv);
  await db.from('audit_log').insert({
    actor: actor(), action: 'seed', table_name: 'buildings', row_id: null,
    after: { buildings: b, accounts: a },
  });
  console.log(`buildings: ${b.inserted} inserted, ${b.skipped} already present`);
  console.log(`accounts:  ${a.inserted} inserted, ${a.skipped} already present`);
  if (a.unresolved.length) console.log(`  ⚠ ${a.unresolved.length} account(s) had an unknown building: ${[...new Set(a.unresolved)].join(', ')}`);
}
