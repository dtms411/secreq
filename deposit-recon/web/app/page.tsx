'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCents } from '@/lib/format';
import { DemoBanner, demoTieout } from '@/lib/demo';

interface Row {
  building_id: string; name: string; unit_count: number; interest_required: boolean;
  as_of: string | null; checksum_ok: boolean | null;
  bank_cents: number | null; ledger_cents: number | null; expected_cents: number | null;
  ledger_variance_cents: number | null; expected_variance_cents: number | null;
}

export default function TieOut() {
  const [rows, setRows] = useState<Row[]>([]);
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    supabase.from('v_building_tieout').select('*').order('expected_variance_cents', { ascending: true })
      .then(({ data, error }) => {
        if (error || !data || data.length === 0) { setRows(demoTieout as Row[]); setDemo(true); }
        else setRows(data as Row[]);
      });
  }, []);

  // Reconcile over buildings that actually have a statement, so the tiles agree:
  // Escrow held − Lease universe === Expected variance. A no-statement building
  // has an unknown bank balance and no defined variance; counting its expected
  // in the universe but not its (null) bank would make the tiles fail to add up.
  const reconciled = rows.filter((r) => r.bank_cents != null);
  const bank = reconciled.reduce((a, r) => a + (r.bank_cents ?? 0), 0);
  const universe = reconciled.reduce((a, r) => a + (r.expected_cents ?? 0), 0);
  const variance = reconciled.reduce((a, r) => a + (r.expected_variance_cents ?? 0), 0);
  const noStatement = rows.length - reconciled.length;

  return (
    <>
      <h1 className="page-title">Tie-out</h1>
      <p className="page-sub">
        Escrow balances against the independently-built lease universe. A negative variance means the trust
        account holds <em>less</em> than the leases imply — money that never arrived.
      </p>
      {demo && <DemoBanner />}

      <div className="stats">
        <div className="stat">
          <div className="stat-label">Buildings</div>
          <div className="stat-num">{rows.length}</div>
          <div className="stat-sub">{noStatement ? `${reconciled.length} reconciled · ${noStatement} no statement` : 'escrow accounts reconciled'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Escrow held</div>
          <div className="stat-num">{formatCents(bank)}</div>
          <div className="stat-sub">latest statement balances</div>
        </div>
        <div className="stat">
          <div className="stat-label">Lease universe</div>
          <div className="stat-num">{formatCents(universe)}</div>
          <div className="stat-sub">deposits owed per leases</div>
        </div>
        <div className="stat">
          <div className="stat-label">Expected variance</div>
          <div className={'stat-num ' + (variance < 0 ? 'neg' : variance > 0 ? 'pos' : '')}>{formatCents(variance)}</div>
          <div className="stat-sub">{variance < 0 ? 'shortfall vs. lease universe' : 'bank vs. lease universe'}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">By building</div>
        <div className="card-sub">
          <span className="flag">!!</span> = latest statement failed the checksum gate.
          {noStatement > 0 && ` ${noStatement} building${noStatement === 1 ? '' : 's'} without a statement are shown but excluded from portfolio totals.`}
        </div>
        <table>
          <thead>
            <tr>
              <th>Building</th><th>As of</th>
              <th className="num">Bank</th><th className="num">Ledger</th><th className="num">Expected</th>
              <th className="num">Ledger var.</th><th className="num">Expected var.</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.building_id}>
                <td className="name">{r.name}</td>
                <td className="muted">{r.as_of ?? 'no statement'}</td>
                <td className="num">{formatCents(r.bank_cents)}</td>
                <td className="num">{formatCents(r.ledger_cents)}</td>
                <td className="num">{formatCents(r.expected_cents)}</td>
                <td className={'num' + ((r.ledger_variance_cents ?? 0) < 0 ? ' neg' : '')}>{formatCents(r.ledger_variance_cents)}</td>
                <td className={'num' + ((r.expected_variance_cents ?? 0) < 0 ? ' neg' : '')}>{formatCents(r.expected_variance_cents)}</td>
                <td>{r.checksum_ok === false ? <span className="flag">!!</span> : ''}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><th colSpan={6}>Portfolio expected variance</th><th className={'num' + (variance < 0 ? ' neg' : '')}>{formatCents(variance)}</th><th /></tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}
