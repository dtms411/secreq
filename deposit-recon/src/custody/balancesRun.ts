import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { mkdtemp, appendFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  loadBuildings, resolveDocBuildings, postBankBalances, type DbBuilding,
} from './balances.js';
import { pullInbox, moveFromInbox, PROCESSED, QUARANTINE } from './bucket.js';

// The local custody-balances runner: read per-tenant subaccount statements
// through the robust Python gate, and post the bank balances for the ones that
// tie — quarantining everything else. This is the seven-year-backfill workhorse
// for the bank side of the bank-vs-accounting reconciliation. It runs locally,
// on the service key, with ANTHROPIC_API_KEY set so the accurate Claude-vision
// read is in the consensus; it is never run through the deployed app.
//
// Safety, end to end:
//   • a statement posts only if verify.py accepted it (consensus + printed tie);
//   • it posts only if the statement resolves to exactly ONE portfolio building
//     (an ambiguous or unknown building quarantines — never a guessed post);
//   • posting fills the bank column only, keyed by subaccount, idempotently;
//   • --dry-run reads and gates everything and posts nothing.

type Decision = 'posted' | 'quarantined' | 'skipped' | 'errored';

interface PyResult {
  source_file: string;
  bank?: string | null;
  kind?: string;
  postable?: boolean;
  status?: string;
  as_of?: string | null;
  entity_name?: string | null;
  building_labels?: string[];
  buildings_resolved?: string[];
  grand_total_cents?: number | null;
  grand_total_alt_cents?: number | null;
  accepted_total_cents?: number | null;
  accepted_count?: number | null;
  reported_count?: number | null;
  gates?: Record<string, boolean>;
  rows?: { account: string; unit?: string | null; tenant?: string | null; balance_cents: number }[];
  flagged?: unknown[];
  note?: string;
  error?: string;
}

interface Outcome {
  file: string;
  decision: Decision;
  message: string;
  inserted?: number;
  updated?: number;
}

const scriptPath = () =>
  join(dirname(fileURLToPath(import.meta.url)), '../../ocr/balancecli.py');

/** Run the Python gate over a batch of PDFs and return one result per file. */
function analyze(files: string[]): PyResult[] {
  const py = process.env.PYTHON ?? 'python3';
  const res = spawnSync(py, [scriptPath(), ...files], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: process.env, // passes ANTHROPIC_API_KEY through to the vision reader
  });
  if (res.error) throw res.error;
  if (res.status !== 0 && !res.stdout) {
    throw new Error(`balancecli failed: ${res.stderr || 'no output'}`);
  }
  try {
    return JSON.parse(res.stdout) as PyResult[];
  } catch (e) {
    throw new Error(`could not parse balancecli output: ${(e as Error).message}\n${res.stderr}`);
  }
}

async function decide(
  r: PyResult,
  buildings: DbBuilding[],
  asOfOverride: string | undefined,
  dryRun: boolean,
): Promise<Outcome> {
  const file = r.source_file;

  if (r.status === 'error' || r.error) {
    return { file, decision: 'errored', message: r.error ?? 'unreadable' };
  }
  if (!r.postable || r.kind !== 'per_tenant') {
    return { file, decision: 'skipped', message: r.note ?? `not a per-tenant statement (${r.kind ?? r.bank})` };
  }
  if (r.status !== 'accepted') {
    const g = r.gates ?? {};
    const why = [
      g.row_consensus === false ? 'no row consensus' : '',
      g.sum_ties === false ? `sum ${r.accepted_total_cents} vs total ${r.grand_total_cents}` : '',
      g.count_ties === false ? 'count mismatch' : '',
    ].filter(Boolean).join('; ');
    return { file, decision: 'quarantined', message: `gate failed: ${why || 'quarantined'}` };
  }

  const { ids, unresolved } = resolveDocBuildings(r.buildings_resolved ?? [], buildings);
  if (ids.length !== 1) {
    const labels = (r.building_labels ?? []).join(' | ') || '(none)';
    const hint = ids.length === 0
      ? `building unresolved — add the entity/building to ocr/entitymap.json (labels: ${labels}; entity: ${r.entity_name ?? '—'})`
      : `building ambiguous — resolves to ${ids.length} buildings (${(r.buildings_resolved ?? []).join(', ')})`;
    return { file, decision: 'quarantined', message: hint + (unresolved.length ? `; unmatched: ${unresolved.join(', ')}` : '') };
  }

  const asOf = asOfOverride ?? r.as_of ?? null;
  const rows = (r.rows ?? []).filter((x) => x.account && x.balance_cents != null);
  const post = await postBankBalances({ rows, buildingId: ids[0], asOf, sourceFile: file, dryRun });
  const asOfNote = asOf ? `as of ${asOf}` : 'NO as-of date (add --as-of or a Report Date)';
  return {
    file, decision: 'posted', inserted: post.inserted, updated: post.updated,
    message: `${dryRun ? 'WOULD post' : 'posted'} ${rows.length} tenants (${post.inserted} new, ${post.updated} updated), ${asOfNote}`,
  };
}

