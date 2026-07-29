import { db } from '../db.js';
import { formatCents } from '../parsers/types.js';

// Phase 1 report. ledger_variance is money that left improperly;
// expected_variance is money that never arrived. They fail differently
// and only the second one catches a deposit that was never banked.
export async function tieout() {
  const { data, error } = await db
    .from('v_building_tieout')
    .select('*')
    .order('expected_variance_cents', { ascending: true });
  if (error) throw error;

  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
  console.log(
    pad('building', 28), pad('as of', 12),
    'bank'.padStart(14), 'expected'.padStart(14), 'variance'.padStart(14), '  ck',
  );
  console.log('-'.repeat(100));

  let total = 0;
  for (const r of data ?? []) {
    const v = r.expected_variance_cents ?? 0;
    total += v;
    console.log(
      pad(r.name, 28), pad(r.as_of ?? 'no statement', 12),
      formatCents(r.bank_cents ?? 0).padStart(14),
      formatCents(r.expected_cents ?? 0).padStart(14),
      formatCents(v).padStart(14),
      r.checksum_ok === false ? '  !!' : '',
    );
  }
  console.log('-'.repeat(100));
  console.log(pad('PORTFOLIO', 28), ' '.repeat(12), ' '.repeat(14), ' '.repeat(14), formatCents(total).padStart(14));
  console.log('\nnegative variance = escrow holds less than the lease universe implies');
}
