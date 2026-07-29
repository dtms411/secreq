import { basename } from 'node:path';
import { stat } from 'node:fs/promises';
import { db, actor } from './db.js';
import { sha256, pageCount, extractPages, looksScanned } from './pdf.js';
import { ocrAvailable, ocrPages } from './ocr.js';
import { selectParser } from './parsers/registry.js';
import { verify, diagnose } from './checksum.js';
import { formatCents } from './parsers/types.js';

export interface IngestResult {
  status: 'ingested' | 'duplicate' | 'quarantined';
  documentId?: string;
  message: string;
}

export interface IngestOptions {
  /** Attempt OCR on scanned pages instead of quarantining them. Off by default:
   *  OCR is model-read and must be opted into, so a machine-read run never
   *  silently mixes in OCR'd figures. */
  ocr?: boolean;
}

/**
 * One statement, one transaction. Either the whole document lands with a
 * passing checksum or nothing lands at all -- a partially ingested statement
 * is worse than an absent one because it looks complete.
 */
export async function ingestPdf(path: string, bankAccountId: string, opts: IngestOptions = {}): Promise<IngestResult> {
  const hash = await sha256(path);

  const { data: existing } = await db
    .from('documents').select('id').eq('sha256', hash).maybeSingle();
  if (existing) {
    return { status: 'duplicate', documentId: existing.id, message: `already ingested as ${existing.id}` };
  }

  let pages = await extractPages(path);
  let method: 'pdftotext' | 'ocr' = 'pdftotext';
  if (looksScanned(pages)) {
    if (!opts.ocr) {
      return { status: 'quarantined', message: 'no text layer -- this is a scan and needs OCR (pass --ocr)' };
    }
    if (!(await ocrAvailable())) {
      return { status: 'quarantined', message: 'scan needs OCR but tesseract/pdftoppm are not installed' };
    }
    pages = await ocrPages(path, await pageCount(path));
    method = 'ocr';
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
  // One atomic transaction (see migration 0004). Either the document, its pages,
  // the statement, and every transaction all land, or none do — no partial
  // ingest, no orphaned document to wedge the sha256 dedup.
  const { data: docId, error: rpcErr } = await db.rpc('ingest_statement', {
    p_document: {
      sha256: hash, filename: basename(path), kind: 'bank_statement_pdf',
      bank_account_id: bankAccountId, building_id: acct?.building_id ?? null,
      storage_path: path, byte_size: size, page_count: await pageCount(path),
      uploaded_by: actor(),
    },
    p_pages: pages.map((raw_text, i) => ({ page_no: i + 1, raw_text })),
    p_statement: {
      bank_account_id: bankAccountId,
      period_start: stmt.periodStart, period_end: stmt.periodEnd,
      opening_balance_cents: stmt.openingBalanceCents, closing_balance_cents: stmt.closingBalanceCents,
      extract_method: method, extract_version: `${parser.id}@${parser.version}`,
      checksum_ok: true, checksum_delta_cents: 0,
    },
    p_transactions: stmt.transactions.map(t => ({
      posted_on: t.postedOn, amount_cents: t.amountCents, descriptor: t.descriptor,
      check_no: t.checkNo ?? null, page_no: t.pageNo ?? null, line_no: t.lineNo ?? null,
    })),
  });
  if (rpcErr) throw rpcErr;

  return {
    status: 'ingested',
    documentId: docId as string,
    message: `${stmt.periodStart}..${stmt.periodEnd}  ${stmt.transactions.length} txns  closing ${formatCents(stmt.closingBalanceCents)}`,
  };
}
