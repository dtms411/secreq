'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCents, severityColor } from '@/lib/format';

interface Q { statement_id: string; building_id: string; period_start: string; period_end: string; checksum_delta_cents: number; extract_method: string; }
interface Ex { id: string; kind: string; severity: string; amount_cents: number | null; detail: any; opened_at: string; }

export default function Quarantine() {
  const [q, setQ] = useState<Q[]>([]);
  const [ex, setEx] = useState<Ex[]>([]);

  useEffect(() => {
    supabase.from('v_quarantine').select('*').then(({ data }) => setQ((data ?? []) as Q[]));
    supabase.from('exceptions').select('id, kind, severity, amount_cents, detail, opened_at')
      .in('severity', ['critical', 'high']).eq('status', 'open').order('severity')
      .then(({ data }) => setEx((data ?? []) as Ex[]));
  }, []);

  return (
    <>
      <h2 style={{ fontSize: 16 }}>Quarantine &amp; critical findings</h2>

      <h3 style={{ fontSize: 14 }}>Statements that failed the checksum gate</h3>
      <p style={{ color: '#6b7280', fontSize: 13 }}>Under all-or-nothing ingest this should be empty. Any row here is itself a finding.</p>
      <table>
        <thead><tr><th>Building</th><th>Period</th><th className="num">Δ</th><th>Method</th></tr></thead>
        <tbody>
          {q.map((r) => (
            <tr key={r.statement_id}>
              <td>{r.building_id}</td><td>{r.period_start} → {r.period_end}</td>
              <td className="num neg">{formatCents(r.checksum_delta_cents)}</td><td>{r.extract_method}</td>
            </tr>
          ))}
          {q.length === 0 && <tr><td colSpan={4} style={{ color: '#6b7280' }}>none</td></tr>}
        </tbody>
      </table>

      <h3 style={{ fontSize: 14, marginTop: 24 }}>Open critical / high exceptions</h3>
      <table>
        <thead><tr><th>Severity</th><th>Kind</th><th className="num">Amount</th><th>Detail</th><th>Opened</th></tr></thead>
        <tbody>
          {ex.map((e) => (
            <tr key={e.id}>
              <td><span className="badge" style={{ background: severityColor(e.severity) }}>{e.severity}</span></td>
              <td>{e.kind}</td>
              <td className="num">{formatCents(e.amount_cents)}</td>
              <td style={{ whiteSpace: 'normal', maxWidth: 420, color: '#374151' }}>{e.detail?.message ?? JSON.stringify(e.detail)}</td>
              <td>{e.opened_at?.slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
