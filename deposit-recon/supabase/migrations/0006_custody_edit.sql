-- In-app custody editing. The spreadsheet seeds the initial bulk load
-- (custody-import); after that, new tenants are added and deposits are advanced
-- through their stages directly on the site. custody_deposits is operational and
-- mutable — unlike the append-only extraction tables — so this is allowed, under
-- two guardrails that keep it safe for a forensic system:
--
--   1. Only AUTHENTICATED users (the investigation access list) may write. The
--      browser carries the anon key; an anon request still writes nothing. Real
--      in-app editing therefore requires the sign-in gate to be re-enabled.
--   2. EVERY write is captured in the append-only audit_log by a database
--      trigger — insert, update, and delete alike, with before/after images and
--      the acting user — so the complete edit history is always reconstructable.
--      This fires for browser writes AND service-key CLI writes.

-- who made the change: the browser user's JWT email (or subject), falling back
-- to the database role for service-key CLI writes.
create or replace function custody_actor() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'email', ''),
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', ''),
    current_user
  );
$$;

-- touch updated_at on every edit (BEFORE, so the new value persists).
create or replace function touch_custody_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger custody_touch_updated
  before update on custody_deposits
  for each row execute function touch_custody_updated_at();

-- append-only audit image of every custody write (AFTER, so it reflects what
-- actually landed). audit_log is itself append-only, which INSERT satisfies.
create or replace function log_custody_change() returns trigger
language plpgsql as $$
begin
  if (tg_op = 'DELETE') then
    insert into audit_log (actor, action, table_name, row_id, before, after)
    values (custody_actor(), 'custody_delete', 'custody_deposits', old.id::text, to_jsonb(old), null);
    return old;
  elsif (tg_op = 'UPDATE') then
    insert into audit_log (actor, action, table_name, row_id, before, after)
    values (custody_actor(), 'custody_update', 'custody_deposits', new.id::text, to_jsonb(old), to_jsonb(new));
    return new;
  else
    insert into audit_log (actor, action, table_name, row_id, before, after)
    values (custody_actor(), 'custody_insert', 'custody_deposits', new.id::text, null, to_jsonb(new));
    return new;
  end if;
end $$;

create trigger custody_audit
  after insert or update or delete on custody_deposits
  for each row execute function log_custody_change();

-- the two write grants for the investigation access list. (0005 already enabled
-- RLS and granted select.) Inserts and updates only — custody records are not
-- hard-deleted from the UI; a disposed deposit moves to a terminal stage
-- ('refunded' / 'closed') instead, preserving the row and its audit trail.
create policy insert_custody_authenticated on custody_deposits
  for insert to authenticated with check (true);
create policy update_custody_authenticated on custody_deposits
  for update to authenticated using (true) with check (true);
