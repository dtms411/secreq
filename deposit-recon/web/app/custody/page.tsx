'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCents } from '@/lib/format';
import { DemoBanner, demoCustodyRecords, demoBuildings, demoMasterBankBalanceCents } from '@/lib/demo';
import {
  STAGES, AGE_LIMIT, dollarsToCents, rollup, agingFrom, type CustodyRow, type Stage,
} from '@/lib/custody';
import { CustodyEditor, type Draft, blankDraft, draftFromRow, draftToColumns } from './CustodyEditor';

// The operational custody view — the office tracker, tied in. The spreadsheet
// seeds the initial bulk load (custody-import); from here, new tenants are added
// and deposits advanced through their stages directly, each write audit-logged
// (migration 0006). Tie-out asks "does the bank agree with the leases"; this
// answers "where is each deposit right now", with Master-account aging as the
// headline control.

const SELECT = '*, buildings(name)';

export default function Custody() {
  const [records, setRecords] = useState<CustodyRow[]>([]);
  const [buildings, setBuildings] = useState<{ id: string; name: string }[]>([]);
  const [masterBank, setMasterBank] = useState<number | null>(null);
  const [demo, setDemo] = useState(false);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  function loadDemo() {
    setRecords(demoCustodyRecords);
    setBuildings(demoBuildings);
    setMasterBank(demoMasterBankBalanceCents);
    setDemo(true);
  }

  function load() {
    supabase.from('custody_deposits').select(SELECT).order('received_on', { ascending: false })
      .then(({ data, error }) => {
        if (error || !data || data.length === 0) { loadDemo(); return; }
        setRecords((data as any[]).map((d) => ({ ...d, building: d.buildings?.name ?? d.building_id })) as CustodyRow[]);
        setDemo(false);
        supabase.from('buildings').select('id, name').order('name')
          .then(({ data: b }) => setBuildings((b ?? []) as { id: string; name: string }[]), () => {});
      }, loadDemo);
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const view = rollup(records, today);
  const aging = agingFrom(records, today);
  const masterVariance = masterBank == null ? null : masterBank - view.inMaster;

  function startAdd() { setErr(null); setEditingId(null); setEditing(blankDraft()); }
  function startEdit(r: CustodyRow) { setErr(null); setEditingId(r.id); setEditing(draftFromRow(r)); }
  function cancel() { setEditing(null); setEditingId(null); setErr(null); }

  async function save(draft: Draft) {
    setErr(null);
    const result = draftToColumns(draft);
    if (!result.ok) { setErr(result.error); return; }
    const cols = result.cols;

    if (demo) {
      const name = buildings.find((b) => b.id === cols.building_id)?.name ?? String(cols.building_id);
      if (editingId) {
        setRecords((rs) => rs.map((r) => (r.id === editingId ? { ...r, ...cols, building: name } as CustodyRow : r)));
      } else {
        setRecords((rs) => [{ id: `local-${rs.length + 1}`, building: name, ...cols } as CustodyRow, ...rs]);
      }
      cancel();
      return;
    }

    setSaving(true);
    const res = editingId
      ? await supabase.from('custody_deposits').update(cols).eq('id', editingId)
      : await supabase.from('custody_deposits').insert(cols);
    setSaving(false);
    if (res.error) { setErr(res.error.message); return; }
    cancel();
    load();
  }

  return (
    <>
      <h1 className="page-title">Custody control</h1>
      <p className="page-sub">
        The operational tracker, tied in. The spreadsheet seeds the first bulk load; from here new tenants are
        added and deposits advanced through their stages right on this page. Custody rows are the office&rsquo;s
        claims — they reconcile <em>against</em> the bank, never replacing the lease universe.
      </p>
      {demo && <DemoBanner />}

      <div className="stats">
        <div className="stat">
          <div className="stat-label">Total security received</div>
          <div className="stat-num">{formatCents(view.received)}</div>
          <div className="stat-sub">{records.length} deposit{records.length === 1 ? '' : 's'} · {view.buildings} building{view.buildings === 1 ? '' : 's'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">In Master (pooled)</div>
          <div className={'stat-num' + (view.agedCount ? ' neg' : '')}>{formatCents(view.inMaster)}</div>
          <div className="stat-sub">{view.agedCount ? `${view.agedCount} aged past ${AGE_LIMIT} days` : 'none aged'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">In tenant subaccounts</div>
          <div className="stat-num pos">{formatCents(view.inSub)}</div>
          <div className="stat-sub">segregated, per tenant</div>
        </div>
        <div className="stat">
          <div className="stat-label">Refund pending</div>
          <div className={'stat-num' + (view.refundPending ? ' neg' : '')}>{view.refundPending}</div>
          <div className="stat-sub">returned by bank, tenant unpaid</div>
        </div>
      </div>

      {masterVariance != null && (
        <div className="card">
          <div className="card-title">Master account — custody vs bank</div>
          <div className="card-sub">
            What the tracker claims is pooled, against the Santander Master statement balance. A negative
            variance means the bank holds <em>less</em> than the tracker says is there.
          </div>
          <table>
            <tbody>
              <tr><td className="name">Tracker claims pooled in Master</td><td className="num">{formatCents(view.inMaster)}</td></tr>
              <tr><td className="name">Santander Master statement balance</td><td className="num">{formatCents(masterBank)}</td></tr>
              <tr>
                <td className="name">Variance (bank &minus; claim)</td>
                <td className={'num' + (masterVariance < 0 ? ' neg' : '')}>{formatCents(masterVariance)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="card-title">Master-account aging</div>
        <div className="card-sub">
          Every dollar still pooled in Master, oldest first. <span className="flag">!!</span> = past {AGE_LIMIT} days —
          it should have been moved into the tenant&rsquo;s own subaccount by now.
        </div>
        <table>
          <thead>
            <tr>
              <th className="num">Days</th><th>Building</th><th>Unit</th><th>Tenant</th>
              <th className="num">In Master</th><th>Since</th><th>Stage</th><th>Owner</th><th>Next action</th><th></th>
            </tr>
          </thead>
          <tbody>
            {aging.length === 0 && <tr><td colSpan={10} className="muted">Nothing pooled in Master.</td></tr>}
            {aging.map((r) => {
              const aged = (r.days_in_master ?? 0) > AGE_LIMIT;
              return (
                <tr key={r.id}>
                  <td className={'num' + (aged ? ' neg' : '')}>{r.days_in_master ?? '—'}</td>
                  <td className="muted">{r.building ?? r.building_id ?? '—'}</td>
                  <td>{r.unit}</td>
                  <td className="name">{r.tenant_name}</td>
                  <td className="num">{formatCents(r.in_master_cents)}</td>
                  <td className="muted">{r.since ?? '—'}</td>
                  <td className="muted">{r.stage}</td>
                  <td className="muted">{r.responsible_employee ?? '—'}</td>
                  <td style={{ color: 'var(--ink-2)' }}>{r.next_action ?? '—'}</td>
                  <td>{aged ? <span className="flag">!!</span> : ''}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th /><th colSpan={3}>Total pooled in Master</th>
              <th className="num">{formatCents(aging.reduce((t, r) => t + r.in_master_cents, 0))}</th>
              <th colSpan={5} />
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="card">
        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="card-title" style={{ margin: 0 }}>Custody records</div>
          {!editing && <button className="btn btn-primary" onClick={startAdd}>+ New deposit</button>}
        </div>

        {editing && (
          <CustodyEditor
            draft={editing}
            isNew={!editingId}
            buildings={buildings}
            saving={saving}
            error={err}
            onChange={setEditing}
            onSave={save}
            onCancel={cancel}
          />
        )}

        {!editing && (
          <table>
            <thead>
              <tr>
                <th>Unit</th><th>Tenant</th><th>Building</th><th>Kind</th>
                <th className="num">Amount</th><th className="num">In Master</th><th>Subacct</th><th>Stage</th><th></th>
              </tr>
            </thead>
            <tbody>
              {records.length === 0 && <tr><td colSpan={9} className="muted">No custody records yet. Import the tracker, or add a deposit.</td></tr>}
              {records.map((r) => (
                <tr key={r.id}>
                  <td>{r.unit}</td>
                  <td className="name">{r.tenant_name}</td>
                  <td className="muted">{r.building ?? r.building_id ?? '—'}</td>
                  <td className="muted">{r.kind}</td>
                  <td className="num">{formatCents(r.amount_cents)}</td>
                  <td className={'num' + (r.in_master_cents > 0 ? ' neg' : '')}>{formatCents(r.in_master_cents)}</td>
                  <td className="muted">{r.subaccount_last4 ?? '—'}</td>
                  <td><span className="badge badge-stage">{r.stage}</span></td>
                  <td><button className="btn" onClick={() => startEdit(r)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
