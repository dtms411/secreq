import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { ingestPdf } from './ingest.js';
import { ingestCsv } from './ingestCsv.js';
import type { CsvFormat } from './parsers/csv.js';
import { tieout } from './reports/tieout.js';
import { continuityReport } from './reports/continuity.js';
import {
  backfill, singleAccount, byDirectory, readJournalSummary,
  type IngestFn, type AccountResolver,
} from './backfill.js';
import { loadLeases } from './leases/load.js';
import type { LeaseColumnMap } from './leases/parse.js';
import { loadCustody } from './custody/load.js';
import type { CustodyColumnMap } from './custody/parse.js';
import { runCustodyDetect, custodyAging } from './custody/run.js';
import { runMatching } from './match/run.js';
import { runLlmMatching } from './llm/run.js';
import { runDetectors } from './exceptions/run.js';
import { runDeadlines } from './deadline/run.js';
import { generateReport } from './reports/report.js';
import { seed } from './seed.js';
import { listParsers } from './parsers/registry.js';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const [cmd, ...args] = process.argv.slice(2);

const usage = `
  seed <buildings.csv> <accounts.csv>        load the 45 buildings + bank accounts
  ingest <bank_account_id> <file.pdf...> [--ocr]   parse and load PDF statements
  ingest-csv <bank_account_id> <file.csv> --format <fmt.json> [--seed <cents>]
  backfill <root> --account <id>             resumable batch ingest of a tree
  backfill <root> --map <dirmap.json>          (route each file by parent dir)
  quarantine <root>                          re-print the quarantine report
  continuity [--write]                       per-account gaps in the statement series
  leases <file.csv> --map <map.json>         load the independent lease universe
  custody-import <file.csv> --map <map.json>   ingest the office custody tracker export
  custody-detect [--dry] [--date YYYY-MM-DD]   run custody lifecycle detectors into triage
  custody-aging [--date YYYY-MM-DD] [--master-balance <cents>]   master-account aging + summary
  match                                      propose bank<->ledger matches (human decides)
  llm-match                                  LLM proposes matches for the unmatched (human decides)
  exceptions [--dry]                         run all detectors into the triage queue
  deadlines [--date YYYY-MM-DD]              daily 14-day refund clock
  report [outfile-base]                      counsel-facing markdown + json report
  tieout                                     phase 1 variance report
  parsers                                    list registered bank formats
`;

/** Route a file to the right ingest layer by extension. PDFs are auto-detected
 *  and parsed; CSVs need an explicit per-bank format map, so batch CSV goes
 *  through the dedicated `ingest-csv` command rather than the tree walk. */
const ingestByExtension: IngestFn = async (path, acct) => {
  const ext = extname(path).toLowerCase();
  if (ext === '.pdf') return ingestPdf(path, acct, { ocr: args.includes('--ocr') });
  if (ext === '.csv') {
    return { status: 'errored', message: 'csv needs an explicit --format; use `ingest-csv` (not the tree walk)' };
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
    const ocr = args.includes('--ocr');
    for (const f of files) {
      if (f.startsWith('--')) continue;
      try {
        const r = await ingestPdf(f, acct, { ocr });
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

  case 'ingest-csv': {
    const [acct, file] = args;
    const fmtFile = flag('--format');
    if (!acct || !file || !fmtFile) { console.error(usage); process.exit(1); }
    const fmt = JSON.parse(await readFile(fmtFile, 'utf8')) as CsvFormat;
    const seed = flag('--seed');
    const r = await ingestCsv(file, acct, fmt, seed ? { seedOpeningCents: Number(seed) } : {});
    console.log(`[${r.status}] ${file}\n  ${r.message}`);
    if (r.status === 'quarantined') process.exit(2);
    break;
  }

  case 'leases': {
    const file = args[0];
    const mapFile = flag('--map');
    if (!file || !mapFile) { console.error(usage); process.exit(1); }
    const map = JSON.parse(await readFile(mapFile, 'utf8')) as LeaseColumnMap;
    const r = await loadLeases(file, map, flag('--source'));
    console.log(`leases: ${r.inserted} inserted, ${r.skippedExisting} already present`);
    if (r.unresolvedBuilding.length) console.log(`  ${r.unresolvedBuilding.length} row(s) had an unresolved building — not loaded`);
    for (const p of r.problems) console.log(`  line ${p.line}: ${p.reason}`);
    for (const n of r.notes) console.log(`  note (line ${n.line}): ${n.note}`);
    break;
  }

  case 'seed': {
    const [buildings, accounts] = args;
    if (!buildings || !accounts) { console.error(usage); process.exit(1); }
    await seed(buildings, accounts);
    break;
  }

  case 'custody-import': {
    const file = args[0];
    const mapFile = flag('--map');
    if (!file || !mapFile) { console.error(usage); process.exit(1); }
    const map = JSON.parse(await readFile(mapFile, 'utf8')) as CustodyColumnMap;
    const r = await loadCustody(file, map, flag('--source'));
    console.log(`custody: ${r.inserted} inserted, ${r.updated} updated`);
    if (r.unresolvedBuilding.length) console.log(`  ${r.unresolvedBuilding.length} row(s) had an unresolved building — not loaded`);
    for (const p of r.problems) console.log(`  line ${p.line}: ${p.reason}`);
    for (const n of r.notes) console.log(`  note (line ${n.line}): ${n.note}`);
    break;
  }
  case 'custody-detect': await runCustodyDetect(!args.includes('--dry'), flag('--date') ?? today()); break;
  case 'custody-aging': {
    const mb = flag('--master-balance');
    await custodyAging(flag('--date') ?? today(), mb ? Number(mb) : undefined);
    break;
  }

  case 'match': await runMatching(); break;
  case 'llm-match': await runLlmMatching(); break;
  case 'exceptions': await runDetectors(!args.includes('--dry')); break;
  case 'deadlines': await runDeadlines(flag('--date') ?? today()); break;
  case 'report': await generateReport(args[0] && !args[0].startsWith('--') ? args[0] : 'recon-report', today()); break;
  case 'continuity': await continuityReport(args.includes('--write')); break;
  case 'tieout': await tieout(); break;
  case 'parsers': console.table(listParsers()); break;
  default: console.error(usage); process.exit(1);
}
