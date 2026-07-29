-- Browser access for the review UI. The deployment carries ONLY the anon
-- (publishable) key; the service key stays on the CLI host and never reaches
-- Vercel. Every browser request is therefore an `anon` or `authenticated`
-- request, governed entirely by the policies below.
--
-- Model: unauthenticated (`anon`) sees nothing. Authenticated users -- the
-- investigation access list, provisioned in Supabase Auth -- can read the
-- reconciliation data and make the two human decisions the system allows:
-- approving a match and triaging an exception. They cannot write financial
-- rows; those come only from the CLI under the service key. The append-only
-- triggers from 0001 still apply and are not weakened here.

-- ------------------------------------------------------ views respect RLS
-- Views run as their owner by default and would bypass RLS. Force them to run
-- with the caller's privileges so an anon request through a view still returns
-- nothing.
alter view v_lease_balance      set (security_invoker = on);
alter view v_latest_statement   set (security_invoker = on);
alter view v_building_tieout    set (security_invoker = on);
alter view v_open_deadlines     set (security_invoker = on);
alter view v_match_rate         set (security_invoker = on);

-- ---------------------------------------------------------- quarantine view
-- Statements that did not clear the checksum gate. Under the all-or-nothing
-- pipeline these should not exist (a failing statement never lands), so a
-- non-empty result here is itself a finding. The UI's quarantine queue reads
-- this alongside open critical/high exceptions.
create view v_quarantine as
select s.id as statement_id,
       s.bank_account_id,
       ba.building_id,
       s.period_start,
       s.period_end,
       s.checksum_delta_cents,
       s.extract_method,
       s.extract_version
from statements s
join bank_accounts ba on ba.id = s.bank_account_id
where s.checksum_ok is not true;
alter view v_quarantine set (security_invoker = on);

-- ----------------------------------------------------------------- read RLS
do $$
declare t text;
begin
  foreach t in array array[
    'buildings','bank_accounts','documents','document_pages','statements',
    'bank_transactions','leases','deposit_ledger','matches','exceptions',
    'deadline_notifications'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy read_authenticated on %I for select to authenticated using (true)', t);
  end loop;
end $$;

-- --------------------------------------------------- the two human decisions
-- Approve a match: set decided_by/decided_at. (Column-level restraint is left
-- to the app; the point here is that only authenticated users can touch it,
-- and inserts still come only from the service-key CLI.)
create policy decide_match on matches
  for update to authenticated using (true) with check (true);

-- Triage an exception: move status through open -> investigating -> resolved /
-- escalated and record the resolution.
create policy triage_exception on exceptions
  for update to authenticated using (true) with check (true);

-- ------------------------------------------------------------- storage bucket
-- Direct signed-URL upload target. Files are PUT to Storage straight from the
-- browser (never through a Next route), then the local CLI pulls, hashes, and
-- ingests them under the service key. Private bucket; authenticated-only.
insert into storage.buckets (id, name, public)
values ('statements', 'statements', false)
on conflict (id) do nothing;

create policy upload_statements on storage.objects
  for insert to authenticated
  with check (bucket_id = 'statements');

create policy read_statements on storage.objects
  for select to authenticated
  using (bucket_id = 'statements');
