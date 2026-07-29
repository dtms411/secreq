// The seam. Every bank format implements this and nothing else changes.
//
// Money is ALWAYS integer cents, signed: credits positive, debits negative.
// Never introduce a float anywhere in this pipeline.

export interface ParsedTransaction {
  postedOn: string;        // ISO date, YYYY-MM-DD
  amountCents: number;     // signed
  descriptor: string;      // raw text as it appears
  checkNo?: string;
  pageNo?: number;
  lineNo?: number;
}

export interface ParsedStatement {
  periodStart: string;
  periodEnd: string;
  openingBalanceCents: number;
  closingBalanceCents: number;
  accountLast4: string;
  transactions: ParsedTransaction[];
}

export interface StatementParser {
  /** Stable id recorded on every row this parser produces. */
  readonly id: string;
  /** Bumped whenever parsing logic changes, so re-extractions are comparable. */
  readonly version: string;
  /** Cheap check against the first page. Return false fast. */
  detect(text: string): boolean;
  parse(pages: string[]): ParsedStatement;
}

export class ParseError extends Error {
  constructor(message: string, readonly page?: number) {
    super(message);
    this.name = 'ParseError';
  }
}

/** "$1,234.56" | "1234.56-" | "(1,234.56)" -> integer cents. */
export function toCents(raw: string): number {
  const s = raw.trim();
  if (!s) throw new ParseError('empty amount');

  const negative =
    s.startsWith('(') || s.endsWith('-') || s.startsWith('-');

  const digits = s.replace(/[^0-9.]/g, '');
  if (!digits) throw new ParseError(`unparseable amount: ${raw}`);

  const dot = digits.indexOf('.');
  let cents: number;
  if (dot === -1) {
    cents = Number(digits) * 100;
  } else {
    const whole = digits.slice(0, dot) || '0';
    const frac = digits.slice(dot + 1).padEnd(2, '0').slice(0, 2);
    cents = Number(whole) * 100 + Number(frac);
  }

  if (!Number.isFinite(cents)) throw new ParseError(`unparseable amount: ${raw}`);
  return negative ? -cents : cents;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}
