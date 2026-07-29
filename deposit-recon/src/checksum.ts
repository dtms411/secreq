import type { ParsedStatement } from './parsers/types.js';
import { formatCents } from './parsers/types.js';

// The gate. A statement is arithmetically self-proving: the opening balance
// plus every transaction on it must equal the closing balance. If that does
// not hold to the cent, the extraction is wrong -- no judgement call required.
//
// Nothing enters the reconciliation dataset without passing this.

export interface ChecksumResult {
  ok: boolean;
  deltaCents: number;
  openingCents: number;
  closingCents: number;
  creditCents: number;
  debitCents: number;
  txnCount: number;
  message: string;
}

export function verify(stmt: ParsedStatement): ChecksumResult {
  const credits = stmt.transactions.filter(t => t.amountCents > 0);
  const debits = stmt.transactions.filter(t => t.amountCents < 0);

  const creditCents = credits.reduce((a, t) => a + t.amountCents, 0);
  const debitCents = debits.reduce((a, t) => a + t.amountCents, 0);

  const computed = stmt.openingBalanceCents + creditCents + debitCents;
  const deltaCents = computed - stmt.closingBalanceCents;
  const ok = deltaCents === 0;

  return {
    ok,
    deltaCents,
    openingCents: stmt.openingBalanceCents,
    closingCents: stmt.closingBalanceCents,
    creditCents,
    debitCents,
    txnCount: stmt.transactions.length,
    message: ok
      ? `balanced (${stmt.transactions.length} txns)`
      : `OUT OF BALANCE by ${formatCents(deltaCents)} — ` +
        `open ${formatCents(stmt.openingBalanceCents)} ` +
        `+ cr ${formatCents(creditCents)} ` +
        `+ dr ${formatCents(debitCents)} ` +
        `= ${formatCents(computed)}, expected ${formatCents(stmt.closingBalanceCents)}`,
  };
}

// Common failure shapes, offered as hints when a statement fails.
// These are suggestions for a human, never automatic corrections.
export function diagnose(r: ChecksumResult, stmt: ParsedStatement): string[] {
  const hints: string[] = [];
  if (r.ok) return hints;

  const d = Math.abs(r.deltaCents);

  for (const t of stmt.transactions) {
    if (Math.abs(t.amountCents) === d) {
      hints.push(`a transaction of exactly ${formatCents(t.amountCents)} matches the gap — likely double-counted or missed: "${t.descriptor}"`);
    }
    if (Math.abs(t.amountCents * 2) === d) {
      hints.push(`sign may be flipped on "${t.descriptor}" (${formatCents(t.amountCents)})`);
    }
  }
  if (d % 100 === 0) hints.push('gap is a whole dollar amount — check for a dropped or duplicated line');
  if (d === r.closingCents) hints.push('gap equals the closing balance — opening balance may not have been captured');
  if (stmt.transactions.length === 0) hints.push('no transactions parsed at all — the table regex did not match');

  return hints;
}
