import { type ParsedStatement, type StatementParser, ParseError, toCents } from './types.js';
import { resolveLayout, parseRows, type ColumnSpec } from './columns.js';

const SPECS: ColumnSpec[] = [
  { key: 'date',    header: /\bDate\b/i },
  { key: 'desc',    header: /\bDescription\b/i },
  { key: 'check',   header: /\bCheck\b/i,   required: false },
  { key: 'debit',   header: /\bDebit\b|\bWithdrawal/i },
  { key: 'credit',  header: /\bCredit\b|\bDeposit\b/i },
  { key: 'balance', header: /\bBalance\b/i },
];

const IGNORE = [
  /^\s*(?:Beginning|Opening|Ending|Closing|Previous|New)\s+Balance/i,
  /^\s*Total\s+/i,
  /^\s*Page\s+\d+/i,
  /^[\s\-=_]+$/,
];

function must(text: string, re: RegExp, what: string) {
  const m = text.match(re);
  if (!m?.groups) throw new ParseError(`could not locate ${what}`);
  return m.groups;
}

export const escrowParser: StatementParser = {
  id: 'escrow-columnar',
  version: '0.2.0',
  detect: (t) => /TENANT SECURITY|ESCROW ACCOUNT|SECURITY DEPOSIT ACCOUNT/i.test(t),

  parse(pages): ParsedStatement {
    const all = pages.join('\n');
    const head = pages[0] ?? '';
    const lines = head.split('\n');

    const period = must(head, /Statement Period:?\s+(?<start>\d{2}\/\d{2}\/\d{4})\s*(?:-|to|through)\s*(?<end>\d{2}\/\d{2}\/\d{4})/i, 'statement period');
    const iso = (s: string) => { const [m, d, y] = s.split('/'); return `${y}-${m}-${d}`; };
    const periodEnd = iso(period.end);
    const year = periodEnd.slice(0, 4);

    const { layout } = resolveLayout(lines, SPECS);

    const transactions = parseRows(pages, {
      layout,
      ignore: IGNORE,
      dateLike: /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/,
      normaliseDate: (raw) => {
        const p = raw.split('/');
        const yy = p[2] ? (p[2].length === 2 ? `20${p[2]}` : p[2]) : year;
        return `${yy}-${p[0].padStart(2, '0')}-${p[1].padStart(2, '0')}`;
      },
    });

    return {
      periodStart: iso(period.start),
      periodEnd,
      openingBalanceCents: toCents(must(all, /(?:Beginning|Opening|Previous)\s+Balance\s+\$?(?<amount>[\d,]+\.\d{2})/i, 'opening balance').amount),
      closingBalanceCents: toCents(must(all, /(?:Ending|Closing|New)\s+Balance\s+\$?(?<amount>[\d,]+\.\d{2})/i, 'closing balance').amount),
      accountLast4: must(head, /Account(?:\s+(?:No|Number|#))?\.?:?\s+[\dX*\-]*?(?<last4>\d{4})\b/i, 'account number').last4,
      transactions,
    };
  },
};
