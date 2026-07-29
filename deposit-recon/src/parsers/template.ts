import {
  type ParsedStatement, type ParsedTransaction, type StatementParser,
  ParseError, toCents,
} from './types.js';

// Most bank statements are the same document with different chrome: a header
// carrying the period and the opening/closing balances, then repeating rows of
// date / description / amount. So a bank format is a config, not a class.
//
// Add a bank by writing one of these and registering it. Only reach for a
// bespoke parser when a layout genuinely cannot be expressed here.

export interface TemplateConfig {
  id: string;
  version: string;
  /** Matched against page 1 to identify the bank. */
  detect: RegExp;
  /** Must expose named groups. */
  period: RegExp;          // (?<start>) (?<end>)
  opening: RegExp;         // (?<amount>)
  closing: RegExp;         // (?<amount>)
  accountLast4: RegExp;    // (?<last4>)
  /** Per-line. Groups: date, desc, amount; optional check, debit, credit. */
  txnLine: RegExp;
  /** Lines matching any of these are skipped before txnLine is tried. */
  ignore?: RegExp[];
  /** Statement year, when transaction dates omit it. */
  dateFormat: 'MM/DD/YYYY' | 'MM/DD' | 'YYYY-MM-DD';
  /**
   * How debits are signalled. Most statements use separate columns; some use
   * a trailing minus; a few rely on the description.
   */
  debitStyle: 'separate_columns' | 'trailing_minus' | 'parenthesised';
}

function normaliseDate(raw: string, fmt: TemplateConfig['dateFormat'], fallbackYear: number): string {
  const t = raw.trim();
  if (fmt === 'YYYY-MM-DD') return t;
  const parts = t.split(/[\/\-]/).map(p => p.trim());
  if (parts.length < 2) throw new ParseError(`unparseable date: ${raw}`);
  const mm = parts[0].padStart(2, '0');
  const dd = parts[1].padStart(2, '0');
  let yyyy = parts[2] ?? String(fallbackYear);
  if (yyyy.length === 2) yyyy = `20${yyyy}`;
  return `${yyyy}-${mm}-${dd}`;
}

function must(text: string, re: RegExp, what: string): RegExpMatchArray {
  const m = text.match(re);
  if (!m?.groups) throw new ParseError(`could not locate ${what}`);
  return m;
}

export function makeParser(cfg: TemplateConfig): StatementParser {
  return {
    id: cfg.id,
    version: cfg.version,

    detect(text) {
      return cfg.detect.test(text);
    },

    parse(pages) {
      const all = pages.join('\n');
      const head = pages[0] ?? '';

      const period = must(head, cfg.period, 'statement period');
      const periodStart = normaliseDate(period.groups!.start, cfg.dateFormat, new Date().getFullYear());
      const periodEnd = normaliseDate(period.groups!.end, cfg.dateFormat, new Date().getFullYear());
      const year = Number(periodEnd.slice(0, 4));

      const openingBalanceCents = toCents(must(all, cfg.opening, 'opening balance').groups!.amount);
      const closingBalanceCents = toCents(must(all, cfg.closing, 'closing balance').groups!.amount);
      const accountLast4 = must(head, cfg.accountLast4, 'account number').groups!.last4;

      const transactions: ParsedTransaction[] = [];

      pages.forEach((page, pi) => {
        page.split('\n').forEach((line, li) => {
          if (!line.trim()) return;
          if (cfg.ignore?.some(re => re.test(line))) return;

          const m = line.match(cfg.txnLine);
          if (!m?.groups) return;

          const g = m.groups;
          let amountCents: number;

          if (cfg.debitStyle === 'separate_columns') {
            // Exactly one of the two columns is populated on a given row.
            const credit = g.credit?.trim();
            const debit = g.debit?.trim();
            if (credit && debit) throw new ParseError(`row has both debit and credit: ${line}`, pi + 1);
            if (credit) amountCents = Math.abs(toCents(credit));
            else if (debit) amountCents = -Math.abs(toCents(debit));
            else return; // neither column populated: not a transaction row
          } else {
            // Sign is carried in the amount token itself.
            amountCents = toCents(g.amount);
          }

          transactions.push({
            postedOn: normaliseDate(g.date, cfg.dateFormat, year),
            amountCents,
            descriptor: g.desc.trim().replace(/\s{2,}/g, ' '),
            checkNo: g.check?.trim() || undefined,
            pageNo: pi + 1,
            lineNo: li + 1,
          });
        });
      });

      return {
        periodStart, periodEnd,
        openingBalanceCents, closingBalanceCents,
        accountLast4, transactions,
      };
    },
  };
}
