import { basename } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { db, actor } from './db.js';
import { parseCsv, type CsvFormat } from './parsers/csv.js';
import { formatCents } from './parsers/types.js';

export interface IngestResult {
  status: 'ingested' | 'duplicate' | 'quarantined';
  documentId?: string;
  message: string;
}

function nextDayISO(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * A CSV carries transactions but usually no balances. We anchor the opening to
 * the prior statement's closing balance for the account and derive the closing
 * as opening + sum(transactions). The gate is continuity, not an internal
 * checksum:
 *
 *   - No prior statement and no seed opening -> quarantine. We do not invent a
 *     starting balance; the opening PDF statement (or an explicit seed) must
 *     anchor the series first.
 *
 *   - A calendar gap between the prior period and this one -> quarantine. Using
 *     the prior close as the opening across a missing period would silently
 *     absorb whatever happened in the gap. Report it; never bridge it.
 *
 * Because closing is derived, checksum_delta is zero by construction. The real
 * cross-check comes later: an independently-parsed PDF for an overlapping
 * period must agree, row for row and balance for balance. Disagreement is the
 * finding, surfaced by the tie-out, not smoothed over here.
 */
export async function ingestCsv(
  path: string,
  bankAccountId: string,
  fmt: CsvFormat,
  opts: { seedOpeningCents?: number } = {},
): Promise<IngestResult> {
  const buf = await readFile(path);
  const hash = createHash('sha256').update(buf).digest('hex');

  const { data: existing } = await db
    .from('documents').select('id').eq('sha256', hash).maybeSingle();
  if (existing) {
    return { status: 'duplicate', documentId: existing.id, message: `already ingested as ${existing.id}` };
  }

  const parsed = parseCsv(buf.toString('utf8'), fmt);

  const { data: acct } = await db
    .from('bank_accounts').select('account_last4, building_id').eq('id', bankAccountId).single();
  if (acct && parsed.accountLast4 && acct.account_last4 !== parsed.accountLast4) {
    return {
      status: 'quarantined',
      message: `account mismatch: file shows ....${parsed.accountLast4}, target is ....${acct.account_last4}`,
    };
  }

  // Anchor the opening balance to the prior period's close.
  const { data: prior } = await db
    .from('statements')
    .select('period_end, closing_balance_cents, checksum_ok')
    .eq('bank_account_id', bankAccountId)
    .eq('checksum_ok', true)
    .lt('period_end', parsed.periodStart)
    .order('period_end', { ascending: false })
    .limit(1)
    .maybeSingle();

  let openingBalanceCents: number;
  if (prior) {
    const expectedStart = nextDayISO(prior.period_end);
    if (parsed.periodStart !== expectedStart) {
      return {
        status: 'quarantined',
        message:
          `continuity gap: last statement ends ${prior.period_end}, this CSV starts ${parsed.periodStart} ` +
          `(expected ${expectedStart}). A statement period is missing — ingest it before this CSV.`,
      };
    }
    openingBalanceCents = Number(prior.closing_balance_cents);
  } else if (opts.seedOpeningCents !== undefined) {
    openingBalanceCents = opts.seedOpeningCents;
  } else {
    return {
      status: 'quarantined',
      message:
        'no prior statement to anchor the opening balance, and no --seed given. ' +
        'Ingest the opening PDF statement first, or pass an explicit seed opening.',
    };
  }

  const sum = parsed.transactions.reduce((a, t) => a + t.amountCents, 0);
  const closingBalanceCents = openingBalanceCents + sum;

  const { size } = await stat(path);
  const { data: doc, error: docErr } = await db.from('documents').insert({
    sha256: hash,
    filename: basename(path),
    kind: 'bank_csv',
    bank_account_id: bankAccountId,
    building_id: acct?.building_id ?? null,
    storage_path: path,
    byte_size: size,
    page_count: null,
    uploaded_by: actor(),
  }).select('id').single();
  if (docErr) throw docErr;

  const { data: s, error: sErr } = await db.from('statements').insert({
    document_id: doc.id,
    bank_account_id: bankAccountId,
    period_start: parsed.periodStart,
    period_end: parsed.periodEnd,
    opening_balance_cents: openingBalanceCents,
    closing_balance_cents: closingBalanceCents,
    extract_method: 'csv',
    extract_version: `${fmt.id}@${fmt.version}`,
    checksum_ok: true,          // closing is derived, so it balances by construction
    checksum_delta_cents: 0,
  }).select('id').single();
  if (sErr) throw sErr;

  await db.from('bank_transactions').insert(
    parsed.transactions.map(t => ({
      statement_id: s.id,
      bank_account_id: bankAccountId,
      posted_on: t.postedOn,
      amount_cents: t.amountCents,
      descriptor: t.descriptor,
      check_no: t.checkNo ?? null,
      page_no: null,
      line_no: t.lineNo ?? null,
    })),
  );

  await db.from('audit_log').insert({
    actor: actor(), action: 'ingest_csv', table_name: 'statements', row_id: s.id,
    after: { sha256: hash, period_end: parsed.periodEnd, closing: closingBalanceCents, anchored: !!prior },
  });

  return {
    status: 'ingested',
    documentId: doc.id,
    message: `${parsed.periodStart}..${parsed.periodEnd}  ${parsed.transactions.length} txns  ` +
      `open ${formatCents(openingBalanceCents)} -> close ${formatCents(closingBalanceCents)}` +
      (prior ? '' : '  (seeded opening)'),
  };
}
