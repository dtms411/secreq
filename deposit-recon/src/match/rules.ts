// Tiered matching, in order of trust. Every result is a *proposal*: it carries
// a method and a confidence, and decided_by stays null until a human approves
// it (invariant 6 -- an LLM or a rule may suggest, never post). The rules are
// deliberately conservative; the brief warns that an auto-match rate above ~85%
// early on means the rules are too loose and are manufacturing matches.

export interface TxnLike {
  id: string;
  amountCents: number;
  postedOn: string;      // YYYY-MM-DD
  descriptor: string;
  checkNo?: string | null;
}

export interface LedgerLike {
  id: string;
  leaseId: string;
  amountCents: number;
  entryDate: string;     // YYYY-MM-DD
  note?: string | null;
}

export interface LeaseLike {
  id: string;
  tenantName: string;
  expectedDepositCents: number;
}

export type MatchMethod = 'exact' | 'fuzzy';

export interface MatchProposal {
  method: MatchMethod;
  leaseId: string;
  ledgerId?: string;
  confidence: number;    // 0..1
}

/** Mirror of the SQL normalize_name(): lowercase, punctuation to space,
 *  collapse, trim. The two must agree or fuzzy scores drift between the
 *  in-process rules and the pg_trgm query. */
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Pull the likely payer/tenant out of a bank descriptor. Strips leading
 *  transaction-type verbiage and trailing unit tokens. Heuristic by nature, so
 *  it only ever feeds the *fuzzy* tier, never exact. */
export function extractPayer(descriptor: string): string {
  let s = descriptor;
  s = s.replace(/^\s*(deposit|check\s*paid|check|ach|wire|transfer|refund|payment|credit|debit|withdrawal)\b[\s:\-]*/i, '');
  s = s.replace(/\breturn(ed)?\b|\brefund\b/gi, ' ');
  s = s.replace(/\bunit\b.*$/i, '');
  s = s.replace(/#?\d{3,}.*$/, ''); // trailing check/ref numbers
  return normalizeName(s);
}

/** Trigram Jaccard similarity in [0,1]. A lightweight stand-in for pg_trgm so
 *  the tiering logic is testable in-process; the DB runner uses similarity()
 *  for the authoritative score. */
export function nameSimilarity(a: string, b: string): number {
  const grams = (x: string): Set<string> => {
    const p = `  ${normalizeName(x)} `;
    const g = new Set<string>();
    for (let i = 0; i < p.length - 2; i++) g.add(p.slice(i, i + 3));
    return g;
  };
  const ga = grams(a), gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

function daysBetween(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`), db = Date.parse(`${b}T00:00:00Z`);
  return Math.abs(da - db) / 86_400_000;
}

export interface MatchOptions {
  /** Exact tier: how far the ledger entry date may sit from the posting date. */
  dateWindowDays: number;    // default 5
  /** Fuzzy tier: minimum normalized-name similarity to propose. */
  fuzzyThreshold: number;    // default 0.45
  /** Fuzzy tier: amount must be within this fraction of the expected deposit. */
  amountTolerance: number;   // default 0 (exact amount) — kept explicit
}

export const DEFAULT_OPTS: MatchOptions = { dateWindowDays: 5, fuzzyThreshold: 0.45, amountTolerance: 0 };

/**
 * Classify one bank transaction against the candidate ledger entries and leases
 * for its building. Returns a single best proposal, or null (which the runner
 * records as an unmatched exception).
 */
export function classify(
  txn: TxnLike,
  ledger: LedgerLike[],
  leases: LeaseLike[],
  opts: MatchOptions = DEFAULT_OPTS,
): MatchProposal | null {
  // ---- Tier 1: exact. Amount equal, date within window, and if the bank txn
  // carries a check number it must appear in the ledger note. A *unique* such
  // candidate is an exact match; ambiguity falls through rather than guessing.
  const exact = ledger.filter(l =>
    l.amountCents === txn.amountCents &&
    daysBetween(l.entryDate, txn.postedOn) <= opts.dateWindowDays &&
    (!txn.checkNo || (l.note ?? '').includes(txn.checkNo)),
  );
  if (exact.length === 1) {
    const conf = txn.checkNo && (exact[0].note ?? '').includes(txn.checkNo) ? 1 : 0.95;
    return { method: 'exact', leaseId: exact[0].leaseId, ledgerId: exact[0].id, confidence: conf };
  }

  // ---- Tier 2: fuzzy. Normalized payer vs. tenant of record. Amount must
  // still match the expected deposit (within tolerance) so a name coincidence
  // alone cannot produce a match.
  const payer = extractPayer(txn.descriptor);
  if (payer) {
    let best: { leaseId: string; score: number } | null = null;
    for (const lease of leases) {
      const amountOk = opts.amountTolerance === 0
        ? Math.abs(txn.amountCents) === lease.expectedDepositCents
        : Math.abs(Math.abs(txn.amountCents) - lease.expectedDepositCents) <= lease.expectedDepositCents * opts.amountTolerance;
      if (!amountOk) continue;
      const score = nameSimilarity(payer, lease.tenantName);
      if (score >= opts.fuzzyThreshold && (!best || score > best.score)) {
        best = { leaseId: lease.id, score };
      }
    }
    if (best) return { method: 'fuzzy', leaseId: best.leaseId, confidence: Number(best.score.toFixed(3)) };
  }

  return null;
}
