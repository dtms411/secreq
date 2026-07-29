import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  backfill, singleAccount, byDirectory,
  type IngestFn, type FileOutcome,
} from '../src/backfill.js';

// The pure continuity detector must be reachable without a database. Its module
// imports ./db.js (idiomatic here), which throws if the service key is absent,
// so give it harmless placeholders before importing. No query is ever run — we
// only call the pure function.
process.env.SUPABASE_URL ||= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'placeholder';
const { findContinuityBreaks } = await import('../src/reports/continuity.js');

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? `  — ${extra}` : ''}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------- continuity checks

console.log('continuity detector');
{
  // Clean series: Jan closes 500.00 -> Feb opens 500.00, contiguous dates.
  const clean = findContinuityBreaks([
    { periodStart: '2025-01-01', periodEnd: '2025-01-31', openingCents: 40000, closingCents: 50000 },
    { periodStart: '2025-02-01', periodEnd: '2025-02-28', openingCents: 50000, closingCents: 52500 },
    { periodStart: '2025-03-01', periodEnd: '2025-03-31', openingCents: 52500, closingCents: 52500 },
  ]);
  check('clean series has no breaks', clean.length === 0, `got ${clean.length}`);

  // March is missing entirely: Feb ends 02-28, next starts 04-01, and the
  // balance does not carry (52500 -> 60000).
  const gapped = findContinuityBreaks([
    { periodStart: '2025-02-01', periodEnd: '2025-02-28', openingCents: 50000, closingCents: 52500 },
    { periodStart: '2025-04-01', periodEnd: '2025-04-30', openingCents: 60000, closingCents: 61000 },
  ]);
  check('detects the calendar gap', gapped.some(b => b.kind === 'calendar_gap'));
  check('detects the balance break', gapped.some(b => b.kind === 'balance_break'));
  const bb = gapped.find(b => b.kind === 'balance_break');
  check('balance gap is signed cents', bb?.gapCents === 7500, `got ${bb?.gapCents}`);

  // Contiguous dates but the balance silently jumps: activity we never saw.
  const balanceOnly = findContinuityBreaks([
    { periodStart: '2025-05-01', periodEnd: '2025-05-31', openingCents: 61000, closingCents: 61000 },
    { periodStart: '2025-06-01', periodEnd: '2025-06-30', openingCents: 58000, closingCents: 58000 },
  ]);
  check('balance break with no calendar gap', balanceOnly.length === 1 && balanceOnly[0].kind === 'balance_break');

  // Order independence: unsorted input yields the same result.
  const unsorted = findContinuityBreaks([
    { periodStart: '2025-04-01', periodEnd: '2025-04-30', openingCents: 60000, closingCents: 61000 },
    { periodStart: '2025-02-01', periodEnd: '2025-02-28', openingCents: 50000, closingCents: 52500 },
  ]);
  check('input order does not matter', unsorted.length === gapped.length);
}

// ------------------------------------------------------- backfill resume/idempotency

console.log('\nbackfill runner');
const workRoot = await mkdtemp(join(tmpdir(), 'backfill-'));
try {
  // A small tree: two buildings, a couple of statements each, plus one file
  // whose directory is not in the routing map.
  const layout: Record<string, string[]> = {
    'bldg-a': ['2025-01.pdf', '2025-02.pdf', '2025-03.pdf'],
    'bldg-b': ['2025-01.pdf', '2025-02.pdf'],
    'orphan': ['stray.pdf'],
  };
  for (const [dir, files] of Object.entries(layout)) {
    await mkdir(join(workRoot, dir), { recursive: true });
    for (const f of files) await writeFile(join(workRoot, dir, f), `${dir}/${f}`, 'utf8');
  }

  const routeMap = { 'bldg-a': 'acct-a', 'bldg-b': 'acct-b' }; // orphan intentionally absent

  // Count *successful* ingests per path across the whole test. A crash before
  // the ingest returns is not a landed row, so it does not count — mirroring
  // the DB, where only a committed row consumes the sha256 uniqueness.
  const attempts = new Map<string, number>();
  const makeIngest = (crashAfter = Infinity): IngestFn => {
    let n = 0;
    return async (path) => {
      n++;
      if (n > crashAfter) throw new Error('__simulated_crash__');
      attempts.set(path, (attempts.get(path) ?? 0) + 1);
      return { status: 'ingested', message: 'balanced' };
    };
  };

  // First pass crashes after 2 successful ingests (journal already persisted
  // for those before the crash propagates).
  let crashed = false;
  try {
    await backfill({
      root: workRoot,
      resolve: byDirectory(routeMap),
      ingest: makeIngest(2),
      onFile: (o: FileOutcome) => { if (o.status === 'errored' && o.message === '__simulated_crash__') { crashed = true; throw new Error('crash'); } },
    });
  } catch { /* simulated interruption */ }

  // Second pass resumes and finishes.
  const summary = await backfill({
    root: workRoot,
    resolve: byDirectory(routeMap),
    ingest: makeIngest(),
    onFile: () => {},
  });

  // No path was ingested twice — the sha256 constraint guarantees this in
  // production, but resume must not even re-attempt a landed file.
  const doubled = [...attempts.entries()].filter(([, c]) => c > 1);
  check('no file ingested more than once across resume', doubled.length === 0, doubled.map(([p]) => p).join(', '));

  // Every routable statement landed exactly once, across both passes.
  check('all 5 routable statements ingested', [...attempts.keys()].filter(p => !p.includes('orphan')).length === 5);

  // The orphan could not be routed and is surfaced, never guessed.
  const orphan = summary.quarantine.find(q => q.path.includes('stray.pdf'));
  check('unroutable file is errored, not ingested', orphan?.status === 'errored', orphan?.message ?? 'not found');

  // Strict resume of a completed tree is a no-op: nothing re-ingested, and even
  // the permanently-unroutable orphan is left alone.
  attempts.clear();
  const rerun = await backfill({
    root: workRoot, resolve: byDirectory(routeMap), ingest: makeIngest(),
    retryUnresolved: false, onFile: () => {},
  });
  check('strict re-run of a completed tree ingests nothing', attempts.size === 0);
  check('strict re-run reports everything skipped', rerun.total === 0 && rerun.skipped >= 6, `total=${rerun.total} skipped=${rerun.skipped}`);

  // The journal is append-only on disk and survives as the audit record.
  const journal = await readFile(join(workRoot, '.backfill-journal.jsonl'), 'utf8');
  check('journal persisted', journal.trim().split('\n').length >= 5);

  // singleAccount routes every file to one account.
  const single = singleAccount('acct-x');
  check('singleAccount routes uniformly', single('/anything/at/all.pdf') === 'acct-x');
} finally {
  await rm(workRoot, { recursive: true, force: true });
}

console.log(`\n${failures ? `${failures} check(s) FAILED` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
