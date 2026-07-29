import { db } from '../db.js';
import { formatCents } from '../parsers/types.js';

// Period continuity, per account. A missing month is as important as a
// variance and, until this ran, nothing detected it: the tie-out reports the
// latest closing balance, so a gap simply shortens the series without any
// signal that a period is absent.
//
// Two independent breaks, from two independent facts on each statement:
//
//   calendar_gap  -- the next period does not begin the day after the previous
//                    period ended. A whole statement is missing from the file
//                    set (or a period was skipped by the bank).
//
//   balance_break -- the next opening balance does not equal the previous
//                    closing balance. Even with no calendar gap, the running
//                    balance was not carried forward -- a statement is missing,
//                    mis-parsed, or the account had activity we never saw.
//
// Both surface as `missing_statement_period` exceptions (medium). This never
// fills a gap or adjusts a balance; it only reports, exactly like the checksum
// gate. Zero or quarantine, never "close enough".

export interface PeriodRow {
  statementId?: string;
  periodStart: string;   // YYYY-MM-DD
  periodEnd: string;     // YYYY-MM-DD
  openingCents: number;
  closingCents: number;
}

export type BreakKind = 'calendar_gap' | 'balance_break';

export interface ContinuityBreak {
  kind: BreakKind;
  afterPeriodEnd: string;
  nextPeriodStart: string;
  /** For balance_break: prior closing vs next opening. */
  priorClosingCents?: number;
  nextOpeningCents?: number;
  gapCents?: number;
  detail: string;
}

function nextDayISO(iso: string): string {
  // Date-only arithmetic in UTC to avoid any timezone drift. Parsing a bare
  // YYYY-MM-DD as UTC keeps the day stable regardless of host timezone.
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Pure. Rows in any order; sorted here by period start. */
export function findContinuityBreaks(rows: PeriodRow[]): ContinuityBreak[] {
  const sorted = [...rows].sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  const breaks: ContinuityBreak[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];

    const expectedStart = nextDayISO(prev.periodEnd);
    if (cur.periodStart !== expectedStart) {
      breaks.push({
        kind: 'calendar_gap',
        afterPeriodEnd: prev.periodEnd,
        nextPeriodStart: cur.periodStart,
        detail: `period ends ${prev.periodEnd}; next period starts ${cur.periodStart}, expected ${expectedStart}`,
      });
    }

    if (cur.openingCents !== prev.closingCents) {
      const gap = cur.openingCents - prev.closingCents;
      breaks.push({
        kind: 'balance_break',
        afterPeriodEnd: prev.periodEnd,
        nextPeriodStart: cur.periodStart,
        priorClosingCents: prev.closingCents,
        nextOpeningCents: cur.openingCents,
        gapCents: gap,
        detail:
          `closing ${formatCents(prev.closingCents)} on ${prev.periodEnd} ` +
          `does not carry into opening ${formatCents(cur.openingCents)} on ${cur.periodStart} ` +
          `(gap ${formatCents(gap)})`,
      });
    }
  }

  return breaks;
}

interface AccountStatements {
  bankAccountId: string;
  buildingId: string | null;
  buildingName: string | null;
  accountLast4: string;
  rows: PeriodRow[];
}

async function loadByAccount(): Promise<AccountStatements[]> {
  // Only checksum-passing statements form the trusted series. A quarantined
  // statement is not a fact about the account, so it cannot anchor continuity.
  const { data, error } = await db
    .from('statements')
    .select('id, bank_account_id, period_start, period_end, opening_balance_cents, closing_balance_cents, checksum_ok, ' +
            'bank_accounts(account_last4, building_id, buildings(name))')
    .eq('checksum_ok', true)
    .order('bank_account_id')
    .order('period_start');
  if (error) throw error;

  const groups = new Map<string, AccountStatements>();
  for (const s of (data ?? []) as any[]) {
    const acct = s.bank_accounts ?? {};
    let g = groups.get(s.bank_account_id);
    if (!g) {
      g = {
        bankAccountId: s.bank_account_id,
        buildingId: acct.building_id ?? null,
        buildingName: acct.buildings?.name ?? null,
        accountLast4: acct.account_last4 ?? '????',
        rows: [],
      };
      groups.set(s.bank_account_id, g);
    }
    g.rows.push({
      statementId: s.id,
      periodStart: s.period_start,
      periodEnd: s.period_end,
      openingCents: Number(s.opening_balance_cents),
      closingCents: Number(s.closing_balance_cents),
    });
  }
  return [...groups.values()];
}

/** Detect gaps across every account and record each as an exception. Idempotent
 *  via a deterministic detail signature: a break already recorded is not
 *  duplicated, so this is safe to run after every backfill. Exceptions are
 *  findings, not financial figures -- they carry no ledger provenance and never
 *  move money. */
export async function continuityReport(write = false): Promise<{ accounts: number; breaks: number }> {
  const accounts = await loadByAccount();
  let totalBreaks = 0;

  for (const a of accounts) {
    const breaks = findContinuityBreaks(a.rows);
    if (!breaks.length) continue;
    totalBreaks += breaks.length;

    console.log(`\n${a.buildingName ?? '(unknown building)'}  ....${a.accountLast4}  (${a.rows.length} statements)`);
    for (const b of breaks) console.log(`  [${b.kind}] ${b.detail}`);

    if (!write) continue;

    for (const b of breaks) {
      // Same signature format the exception detector uses (detectors.ts,
      // missingStatementPeriod), so the two producers dedupe against each other
      // and a gap is never recorded twice.
      const signature = `missing_statement_period:${a.bankAccountId}:${b.kind}:${b.afterPeriodEnd}:${b.nextPeriodStart}`;
      const { data: dup } = await db
        .from('exceptions')
        .select('id')
        .eq('kind', 'missing_statement_period')
        .contains('detail', { signature })
        .maybeSingle();
      if (dup) continue;

      await db.from('exceptions').insert({
        kind: 'missing_statement_period',
        severity: 'medium',
        building_id: a.buildingId,
        amount_cents: b.gapCents ?? null,
        detail: {
          signature,
          break_kind: b.kind,
          bank_account_id: a.bankAccountId,
          account_last4: a.accountLast4,
          after_period_end: b.afterPeriodEnd,
          next_period_start: b.nextPeriodStart,
          prior_closing_cents: b.priorClosingCents ?? null,
          next_opening_cents: b.nextOpeningCents ?? null,
          message: b.detail,
        },
      });
    }
  }

  console.log(
    totalBreaks
      ? `\n${totalBreaks} continuity break(s) across ${accounts.length} account(s)${write ? ' — recorded as exceptions' : ' (report only; pass --write to record)'}`
      : `\nno continuity breaks across ${accounts.length} account(s)`,
  );
  return { accounts: accounts.length, breaks: totalBreaks };
}
