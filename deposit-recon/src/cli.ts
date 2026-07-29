import { ingestPdf } from './ingest.js';
import { tieout } from './reports/tieout.js';
import { listParsers } from './parsers/registry.js';

const [cmd, ...args] = process.argv.slice(2);

const usage = `
  ingest <bank_account_id> <file.pdf...>   parse and load statements
  tieout                                   phase 1 variance report
  parsers                                  list registered bank formats
`;

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
  case 'tieout': await tieout(); break;
  case 'parsers': console.table(listParsers()); break;
  default: console.error(usage); process.exit(1);
}