export interface RunOptions {
  files: string[];       // explicit local PDF paths
  bucket: boolean;       // also pull + process the Storage inbox
  asOf?: string;         // override the balance-as-of date
  dryRun: boolean;
  journalPath?: string;  // default .balances-journal.jsonl in cwd
}

export async function runBalances(opts: RunOptions): Promise<void> {
  const buildings = await loadBuildings();
  const journalPath = opts.journalPath ?? '.balances-journal.jsonl';

  // Bucket files are pulled to a temp dir; local files are used in place. Track
  // which came from the bucket so we can move them out of the inbox afterward.
  const work: { path: string; inboxName?: string }[] = [];
  for (const f of opts.files) work.push({ path: f });
  if (opts.bucket) {
    const dir = await mkdtemp(join(tmpdir(), 'secreq-inbox-'));
    const pulled = await pullInbox(dir);
    for (const p of pulled) work.push({ path: p.localPath, inboxName: p.name });
    console.log(`pulled ${pulled.length} file(s) from the inbox`);
  }

  if (work.length === 0) { console.log('no files to process'); return; }

  const results = analyze(work.map((w) => w.path));
  const byPath = new Map(results.map((r) => [r.source_file, r] as const));

  const counts: Record<Decision, number> = { posted: 0, quarantined: 0, skipped: 0, errored: 0 };
  let insertedTotal = 0;
  let updatedTotal = 0;

  for (const w of work) {
    const r = byPath.get(w.path);
    const outcome: Outcome = r
      ? await decide(r, buildings, opts.asOf, opts.dryRun)
      : { file: w.path, decision: 'errored', message: 'no result from balancecli' };

    counts[outcome.decision]++;
    insertedTotal += outcome.inserted ?? 0;
    updatedTotal += outcome.updated ?? 0;
    console.log(`[${outcome.decision}] ${basename(w.path)}\n  ${outcome.message}`);

    await appendJournal(journalPath, {
      path: w.path, decision: outcome.decision, message: outcome.message, at: new Date().toISOString(),
    });

    // Move bucket files out of the inbox (never in a dry run — nothing was posted).
    if (w.inboxName && !opts.dryRun) {
      const dest = outcome.decision === 'posted' ? PROCESSED : QUARANTINE;
      await moveFromInbox(w.inboxName, dest);
    }
  }

  console.log(
    `\n${work.length} file(s): posted ${counts.posted}  quarantined ${counts.quarantined}  ` +
    `skipped ${counts.skipped}  errored ${counts.errored}` +
    (opts.dryRun ? '   [DRY RUN — nothing written]' : `\n  ${insertedTotal} new + ${updatedTotal} updated tenant balances`),
  );
  if (counts.quarantined || counts.errored) {
    console.log(`\nReview the quarantined/errored files above.` +
      (opts.bucket ? ` In Storage they were moved to the '${QUARANTINE}/' prefix.` : ''));
  }
  console.log(`journal: ${journalPath}`);
}

async function appendJournal(path: string, entry: unknown): Promise<void> {
  await mkdir(dirname(path) === '' ? '.' : dirname(path), { recursive: true }).catch(() => {});
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf8');
}

/** Re-print the balances journal — what posted, what still needs a look. */
export async function readBalancesJournal(path = '.balances-journal.jsonl'): Promise<void> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { console.log('no balances journal yet'); return; }
  const latest = new Map<string, { path: string; decision: string; message: string; at: string }>();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const o = JSON.parse(t); if (o.path) latest.set(o.path, o); } catch { /* torn line */ }
  }
  const need = [...latest.values()].filter((o) => o.decision === 'quarantined' || o.decision === 'errored');
  if (!need.length) { console.log('nothing awaiting attention'); return; }
  console.log(`${need.length} file(s) need attention:`);
  for (const o of need) console.log(`  [${o.decision}] ${basename(o.path)}\n    ${o.message}  (${o.at})`);
}
