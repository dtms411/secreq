'use client';

import { STAGES, dollarsToCents, type CustodyRow, type Stage } from '@/lib/custody';

// The custody record editor — add a new tenant's deposit, or advance an existing
// one through its stages. Money is entered in dollars and converted to integer
// cents on save (never float); an unparseable figure is rejected rather than
// posted wrong. The page owns the write (DB in real mode, local state in demo);
// this component only collects and validates.

export interface Draft {
  building_id: string;
  unit: string;
  tenant_name: string;
  kind: 'initial' | 'additional';
  amount: string;              // dollars
  received_on: string;
  sent_to_bank_on: string;
  bank_cleared_on: string;
  in_master: string;           // dollars
  subaccount_last4: string;
  subaccount_opened_on: string;
  allocated_on: string;
  stage: Stage;
  responsible_employee: string;
  next_action: string;
  vacate_date: string;
  bank_account_closed_on: string;
  funds_returned_on: string;
  funds_returned: string;      // dollars
  refunded_on: string;
  refunded: string;            // dollars
  final_status: string;
}

// cents → editable dollars, without float math.
function centsToInput(c: number | null | undefined): string {
  if (c == null) return '';
  const neg = c < 0 ? '-' : '';
  const a = Math.abs(c);
  return `${neg}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

export function blankDraft(): Draft {
  return {
    building_id: '', unit: '', tenant_name: '', kind: 'initial', amount: '',
    received_on: '', sent_to_bank_on: '', bank_cleared_on: '', in_master: '',
    subaccount_last4: '', subaccount_opened_on: '', allocated_on: '', stage: 'received',
    responsible_employee: '', next_action: '', vacate_date: '', bank_account_closed_on: '',
    funds_returned_on: '', funds_returned: '', refunded_on: '', refunded: '', final_status: '',
  };
}

export function draftFromRow(r: CustodyRow): Draft {
  return {
    building_id: r.building_id ?? '', unit: r.unit, tenant_name: r.tenant_name, kind: r.kind,
    amount: centsToInput(r.amount_cents),
    received_on: r.received_on ?? '', sent_to_bank_on: r.sent_to_bank_on ?? '', bank_cleared_on: r.bank_cleared_on ?? '',
    in_master: centsToInput(r.in_master_cents),
    subaccount_last4: r.subaccount_last4 ?? '', subaccount_opened_on: r.subaccount_opened_on ?? '', allocated_on: r.allocated_on ?? '',
    stage: r.stage, responsible_employee: r.responsible_employee ?? '', next_action: r.next_action ?? '',
    vacate_date: r.vacate_date ?? '', bank_account_closed_on: r.bank_account_closed_on ?? '',
    funds_returned_on: r.funds_returned_on ?? '', funds_returned: centsToInput(r.funds_returned_cents),
    refunded_on: r.refunded_on ?? '', refunded: centsToInput(r.refunded_cents), final_status: r.final_status ?? '',
  };
}

const d = (s: string) => (s.trim() ? s.trim() : null);

export type ColumnResult =
  | { ok: true; cols: Record<string, unknown> }
  | { ok: false; error: string };

/** Validate the draft and build the snake_case column payload, or an error. */
export function draftToColumns(t: Draft): ColumnResult {
  if (!t.building_id) return { ok: false, error: 'Pick a building.' };
  if (!t.unit.trim()) return { ok: false, error: 'Unit is required.' };
  if (!t.tenant_name.trim()) return { ok: false, error: 'Tenant is required.' };

  const amount_cents = dollarsToCents(t.amount);
  if (amount_cents === null) return { ok: false, error: 'Deposit amount is not a valid figure.' };
  if (amount_cents <= 0) return { ok: false, error: 'Deposit amount must be greater than zero.' };

  const in_master_cents = dollarsToCents(t.in_master);
  if (in_master_cents === null) return { ok: false, error: 'In-Master amount is not a valid figure.' };
  if (in_master_cents < 0) return { ok: false, error: 'In-Master amount cannot be negative.' };
  if (in_master_cents > amount_cents) return { ok: false, error: 'In-Master amount cannot exceed the deposit.' };

  const funds_returned_cents = t.funds_returned.trim() ? dollarsToCents(t.funds_returned) : null;
  if (funds_returned_cents === null && t.funds_returned.trim()) return { ok: false, error: 'Funds-returned amount is not a valid figure.' };
  const refunded_cents = t.refunded.trim() ? dollarsToCents(t.refunded) : null;
  if (refunded_cents === null && t.refunded.trim()) return { ok: false, error: 'Refunded amount is not a valid figure.' };

  return {
    ok: true,
    cols: {
      building_id: t.building_id, unit: t.unit.trim(), tenant_name: t.tenant_name.trim(), kind: t.kind,
      amount_cents, in_master_cents,
      received_on: d(t.received_on), sent_to_bank_on: d(t.sent_to_bank_on), bank_cleared_on: d(t.bank_cleared_on),
      subaccount_last4: d(t.subaccount_last4), subaccount_opened_on: d(t.subaccount_opened_on), allocated_on: d(t.allocated_on),
      stage: t.stage, responsible_employee: d(t.responsible_employee), next_action: d(t.next_action),
      vacate_date: d(t.vacate_date), bank_account_closed_on: d(t.bank_account_closed_on),
      funds_returned_on: d(t.funds_returned_on), funds_returned_cents,
      refunded_on: d(t.refunded_on), refunded_cents, final_status: d(t.final_status),
    },
  };
}

interface Props {
  draft: Draft;
  isNew: boolean;
  buildings: { id: string; name: string }[];
  saving: boolean;
  error: string | null;
  onChange: (d: Draft) => void;
  onSave: (d: Draft) => void;
  onCancel: () => void;
}

export function CustodyEditor({ draft, isNew, buildings, saving, error, onChange, onSave, onCancel }: Props) {
  const set = (k: keyof Draft, v: string) => onChange({ ...draft, [k]: v });
  const Text = (k: keyof Draft, label: string, extra?: { placeholder?: string; hint?: string }) => (
    <div className="field">
      <label>{label}</label>
      <input value={draft[k] as string} placeholder={extra?.placeholder} onChange={(e) => set(k, e.target.value)} />
      {extra?.hint && <span className="hint">{extra.hint}</span>}
    </div>
  );
  const Date_ = (k: keyof Draft, label: string) => (
    <div className="field">
      <label>{label}</label>
      <input type="date" value={draft[k] as string} onChange={(e) => set(k, e.target.value)} />
    </div>
  );

  return (
    <div>
      <div className="card-sub">{isNew ? 'New deposit — a tenant just paid, or an additional deposit was collected.' : 'Advance this deposit through its stages. Every change is audit-logged.'}</div>
      <div className="form-grid">
        <div className="field">
          <label>Building</label>
          <select value={draft.building_id} onChange={(e) => set('building_id', e.target.value)}>
            <option value="">— select —</option>
            {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        {Text('unit', 'Unit', { placeholder: '4B' })}
        {Text('tenant_name', 'Tenant', { placeholder: 'Last F' })}
        <div className="field">
          <label>Deposit type</label>
          <select value={draft.kind} onChange={(e) => set('kind', e.target.value)}>
            <option value="initial">initial</option>
            <option value="additional">additional</option>
          </select>
        </div>
        {Text('amount', 'Deposit amount', { placeholder: '2,500.00', hint: 'dollars' })}
        <div className="field">
          <label>Stage</label>
          <select value={draft.stage} onChange={(e) => set('stage', e.target.value)}>
            {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div className="section-label">Banking</div>
        {Date_('received_on', 'Received')}
        {Date_('sent_to_bank_on', 'Sent to bank')}
        {Date_('bank_cleared_on', 'Bank cleared')}

        <div className="section-label">Master &amp; subaccount</div>
        {Text('in_master', 'In Master (pooled)', { placeholder: '0.00', hint: 'dollars still pooled' })}
        {Text('subaccount_last4', 'Subaccount (last 4)', { placeholder: '7788' })}
        {Date_('subaccount_opened_on', 'Subaccount opened')}
        {Date_('allocated_on', 'Allocated to subaccount')}
        {Text('responsible_employee', 'Responsible')}
        {Text('next_action', 'Next action')}

        <div className="section-label">Move-out &amp; disposition</div>
        {Date_('vacate_date', 'Vacate date')}
        {Date_('bank_account_closed_on', 'Bank account closed')}
        {Date_('funds_returned_on', 'Funds returned (by bank)')}
        {Text('funds_returned', 'Funds returned amount', { hint: 'dollars' })}
        {Date_('refunded_on', 'Refunded (to tenant)')}
        {Text('refunded', 'Refunded amount', { hint: 'dollars' })}
        {Text('final_status', 'Final status')}
      </div>

      {error && <div className="form-error" style={{ marginTop: 12 }}>{error}</div>}
      <div className="form-actions">
        <button className="btn btn-primary" disabled={saving} onClick={() => onSave(draft)}>
          {saving ? 'Saving…' : isNew ? 'Add deposit' : 'Save changes'}
        </button>
        <button className="btn" disabled={saving} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
