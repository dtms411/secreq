'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCents } from '@/lib/format';

interface Row {
  building_id: string; name: string; unit_count: number; interest_required: boolean;
  as_of: string | null; checksum_ok: boolean | null;
  bank_cents: number | null; ledger_cents: number | null; expected_cents: number | null;
  ledger_variance_cents: number | null; expected_variance_cents: number | null;
}

export default function TieOut() {
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState<string>();

  useEffect(() => {
    supabase.from('v_building_tieout').select('*').order('expected_variance_cents', { ascending: true })
      .then(({ data, error }) => { if (error) setErr(error.message); else setRows(data as Row[]); });
  }, []);

  const total = rows.reduce((a, r) => a + (r.expected_variance_cents ?? 0), 0);

  return (
    <>
      <h2 style={{ fontSize: 16 }}>Tie-out — bank vs. lease universe</h2>
      <p style={{ color: '#6b7280', fontSize: 13 }}>
        Negative expected-variance = escrow holds less than the lease universe implies (money that never arrived).
        <code style={{ marginLeft: 8 }}>!!</code> = latest statement failed the checksum gate.
      </p>
      {err && <p style={{ color: '#9ca3af', fontSize: 12 }}>data source not connected yet ({err})</p>}
      <table>
        <thead>
          <tr>
            <th>Building</th><th>As of</th>
            <th className="num">Bank</th><th className="num">Ledger</th><th className="num">Expected</th>
            <th className="num">Ledger var.</th><th className="num">Expected var.</th><th>ck</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.building_id}>
              <td>{r.name}</td>
              <td>{r.as_of ?? 'no statement'}</td>
              <td className="num">{formatCents(r.bank_cents)}</td>
              <td className="num">{formatCents(r.ledger_cents)}</td>
              <td className="num">{formatCents(r.expected_cents)}</td>
              <td className={'num' + ((r.ledger_variance_cents ?? 0) < 0 ? ' neg' : '')}>{formatCents(r.ledger_variance_cents)}</td>
              <td className={'num' + ((r.expected_variance_cents ?? 0) < 0 ? ' neg' : '')}>{formatCents(r.expected_variance_cents)}</td>
              <td>{r.checksum_ok === false ? <span className="neg">!!</span> : ''}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><th colSpan={6}>Portfolio expected variance</th><th className={'num' + (total < 0 ? ' neg' : '')}>{formatCents(total)}</th><th /></tr>
        </tfoot>
      </table>
    </>
  );
}
