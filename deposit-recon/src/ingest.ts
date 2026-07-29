import { basename } from 'node:path';
import { stat } from 'node:fs/promises';
import { db, actor } from './db.js';
import { sha256, pageCount, extractPages, looksScanned } from './pdf.js';
import { selectParser } from './parsers/registry.js';
import { verify, diagnose } from './checksum.js';
import { formatCents } from './parsers/types.js';

export interface IngestResult {
  status: 'ingested' | 'duplicate' | 'quarantined';
  documentId?: string;
  message: string;
}

/**
 * One statement, one transaction. Either the whole document lands with a
 * passing checksum or nothing lands at all -- a partially ingested statement
 * is worse than an absent one because it looks complete.
 */
export async function ingestPdf(path: string, bankAccountId: string): Promise<IngestResult> {
  const hash = await sha256(path);

  const { data: existing } = await db
    .from('documents').select('id').eq('sha256', hash).maybeSingle();
  if (existing) {
    return { status: 'duplicate', documentId: existing.id, message: `already ingested as ${existing.id}` };
  }

  const pages = await extractPages(path);
  if (looksScanned(pages)) {
    return { status: 'quarantined', message: 'no text layer -- this is a scan and needs OCR' };
  }

  const parser = selectParser(pages[0] ?? '');
  const stmt = parser.parse(pages);
  const check = verify(stmt);

  const { data: acct } = await db
    .from('bank_accounts').select('account_last4, building_id').eq('id', bankAccountId).single();
  if (acct && acct.account_last4 !== stmt.accountLast4) {
    return {
      status: 'quarantined',
      message: `account mismatch: file shows ....${stmt.accountLast4}, target is ....${acct.account_last4}`,
    };
  }

  if (!check.ok) {
    return {
      status: 'quarantined',
      message: [check.message, ...diagnose(check, stmt).map(h => `  hint: ${h}`)].join('\n'),
    };
  }

  const { size } = await stat(path);
  const { data: doc, error: docErr } = await db.from('documents').insert({
    sha256: hash,
    filename: basename(path),
    kind: 'bank_statement_pdf',
    bank_account_id: bankAccountId,
    building_id: acct?.building_id ?? null,
    storage_path: path,
    byte_size: size,
    page_count: await pageCount(path),
    uploaded_by: actor(),
  }).select('id').single();
  if (docErr) throw docErr;

  await db.from('document_pages').insert(
    pages.map((raw_text, i) => ({ document_id: doc.id, page_no: i + 1, raw_text })),
  );

  const { data: s, error: sErr } = await db.from('statements').insert({
    document_id: doc.id,
    bank_account_id: bankAccountId,
    period_start: stmt.periodStart,
    period_end: stmt.periodEnd,
    opening_balance_cents: stmt.openingBalanceCents,
    closing_balance_cents: stmt.closingBalanceCents,
    extract_method: 'pdftotext',
    extract_version: `${parser.id}@${parser.version}`,
    checksum_ok: true,
    checksum_delta_cents: 0,
  }).select('id').single();
  if (sErr) throw sErr;

  await db.from('bank_transactions').insert(
    stmt.transactions.map(t => ({
      statement_id: s.id,
      bank_account_id: bankAccountId,
      posted_on: t.postedOn,
      amount_cents: t.amountCents,
      descriptor: t.descriptor,
      check_no: t.checkNo ?? null,
      page_no: t.pageNo ?? null,
      line_no: t.lineNo ?? null,
    })),
  );

  await db.from('audit_log').insert({
    actor: actor(), action: 'ingest', table_name: 'statements', row_id: s.id,
    after: { sha256: hash, period_end: stmt.periodEnd, closing: stmt.closingBalanceCents },
  });

  return {
    status: 'ingested',
    documentId: doc.id,
    message: `${stmt.periodStart}..${stmt.periodEnd}  ${stmt.transactions.length} txns  closing ${formatCents(stmt.closingBalanceCents)}`,
  };
}
