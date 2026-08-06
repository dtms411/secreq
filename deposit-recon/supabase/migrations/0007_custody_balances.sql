-- Per-tenant bank ↔ accounting reconciliation on the custody record.
--
-- Each tenant deposit now carries two independently-entered balances: what the
-- BANK statement shows for that tenant's subaccount, and what the ACCOUNTING
-- system says should be there. Their difference — the variance — is the finding.
-- Kept independent on purpose: the accounting system is the thing under review,
-- so a bank-vs-books disagreement per tenant is exactly what this surfaces.
--
-- Nullable: a record may have neither yet (just captured), one, or both. The
-- variance is only meaningful where both are present. Every edit is still
-- audit-logged by the trigger from 0006.

alter table custody_deposits add column if not exists bank_balance_cents       bigint;
alter table custody_deposits add column if not exists accounting_balance_cents bigint;
alter table custody_deposits add column if not exists balance_as_of            date;

-- Per-tenant reconciliation view: bank − accounting, where both are known.
-- A negative variance means the bank holds LESS than the books say it should.
create view v_custody_balance_recon as
select cd.id, cd.building_id, cd.unit, cd.tenant_name, cd.kind,
       cd.bank_balance_cents, cd.accounting_balance_cents, cd.balance_as_of,
       (cd.bank_balance_cents - cd.accounting_balance_cents) as variance_cents,
       cd.stage, cd.subaccount_last4
from custody_deposits cd
where cd.bank_balance_cents is not null
  and cd.accounting_balance_cents is not null;

alter view v_custody_balance_recon set (security_invoker = on);
