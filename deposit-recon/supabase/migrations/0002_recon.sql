-- Additions for CSV continuity, the matching engine, exception detectors, and
-- the daily 14-day deadline clock. Same invariants as 0001: money is bigint
-- cents, new evidence tables are append-only, nothing auto-corrects.

-- ------------------------------------------------------- name normalization
-- Shared by the fuzzy matcher (payer vs. tenant of record) and mirrored in TS
-- (src/match/rules.ts). Punctuation and case are noise; a stable normal form
-- is what pg_trgm similarity should run against.
create or replace function normalize_name(p text) returns text
language sql immutable as $$
  select btrim(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', ' ', 'g'))
$$;

-- --------------------------------------------------- 14-day clock: escalations
-- Append-only record of every statutory-deadline escalation sent. The unique
-- (lease_id, stage) constraint is what makes the daily run idempotent: a stage
-- already sent for a lease cannot be sent again, so re-running the clock the
-- same day (or catching up after an outage) never double-notifies.
create table deadline_notifications (
  id          uuid primary key default gen_random_uuid(),
  lease_id    uuid not null references leases(id),
  stage       text not null check (stage in ('day7','day10','day14','overdue')),
  due_date    date not null,                 -- keys_returned_on + statutory days
  recipient   text,
  channel     text not null default 'email',
  provider_id text,                          -- Resend message id, for delivery audit
  detail      jsonb not null default '{}',
  sent_at     timestamptz not null default now(),
  unique (lease_id, stage)
);

create trigger t_immutable before update or delete on deadline_notifications
  for each row execute function forbid_mutation();

-- ------------------------------------------------------ open deadlines (view)
-- Leases whose keys are back and whose deposit has not been refunded. The
-- 14-day clock (GOL 7-108, and 7-107 as amended 15 Nov 2025 for stabilized
-- tenants) starts at keys_returned_on, which is deliberately distinct from
-- vacated_on. A "completed refund" is any refund entry in the deposit ledger;
-- partial refunds are a separate finding, not a closed deadline.
create view v_open_deadlines as
select l.id                       as lease_id,
       l.building_id,
       l.unit,
       l.tenant_name,
       l.is_rent_stabilized,
       l.keys_returned_on,
       (l.keys_returned_on + 14)  as due_date,
       l.expected_deposit_cents,
       coalesce(r.refunded_cents, 0) as refunded_cents
from leases l
left join (
  select lease_id, -sum(amount_cents) as refunded_cents
  from deposit_ledger
  where entry_type = 'refund'
  group by lease_id
) r on r.lease_id = l.id
where l.keys_returned_on is not null
  and coalesce(r.refunded_cents, 0) = 0;

-- ------------------------------------------------------ match rate (view)
-- Auto-match coverage, split by whether a human has decided. If the auto rate
-- runs high early, the rules are too loose (the brief flags ~85% as a smell).
create view v_match_rate as
select count(*)                                                   as bank_txns,
       count(m.id)                                                as suggested,
       count(m.id) filter (where m.decided_by is not null)        as decided,
       count(m.id) filter (where m.method = 'exact')              as exact,
       count(m.id) filter (where m.method = 'fuzzy')              as fuzzy
from bank_transactions bt
left join matches m on m.bank_transaction_id = bt.id;
