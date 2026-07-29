import { readdir, readFile, appendFile, mkdir, stat } from 'node:fs/promises';
import { join, extname, dirname, relative } from 'node:path';

// Resumable batch ingest over a folder tree.
//
// Two properties matter and they are independent:
//
//   no duplicates -- guaranteed by the sha256 unique constraint in the
//     database (documents.sha256). ingestPdf checks it before doing anything,
//     so re-running the whole tree is always safe. The journal below is an
//     optimisation and an audit record, not the thing that prevents dupes.
//
//   no gaps -- every file under the root is accounted for with a terminal
//     status. A crash mid-run must not silently drop files. The journal is
//     append-only and flushed after every file, so a restart knows exactly
//     what already completed and re-attempts only what did not.
//
// The seven-year backfill runs here, locally, against the service key. It is
// never run through Vercel (long-running, and the service key stays on the
// CLI host).

export type FileStatus = 'ingested' | 'duplicate' | 'quarantined' | 'errored';

export interface FileOutcome {
  path: string;        // relative to the run root, stable across machines
  sha256?: string;     // present once the file has been read
  status: FileStatus;
  message: string;
  at: string;          // ISO timestamp
}

/** What the runner needs from the ingest layer. Injected so the orchestration
 *  is testable without a database or poppler. */
export interface IngestFn {
  (path: string, bankAccountId: string): Promise<{ status: string; documentId?: string; message: string }>;
}

/** Maps a file to the bank account it belongs to. Returning null means the
 *  runner cannot route the file; that is surfaced as an error, never guessed
 *  at -- a mis-routed statement is caught by the last4 check in ingest, but we
 *  do not rely on that as the first line of defence. */
export interface AccountResolver {
  (path: string): string | null;
}

export interface BackfillOptions {
  root: string;
  resolve: AccountResolver;
  ingest: IngestFn;
  /** Where the resume journal lives. Defaults to <root>/.backfill-journal.jsonl */
  journalPath?: string;
  /** File extensions to process. Others are ignored (not errored). */
  extensions?: string[];
  /** Re-attempt files whose last recorded status was quarantined/errored.
   *  On by default: a parser fix or a re-scanned page should get another pass.
   *  Successful (ingested/duplicate) files are always skipped. */
  retryUnresolved?: boolean;
  /** Progress callback, one call per file as it is decided. */
  onFile?: (o: FileOutcome) => void;
}

export interface BackfillSummary {
  root: string;
  journalPath: string;
  counts: Record<FileStatus, number>;
  skipped: number;               // already terminal in the journal, not re-run
  total: number;                 // files considered this run (excludes skipped)
  quarantine: FileOutcome[];     // everything a human must look at
  outcomes: FileOutcome[];       // every file decided this run
}

function isoNow(): string {
  // Real Node runtime; wall-clock is fine here (this is not a workflow script).
  return new Date().toISOString();
}

async function walk(root: string, exts: Set<string>): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue; // skip .backfill-journal.jsonl etc.
      const full = join(dir, e.name);
      if (e.isDirectory()) await rec(full);
      else if (exts.has(extname(e.name).toLowerCase())) out.push(full);
    }
  }
  await rec(root);
  return out;
}

/** Last-write-wins per path. The journal is append-only on disk; in memory the
 *  latest line for a path is authoritative. */
async function readJournal(journalPath: string): Promise<Map<string, FileOutcome>> {
  const byPath = new Map<string, FileOutcome>();
  let text: string;
  try {
    text = await readFile(journalPath, 'utf8');
  } catch {
    return byPath; // first run
  }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as FileOutcome;
      if (o.path) byPath.set(o.path, o);
    } catch {
      // A torn final line from a crash mid-write. Ignore it; the file it
      // described will simply be re-attempted, which is safe.
    }
  }
  return byPath;
}

async function appendJournal(journalPath: string, o: FileOutcome): Promise<void> {
  await mkdir(dirname(journalPath), { recursive: true });
  await appendFile(journalPath, JSON.stringify(o) + '\n', 'utf8');
}

const TERMINAL_SUCCESS: ReadonlySet<FileStatus> = new Set<FileStatus>(['ingested', 'duplicate']);

function normaliseStatus(s: string): FileStatus {
  return s === 'ingested' || s === 'duplicate' || s === 'quarantined' ? s : 'errored';
}

export async function backfill(opts: BackfillOptions): Promise<BackfillSummary> {
  const journalPath = opts.journalPath ?? join(opts.root, '.backfill-journal.jsonl');
  const exts = new Set((opts.extensions ?? ['.pdf']).map(e => e.toLowerCase()));
  const retryUnresolved = opts.retryUnresolved ?? true;

  const prior = await readJournal(journalPath);
  const files = await walk(opts.root, exts);

  const counts: Record<FileStatus, number> = { ingested: 0, duplicate: 0, quarantined: 0, errored: 0 };
  const outcomes: FileOutcome[] = [];
  const quarantine: FileOutcome[] = [];
  let skipped = 0;

  for (const full of files) {
    const rel = relative(opts.root, full);
    const seen = prior.get(rel);

    // A file that already landed (ingested/duplicate) is never touched again.
    // Beyond that, retryUnresolved decides whether quarantined/errored files
    // get another pass (default) or a strict resume skips everything seen.
    if (seen && (TERMINAL_SUCCESS.has(seen.status) || !retryUnresolved)) {
      skipped++;
      continue;
    }

    let outcome: FileOutcome;
    const acct = opts.resolve(full);
    if (!acct) {
      outcome = {
        path: rel, status: 'errored', at: isoNow(),
        message: 'could not resolve a bank account for this file -- routing must be explicit, not guessed',
      };
    } else {
      try {
        const r = await opts.ingest(full, acct);
        outcome = { path: rel, status: normaliseStatus(r.status), message: r.message, at: isoNow() };
      } catch (e) {
        outcome = { path: rel, status: 'errored', message: (e as Error).message, at: isoNow() };
      }
    }

    await appendJournal(journalPath, outcome);
    counts[outcome.status]++;
    outcomes.push(outcome);
    if (outcome.status === 'quarantined' || outcome.status === 'errored') quarantine.push(outcome);
    opts.onFile?.(outcome);
  }

  return {
    root: opts.root, journalPath, counts, skipped,
    total: outcomes.length, quarantine, outcomes,
  };
}

/** Read the journal for a root and return the latest outcome per file. Lets
 *  `quarantine` re-print what needs attention without re-scanning the tree. */
export async function readJournalSummary(root: string, journalPath?: string): Promise<FileOutcome[]> {
  const jp = journalPath ?? join(root, '.backfill-journal.jsonl');
  const byPath = await readJournal(jp);
  return [...byPath.values()];
}

// -------------------------------------------------------------- resolvers

/** Every file under the root belongs to one account. Use when a tree holds a
 *  single account's statements. */
export function singleAccount(bankAccountId: string): AccountResolver {
  return () => bankAccountId;
}

/** Route by the name of the file's immediate parent directory. The map is
 *  built by a human (e.g. from `buildings`/`bank_accounts`), so an unrecognised
 *  directory errors rather than defaulting -- a statement filed under the wrong
 *  building must stop the line, not be absorbed. */
export function byDirectory(map: Record<string, string>): AccountResolver {
  return (path) => map[dirname(path).split(/[\\/]/).pop() ?? ''] ?? null;
}
