-- Custody & lifecycle control — ties in the operational tracker.
--
-- The reconciliation side of this system (statements, ledger, leases) answers
-- "does the bank agree with the books and the leases". The custody side answers
-- the OPERATIONAL question the office tracker was built for: where is each
-- deposit right now in its journey — received, sent to the bank, sitting in the
-- Santander MASTER (pooled) account, allocated into a per-tenant SUBACCOUNT,
-- returned, refunded, closed — and what is stuck.
--
-- This is a system-of-record for custody CLAIMS. It is NOT the independent lease
-- baseline: the tie-out keeps its power only because bank, sub-ledger, and lease
-- files are independent, so custody data is reconciled AGAINST the bank, never
-- substituted for the lease universe.

-- ---- bank structure: Master + per-tenant subaccounts --------------------
-- The office uses a Santander master account with a subaccount per tenant, not
-- one escrow account per building. Extend the account types and let a
-- subaccount point at its tenant and its parent master.
alter table bank_accounts drop constraint if exists bank_accounts_account_type_check;
alter table bank_accounts add constraint bank_accounts_account_type_check
  check (account_type in ('escrow','operating','master','tenant_subaccount'));
alter table bank_accounts add column if not exists lease_id uuid references leases(id);
alter table bank_accounts add column if not exists parent_account_id uuid references bank_accounts(id);

-- ---- custody records -----------------------------------------------------
create type deposit_kind  as enum ('initial','additional');
create type custody_stage as enum (
  'received','sent_to_bank','bank_cleared','in_master','subaccount_pending',
  'in_subaccount','active','vacated','bank_closing','funds_returned','posted',
  'refunded','closed'
);

-- One row per deposit (an initial deposit and each additional deposit are
-- separate records — a lease can have many). Mutable: rows advance through
-- stages, so this is operational, not an append-only extraction table. Every
-- write is still audit-logged.
create table custody_deposits (
  id                    uuid primary key default gen_random_uuid(),
  building_id           uuid not null references buildings(id),
  lease_id              uuid references leases(id),
  unit                  text not null,
  tenant_name           text not null,
  kind                  deposit_kind not null,
  amount_cents          bigint not null,                 -- deposit amount, positive

  received_on           date,
  sent_to_bank_on       date,
  bank_cleared_on       date,

  in_master_cents       bigint not null default 0,       -- unallocated, sitting in Master
  subaccount_id         uuid references bank_accounts(id),
  subaccount_last4      text,
  subaccount_opened_on  date,
  allocated_on          date,                            -- Master -> subaccount

  stage                 custody_stage not null default 'received',
  next_action           text,
  responsible_employee  text,

  -- move-out / disposition
  vacate_date           date,
  bank_account_closed_on date,
  funds_returned_on     date,
  funds_returned_cents  bigint,
  posted_on             date,
  refunded_on           date,
  refunded_cents        bigint,
  applied_rent_cents    bigint not null default 0,
  applied_charges_cents bigint not null default 0,
  applied_legal_cents   bigint not null default 0,
  unresolved_cents      bigint not null default 0,
  final_status          text,

  external_ref          text,                            -- id/row key in the source tracker
  source_document_id    uuid references documents(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (building_id, unit, tenant_name, kind, amount_cents, received_on)  -- idempotent import
);

create index on custody_deposits (building_id, stage);
create index on custody_deposits (stage) where in_master_cents > 0;

-- ---- master-account aging (view) ----------------------------------------
-- Every dollar still in the Master account, with days outstanding since it
-- cleared the bank. This is the tracker's headline control: money must not
-- linger in Master.
create view v_master_account_aging as
select cd.id, cd.building_id, cd.unit, cd.tenant_name, cd.kind,
       cd.in_master_cents,
       coalesce(cd.bank_cleared_on, cd.sent_to_bank_on) as since,
       (current_date - coalesce(cd.bank_cleared_on, cd.sent_to_bank_on)) as days_in_master,
       cd.subaccount_last4, cd.stage, cd.responsible_employee, cd.next_action
from custody_deposits cd
where cd.in_master_cents > 0;

-- ---- custody summary (view) — the tracker's dashboard header ------------
create view v_custody_summary as
select cd.building_id,
       sum(cd.amount_cents)                                   as total_received_cents,
       sum(cd.in_master_cents)                                as in_master_cents,
       sum(case when cd.subaccount_id is not null then cd.amount_cents - cd.in_master_cents else 0 end) as in_subaccounts_cents,
       count(*) filter (where cd.stage in ('funds_returned','posted') and cd.refunded_on is null) as refund_pending,
       count(*) filter (where cd.stage = 'closed')            as closed_records,
       count(*) filter (where cd.in_master_cents > 0 and (current_date - coalesce(cd.bank_cleared_on, cd.sent_to_bank_on)) > 30) as master_aged_over_30
from custody_deposits cd
group by cd.building_id;

-- ---- RLS: browser reads, CLI writes (same model as every other table) ----
-- Views run as owner and would bypass RLS; force caller privileges so an anon
-- request through them still returns nothing (matches migration 0003).
alter view v_master_account_aging set (security_invoker = on);
alter view v_custody_summary      set (security_invoker = on);

-- custody_deposits is operational and mutable, but writes still come only from
-- the service-key CLI. Authenticated users (the investigation access list) may
-- read it; anon sees nothing.
alter table custody_deposits enable row level security;
create policy read_authenticated on custody_deposits for select to authenticated using (true);
