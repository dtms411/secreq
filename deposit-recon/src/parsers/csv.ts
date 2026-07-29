import { parse } from 'csv-parse/sync';
import { type ParsedTransaction, ParseError, toCents } from './types.js';

// A bank CSV export is the same evidence as a PDF statement, delimited instead
// of laid out. Two differences drive the design:
//
//   1. CSVs usually carry no opening/closing balance -- just rows. So a CSV
//      parse produces transactions and a period, and the ingest layer derives
//      the balances from the prior statement's close (see ingestCsv), gating on
//      continuity rather than an internal checksum.
//
//   2. Header names vary by bank far more than PDF layouts do. The column map
//      is therefore explicit config per bank, never guessed -- the same rule as
//      PDF parsers: a mis-read column silently inverts a statement.

export interface CsvColumnMap {
  date: string;
  /** Either a single signed amount column, or separate debit/credit columns. */
  amount?: string;
  debit?: string;
  credit?: string;
  description: string;
  checkNo?: string;
  counterparty?: string;
  /** Some exports carry a running balance; used only for a per-row sanity tie. */
  balance?: string;
}

export interface CsvFormat {
  id: string;
  version: string;
  /** Column header -> canonical field. */
  columns: CsvColumnMap;
  dateFormat: 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'MM/DD/YY';
  /** Account last-4, if the export names the account anywhere in a header row. */
  accountLast4?: string;
}

export interface ParsedCsv {
  periodStart: string;   // earliest posted date
  periodEnd: string;     // latest posted date
  accountLast4?: string;
  transactions: ParsedTransaction[];
}

function normaliseDate(raw: string, fmt: CsvFormat['dateFormat']): string {
  const t = raw.trim();
  if (fmt === 'YYYY-MM-DD') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new ParseError(`unparseable date: ${raw}`);
    return t;
  }
  const p = t.split(/[\/\-]/);
  if (p.length < 3) throw new ParseError(`unparseable date: ${raw}`);
  let [mm, dd, yy] = p;
  if (fmt === 'MM/DD/YY') yy = `20${yy}`;
  return `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

function col(row: Record<string, string>, name: string | undefined): string {
  if (!name) return '';
  const v = row[name];
  return (v ?? '').trim();
}

export function parseCsv(text: string, fmt: CsvFormat): ParsedCsv {
  const rows = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  if (!rows.length) throw new ParseError('csv has no data rows');

  const cm = fmt.columns;
  const transactions: ParsedTransaction[] = [];

  rows.forEach((row, i) => {
    const dateRaw = col(row, cm.date);
    if (!dateRaw) return; // trailing/summary line
    const postedOn = normaliseDate(dateRaw, fmt.dateFormat);

    let amountCents: number;
    if (cm.amount) {
      const raw = col(row, cm.amount);
      if (!raw) return;
      amountCents = toCents(raw); // sign carried in the token
    } else {
      const debit = col(row, cm.debit);
      const credit = col(row, cm.credit);
      if (debit && credit) {
        throw new ParseError(`row ${i + 1} populates both debit and credit columns`);
      }
      if (credit) amountCents = Math.abs(toCents(credit));
      else if (debit) amountCents = -Math.abs(toCents(debit));
      else return; // neither: not a transaction row
    }

    transactions.push({
      postedOn,
      amountCents,
      descriptor: col(row, cm.description).replace(/\s{2,}/g, ' '),
      checkNo: col(row, cm.checkNo) || undefined,
      pageNo: undefined,        // CSVs have no pages
      lineNo: i + 2,            // +2: header row is line 1, data starts at 2
    });
  });

  if (!transactions.length) throw new ParseError('no transaction rows parsed from csv');

  const dates = transactions.map(t => t.postedOn).sort();
  return {
    periodStart: dates[0],
    periodEnd: dates[dates.length - 1],
    accountLast4: fmt.accountLast4,
    transactions,
  };
}
