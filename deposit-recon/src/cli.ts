import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { ingestPdf } from './ingest.js';
import { tieout } from './reports/tieout.js';
import { continuityReport } from './reports/continuity.js';
import {
  backfill, singleAccount, byDirectory, readJournalSummary,
  type IngestFn, type AccountResolver,
} from './backfill.js';
import { listParsers } from './parsers/registry.js';

const [cmd, ...args] = process.argv.slice(2);

const usage = `
  ingest <bank_account_id> <file.pdf...>     parse and load statements
  backfill <root> --account <id>             resumable batch ingest of a tree
  backfill <root> --map <dirmap.json>          (route each file by parent dir)
  quarantine <root>                          re-print the quarantine report
  continuity [--write]                       per-account gaps in the statement series
  tieout                                     phase 1 variance report
  parsers                                    list registered bank formats
`;

/** Route a file to the right ingest layer by extension. CSV is deliberately
 *  not wired yet: task 2 is blocked on a real bank CSV export, and a stub that
 *  silently did nothing would read as "no statements to load" rather than
 *  "not built yet". */
const ingestByExtension: IngestFn = async (path, acct) => {
  const ext = extname(path).toLowerCase();
  if (ext === '.pdf') return ingestPdf(path, acct);
  if (ext === '.csv') {
    return { status: 'errored', message: 'csv ingest not yet available (task 2 — blocked on a real bank CSV export)' };
  }
  return { status: 'errored', message: `no ingest path for ${ext} files` };
};

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function resolverFromFlags(): Promise<AccountResolver> {
  const acct = flag('--account');
  if (acct) return singleAccount(acct);
  const mapFile = flag('--map');
  if (mapFile) {
    const map = JSON.parse(await readFile(mapFile, 'utf8')) as Record<string, string>;
    return byDirectory(map);
  }
  throw new Error('backfill needs --account <id> or --map <dirmap.json>');
}

switch (cmd) {
  case 'ingest': {
    const [acct, ...files] = args;
    if (!acct || !files.length) { console.error(usage); process.exit(1); }
    let quarantined = 0;
    for (const f of files) {
      try {
        const r = await ingestPdf(f, acct);
        console.log(`[${r.status}] ${f}\n  ${r.message}`);
        if (r.status === 'quarantined') quarantined++;
      } catch (e) {
        console.error(`[error] ${f}\n  ${(e as Error).message}`);
        quarantined++;
      }
    }
    if (quarantined) console.log(`\n${quarantined} file(s) need review before they can be used.`);
    break;
  }

  case 'backfill': {
    const root = args[0];
    if (!root || root.startsWith('--')) { console.error(usage); process.exit(1); }
    const resolve = await resolverFromFlags();
    const summary = await backfill({
      root,
      resolve,
      ingest: ingestByExtension,
      extensions: flag('--csv') ? ['.pdf', '.csv'] : ['.pdf'],
      onFile: (o) => console.log(`[${o.status}] ${o.path}\n  ${o.message}`),
    });
    const { counts, skipped, total } = summary;
    console.log(
      `\n${total} processed  (${skipped} already done, skipped)\n` +
      `  ingested ${counts.ingested}   duplicate ${counts.duplicate}   ` +
      `quarantined ${counts.quarantined}   errored ${counts.errored}`,
    );
    if (summary.quarantine.length) {
      console.log(`\nquarantine — ${summary.quarantine.length} file(s) need attention:`);
      for (const q of summary.quarantine) console.log(`  [${q.status}] ${q.path}\n    ${q.message.split('\n')[0]}`);
      console.log(`\njournal: ${summary.journalPath}`);
    }
    break;
  }

  case 'quarantine': {
    const root = args[0];
    if (!root) { console.error(usage); process.exit(1); }
    const items = await readJournalSummary(root, flag('--journal'));
    const need = items.filter(o => o.status === 'quarantined' || o.status === 'errored');
    if (!need.length) { console.log('no files awaiting attention'); break; }
    console.log(`${need.length} file(s) need attention:`);
    for (const q of need) console.log(`  [${q.status}] ${q.path}\n    ${q.message.split('\n')[0]}  (${q.at})`);
    break;
  }

  case 'continuity': await continuityReport(args.includes('--write')); break;
  case 'tieout': await tieout(); break;
  case 'parsers': console.table(listParsers()); break;
  default: console.error(usage); process.exit(1);
}
