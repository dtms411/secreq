import { readFileSync } from 'node:fs';
import { parseCsv, type CsvFormat } from '../src/parsers/csv.js';
import { escrowParser } from '../src/parsers/escrow.js';
import { makeChecker } from './_assert.js';

const { check, done } = makeChecker();

console.log('csv parser — identical rows to the PDF for the same period');

// The same April 2025 Meridian statement, exported as CSV. Task 2 is done when
// the CSV and the PDF for an overlapping period produce identical rows.
const csv = [
  'Date,Description,Check,Amount',
  '04/03/2025,DEPOSIT - RIVERA M UNIT 4B,,2400.00',
  '04/09/2025,CHECK PAID - REFUND T ADAMS,10442,-2150.00',
  '04/17/2025,DEPOSIT - OKONKWO A UNIT 2R,,2650.00',
  '04/22/2025,CHECK PAID - REFUND L BRENNAN,10443,-1975.00',
  '04/30/2025,INTEREST CREDIT,,31.25',
  '',
].join('\n');

const fmt: CsvFormat = {
  id: 'meridian-csv', version: '0.1.0',
  columns: { date: 'Date', description: 'Description', checkNo: 'Check', amount: 'Amount' },
  dateFormat: 'MM/DD/YYYY',
  accountLast4: '4417',
};

const pdf = escrowParser.parse([readFileSync(new URL('./fixture.txt', import.meta.url), 'utf8')]);
const parsed = parseCsv(csv, fmt);

check('same transaction count', parsed.transactions.length === pdf.transactions.length,
  `${parsed.transactions.length} vs ${pdf.transactions.length}`);

const key = (t: { postedOn: string; amountCents: number; descriptor: string; checkNo?: string }) =>
  `${t.postedOn}|${t.amountCents}|${t.descriptor}|${t.checkNo ?? ''}`;

let identical = true;
for (let i = 0; i < pdf.transactions.length; i++) {
  if (key(parsed.transactions[i]) !== key(pdf.transactions[i])) {
    identical = false;
    console.log(`    row ${i}: csv ${key(parsed.transactions[i])}  !=  pdf ${key(pdf.transactions[i])}`);
  }
}
check('every row identical to the PDF', identical);

// Period derived from the rows (CSV carries no header period).
check('period derived from rows', parsed.periodStart === '2025-04-03' && parsed.periodEnd === '2025-04-30');

// Balances are NOT in the CSV — ingestCsv anchors them to the prior close.
const sum = parsed.transactions.reduce((a, t) => a + t.amountCents, 0);
check('sum of rows matches the PDF net movement', sum === (pdf.closingBalanceCents - pdf.openingBalanceCents),
  `${sum} vs ${pdf.closingBalanceCents - pdf.openingBalanceCents}`);

done('csv');
