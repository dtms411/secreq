-- Security deposit reconciliation — initial schema
-- Design constraints:
--   1. All money is bigint CENTS. Signed: credits positive, debits negative.
--   2. Extracted and ledger tables are append-only (enforced by trigger).
--      Corrections are contra-entries via reverses_id, never UPDATE/DELETE.
--   3. Every derived number traces to (document_id, page_no, line_no).
--   4. Extraction method is recorded so machine-read and model-read numbers
--      are always distinguishable.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------- reference

create table buildings (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  address           text not null,
  borough           text,
  bbl               text,
  unit_count        int  not null,
  -- GOL 7-103: 6+ dwelling units requires an interest-bearing NY account
  interest_required boolean generated always as (unit_count >= 6) stored,
  acquired_on       date,
  created_at        timestamptz not null default now()
);

create table bank_accounts (
  id                  uuid primary key default gen_random_uuid(),
  building_id         uuid not null references buildings(id),
  bank_name           text not null,
  account_last4       text not null,
  account_type        text not null check (account_type in ('escrow','operating')),
  is_interest_bearing boolean not null default false,
  opened_on           date,
  closed_on           date,
  created_at          timestamptz not null default now()
);

create index on bank_accounts (building_id, account_type);

-- ---------------------------------------------------------- source documents

create type doc_kind       as enum ('bank_statement_pdf','bank_csv','check_image',
                                    'lease','ledger_export','correspondence','other');
create type extract_method as enum ('pdftotext','csv','ocr','llm','manual');

create table documents (
  id              uuid primary key default gen_random_uuid(),
  sha256          text not null unique,          -- dedup + tamper evidence
  filename        text not null,
  kind            doc_kind not null,
  building_id     uuid references buildings(id),
  bank_account_id uuid references bank_accounts(id),
  storage_path    text not null,
  byte_size       bigint not null,
  page_count      int,
  received_from   text,                          -- chain of custody
  uploaded_by     text not null,
  uploaded_at     timestamptz not null default now()
);

create table document_pages (
  document_id uuid not null references documents(id),
  page_no     int  not null,
  raw_text    text,
  primary key (document_id, page_no)
);

-- ------------------------------------------------------------- bank activity

create table statements (
  id                    uuid primary key default gen_random_uuid(),
  document_id           uuid not null references documents(id),
  bank_account_id       uuid not null references bank_accounts(id),
  period_start          date not null,
  period_end            date not null,
  opening_balance_cents bigint not null,
  closing_balance_cents bigint not null,
  extract_method        extract_method not null,
  extract_version       text not null,
  -- gate: opening + sum(transactions) must equal closing
  checksum_ok           boolean,
  checksum_delta_cents  bigint,
  extracted_at          timestamptz not null default now(),
  unique (bank_account_id, period_start, period_end)
);

create table bank_transactions (
  id              uuid primary key default gen_random_uuid(),
  statement_id    uuid not null references statements(id),
  bank_account_id uuid not null references bank_accounts(id),
  posted_on       date not null,
  amount_cents    bigint not null,               -- credit +, debit -
  descriptor      text not null,
  check_no        text,
  counterparty    text,                          -- parsed payee, if any
  page_no         int,
  line_no         int,
  created_at      timestamptz not null default now()
);

create index on bank_transactions (bank_account_id, posted_on);
create index on bank_transactions using gin (descriptor gin_trgm_ops);

-- --------------------------------------------------- leases (expected universe)

-- Built from lease files and rent roll history, NOT from the accounting
-- system. This is the independent baseline that reveals deposits which were
-- collected but never deposited.

create table leases (
  id                     uuid primary key default gen_random_uuid(),
  building_id            uuid not null references buildings(id),
  unit                   text not null,
  tenant_name            text not null,
  signed_on              date,
  term_start             date not null,
  term_end               date,
  vacated_on             date,
  keys_returned_on       date,                   -- starts the 14-day clock
  monthly_rent_cents     bigint not null,
  expected_deposit_cents bigint not null,
  is_rent_stabilized     boolean not null default false,
  source_document_id     uuid references documents(id),
  created_at             timestamptz not null default now()
);

create index on leases (building_id, unit);
create index on leases using gin (tenant_name gin_trgm_ops);

-- ------------------------------------------------------------ deposit ledger

create type ledger_type as enum (
  'initial_deposit','additional_deposit','interest_credit','admin_fee',
  'transfer_in','transfer_out','deduction','refund','escheat','adjustment'
);

create type ledger_source as enum (
  'system_of_record','bank_derived','lease_document','manual'
);

