-- Atomic ingest. supabase-js has no client-side transaction: each .insert() is
-- a separate HTTP request, so a multi-step ingest could partially commit —
-- e.g. a statements row with checksum_ok=true but zero transactions (looks
-- complete, isn't), and an orphaned documents row that wedges the sha256 dedup
-- forever because the append-only trigger forbids deleting it.
--
-- This function does the whole ingest in one transaction. If any step fails,
-- the whole thing rolls back: nothing commits, no orphan document, no wedge.
-- The all-or-nothing promise in the pipeline is enforced here, in the database,
-- not hoped for across four independent requests.

create or replace function ingest_statement(
  p_document     jsonb,   -- sha256, filename, kind, building_id, bank_account_id, storage_path, byte_size, page_count, received_from, uploaded_by
  p_pages        jsonb,   -- [{page_no, raw_text}]
  p_statement    jsonb,   -- bank_account_id, period_start, period_end, opening_balance_cents, closing_balance_cents, extract_method, extract_version, checksum_ok, checksum_delta_cents
  p_transactions jsonb    -- [{posted_on, amount_cents, descriptor, check_no, counterparty, page_no, line_no}]
) returns uuid
language plpgsql as $$
declare
  v_doc_id  uuid;
  v_stmt_id uuid;
  v_acct    uuid := (p_statement->>'bank_account_id')::uuid;
begin
  insert into documents (sha256, filename, kind, building_id, bank_account_id,
                         storage_path, byte_size, page_count, received_from, uploaded_by)
  values (
    p_document->>'sha256', p_document->>'filename', (p_document->>'kind')::doc_kind,
    nullif(p_document->>'building_id', '')::uuid, (p_document->>'bank_account_id')::uuid,
    p_document->>'storage_path', (p_document->>'byte_size')::bigint,
    nullif(p_document->>'page_count', '')::int, nullif(p_document->>'received_from', ''),
    p_document->>'uploaded_by'
  ) returning id into v_doc_id;

  insert into document_pages (document_id, page_no, raw_text)
  select v_doc_id, (pg->>'page_no')::int, pg->>'raw_text'
  from jsonb_array_elements(p_pages) as pg;

  insert into statements (document_id, bank_account_id, period_start, period_end,
                          opening_balance_cents, closing_balance_cents,
                          extract_method, extract_version, checksum_ok, checksum_delta_cents)
  values (
    v_doc_id, v_acct,
    (p_statement->>'period_start')::date, (p_statement->>'period_end')::date,
    (p_statement->>'opening_balance_cents')::bigint, (p_statement->>'closing_balance_cents')::bigint,
    (p_statement->>'extract_method')::extract_method, p_statement->>'extract_version',
    (p_statement->>'checksum_ok')::boolean, (p_statement->>'checksum_delta_cents')::bigint
  ) returning id into v_stmt_id;

  insert into bank_transactions (statement_id, bank_account_id, posted_on, amount_cents,
                                 descriptor, check_no, counterparty, page_no, line_no)
  select v_stmt_id, v_acct,
         (t->>'posted_on')::date, (t->>'amount_cents')::bigint, t->>'descriptor',
         nullif(t->>'check_no', ''), nullif(t->>'counterparty', ''),
         nullif(t->>'page_no', '')::int, nullif(t->>'line_no', '')::int
  from jsonb_array_elements(p_transactions) as t;

  insert into audit_log (actor, action, table_name, row_id, after)
  values (
    p_document->>'uploaded_by',
    'ingest_' || (p_statement->>'extract_method'),
    'statements', v_stmt_id::text,
    jsonb_build_object('sha256', p_document->>'sha256',
                       'period_end', p_statement->>'period_end',
                       'closing', p_statement->>'closing_balance_cents')
  );

  return v_doc_id;
end $$;
