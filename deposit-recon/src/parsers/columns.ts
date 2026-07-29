import { type ParsedTransaction, ParseError, toCents } from './types.js';

// pdftotext -layout preserves column alignment, so a statement table is a
// fixed-width document, not a delimited one. Regex against optional columns
// silently mis-assigns values when a cell is blank -- a blank debit column
// lets the credit amount fall into the debit group and the whole statement
// inverts. Slicing by character offset cannot make that mistake: a blank
// cell yields an empty string.
//
// Column boundaries are read from the statement's own header row, so a
// change in bank layout is detected rather than absorbed.

export interface ColumnSpec {
  /** Canonical name used downstream. */
  key: 'date' | 'desc' | 'check' | 'debit' | 'credit' | 'balance';
  /** Matches the column's header cell. */
  header: RegExp;
  required?: boolean;
}

export interface ColumnLayout {
  key: ColumnSpec['key'];
  start: number;
  end: number; // exclusive; Infinity for the final column
}

/** Locate the header row and derive character offsets for each column. */
export function resolveLayout(lines: string[], specs: ColumnSpec[]): { layout: ColumnLayout[]; headerLine: number } {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const found: { key: ColumnSpec['key']; start: number }[] = [];

    for (const spec of specs) {
      const m = line.match(spec.header);
      if (m && m.index !== undefined) found.push({ key: spec.key, start: m.index });
    }

    const required = specs.filter(s => s.required !== false);
    if (found.length < required.length) continue;
    if (!required.every(r => found.some(f => f.key === r.key))) continue;

    found.sort((a, b) => a.start - b.start);

    const layout: ColumnLayout[] = found.map((f, idx) => ({
      key: f.key,
      start: f.start,
      // Extend each column to where the next one begins. Right-aligned
      // figures sit at the far edge of their own column, so the window
      // must run to the next header's start, not the current header's end.
      end: idx + 1 < found.length ? found[idx + 1].start : Infinity,
    }));

    // The first column absorbs any left indent.
    if (layout.length) layout[0].start = 0;

    return { layout, headerLine: i };
  }
  throw new ParseError('could not locate the transaction table header row');
}

function cell(line: string, col: ColumnLayout): string {
  const end = col.end === Infinity ? line.length : col.end;
  return line.slice(col.start, end).trim();
}

export interface ColumnParseOptions {
  layout: ColumnLayout[];
  ignore?: RegExp[];
  /** Recognises the start of a transaction row. */
  dateLike: RegExp;
  normaliseDate: (raw: string) => string;
}

export function parseRows(
  pages: string[],
  opts: ColumnParseOptions,
): ParsedTransaction[] {
  const out: ParsedTransaction[] = [];

  pages.forEach((page, pi) => {
    page.split('\n').forEach((line, li) => {
      if (!line.trim()) return;
      if (opts.ignore?.some(re => re.test(line))) return;

      const cells = Object.fromEntries(
        opts.layout.map(c => [c.key, cell(line, c)]),
      ) as Record<ColumnSpec['key'], string>;

      if (!cells.date || !opts.dateLike.test(cells.date)) return;

      const debit = cells.debit ?? '';
      const credit = cells.credit ?? '';

      let amountCents: number;
      if (debit && credit) {
        throw new ParseError(
          `row populates both debit and credit -- column offsets are wrong: "${line}"`,
          pi + 1,
        );
      } else if (debit) {
        amountCents = -Math.abs(toCents(debit));
      } else if (credit) {
        amountCents = Math.abs(toCents(credit));
      } else {
        return; // a wrapped description line, not a transaction
      }

      out.push({
        postedOn: opts.normaliseDate(cells.date),
        amountCents,
        descriptor: (cells.desc ?? '').replace(/\s{2,}/g, ' ').trim(),
        checkNo: cells.check || undefined,
        pageNo: pi + 1,
        lineNo: li + 1,
      });
    });
  });

  return out;
}