create table deposit_ledger (
  id          uuid primary key default gen_random_uuid(),
  lease_id    uuid not null references leases(id),
  entry_date  date not null,
  entry_type  ledger_type not null,
  amount_cents bigint not null,                  -- credit +, debit -
  source      ledger_source not null,
  document_id uuid references documents(id),
  reverses_id uuid references deposit_ledger(id),-- contra-entry, never delete
  note        text,
  created_by  text not null,
  created_at  timestamptz not null default now()
);

create index on deposit_ledger (lease_id, entry_date);

-- ------------------------------------------------------------------ matching

create table matches (
  id                  uuid primary key default gen_random_uuid(),
  bank_transaction_id uuid not null unique references bank_transactions(id),
  deposit_ledger_id   uuid references deposit_ledger(id),
  lease_id            uuid references leases(id),
  method              text not null check (method in ('exact','fuzzy','llm_suggested','manual')),
  confidence          numeric(4,3),
  decided_by          text,                      -- null until a human approves
  decided_at          timestamptz,
  created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------- exceptions

create table exceptions (
  id                  uuid primary key default gen_random_uuid(),
  kind                text not null,             -- e.g. 'unexplained_debit'
  severity            text not null check (severity in ('critical','high','medium','low')),
  building_id         uuid references buildings(id),
  lease_id            uuid references leases(id),
  bank_transaction_id uuid references bank_transactions(id),
  amount_cents        bigint,
  detail              jsonb not null default '{}',
  status              text not null default 'open'
                        check (status in ('open','investigating','resolved','escalated')),
  opened_at           timestamptz not null default now(),
  resolved_at         timestamptz,
  resolved_by         text,
  resolution          text
);

create index on exceptions (status, severity);

-- ----------------------------------------------------------------- audit log

create table audit_log (
  id         bigserial primary key,
  actor      text not null,
  action     text not null,
  table_name text not null,
  row_id     text,
  before     jsonb,
  after      jsonb,
  at         timestamptz not null default now()
);

-- --------------------------------------------------------- append-only guard

create or replace function forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception
    'append-only table %: % is not permitted (record a contra-entry instead)',
    tg_table_name, tg_op;
end $$;

create trigger t_immutable before update or delete on documents
  for each row execute function forbid_mutation();
create trigger t_immutable before update or delete on document_pages
  for each row execute function forbid_mutation();
create trigger t_immutable before update or delete on bank_transactions
  for each row execute function forbid_mutation();
create trigger t_immutable before update or delete on deposit_ledger
  for each row execute function forbid_mutation();
create trigger t_immutable before update or delete on audit_log
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------- checksum enforcement

create or replace function statement_checksum(p_statement_id uuid)
returns bigint language sql stable as $$
  select s.opening_balance_cents
       + coalesce((select sum(amount_cents) from bank_transactions
                    where statement_id = s.id), 0)
       - s.closing_balance_cents
  from statements s where s.id = p_statement_id;
$$;

-- ---------------------------------------------------------------- tie-out views

create view v_lease_balance as
select l.id as lease_id,
       l.building_id,
       l.unit,
       l.tenant_name,
       l.vacated_on,
       l.expected_deposit_cents,
       coalesce(sum(dl.amount_cents), 0) as ledger_balance_cents
from leases l
left join deposit_ledger dl on dl.lease_id = l.id
group by l.id;

create view v_latest_statement as
select distinct on (ba.building_id)
       ba.building_id,
       s.id as statement_id,
       s.period_end,
       s.closing_balance_cents,
       s.checksum_ok
from statements s
join bank_accounts ba on ba.id = s.bank_account_id
where ba.account_type = 'escrow'
order by ba.building_id, s.period_end desc;

-- The core report. Two independent variances:
--   ledger_variance   = bank vs. books        (money that left improperly)
--   expected_variance = bank vs. lease universe (money that never arrived)
create view v_building_tieout as
select b.id   as building_id,
       b.name,
       b.unit_count,
       b.interest_required,
       ls.period_end                as as_of,
       ls.checksum_ok,
       ls.closing_balance_cents     as bank_cents,
       coalesce(sub.ledger_cents, 0)   as ledger_cents,
       coalesce(sub.expected_cents, 0) as expected_cents,
       ls.closing_balance_cents - coalesce(sub.ledger_cents, 0)   as ledger_variance_cents,
       ls.closing_balance_cents - coalesce(sub.expected_cents, 0) as expected_variance_cents
from buildings b
left join v_latest_statement ls on ls.building_id = b.id
left join (
  select building_id,
         sum(ledger_balance_cents)                                as ledger_cents,
         sum(expected_deposit_cents) filter (where vacated_on is null) as expected_cents
  from v_lease_balance
  group by building_id
) sub on sub.building_id = b.id;
