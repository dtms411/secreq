'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCents, severityStyle } from '@/lib/format';
import { DemoBanner, demoQuarantineStatements, demoCriticalExceptions } from '@/lib/demo';

interface Q { statement_id: string; building_id: string; period_start: string; period_end: string; checksum_delta_cents: number; extract_method: string; }
interface Ex { id: string; kind: string; severity: string; amount_cents: number | null; detail: any; opened_at: string; }

export default function Quarantine() {
  const [q, setQ] = useState<Q[]>([]);
  const [ex, setEx] = useState<Ex[]>([]);
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    const qDemo = () => { setQ(demoQuarantineStatements as Q[]); setDemo(true); };
    const exDemo = () => { setEx(demoCriticalExceptions as Ex[]); setDemo(true); };
    supabase.from('v_quarantine').select('*').then(({ data, error }) => {
      if (error || !data || data.length === 0) qDemo();
      else setQ(data as Q[]);
    }, qDemo);
    supabase.from('exceptions').select('id, kind, severity, amount_cents, detail, opened_at')
      .in('severity', ['critical', 'high']).eq('status', 'open').order('severity')
      .then(({ data, error }) => {
        if (error || !data || data.length === 0) exDemo();
        else setEx(data as Ex[]);
      }, exDemo);
  }, []);

  return (
    <>
      <h1 className="page-title">Quarantine</h1>
      <p className="page-sub">Statements that failed the checksum gate, and the open critical &amp; high findings that most need attention.</p>
      {demo && <DemoBanner />}

      <div className="card">
        <div className="card-title">Statements that failed the checksum gate</div>
        <div className="card-sub">Under all-or-nothing ingest this should be empty. Any row here is itself a finding.</div>
        <table>
          <thead><tr><th>Building</th><th>Period</th><th className="num">Δ</th><th>Method</th></tr></thead>
          <tbody>
            {q.map((r) => (
              <tr key={r.statement_id}>
                <td className="name">{r.building_id}</td>
                <td className="muted">{r.period_start} → {r.period_end}</td>
                <td className="num neg">{formatCents(r.checksum_delta_cents)}</td>
                <td>{r.extract_method}</td>
              </tr>
            ))}
            {q.length === 0 && <tr><td colSpan={4} className="muted">none</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-title">Open critical / high exceptions</div>
        <table>
          <thead><tr><th>Severity</th><th>Kind</th><th className="num">Amount</th><th>Detail</th><th>Opened</th></tr></thead>
          <tbody>
            {ex.map((e) => (
              <tr key={e.id}>
                <td><span className="badge" style={severityStyle(e.severity)}>{e.severity}</span></td>
                <td className="name">{e.kind}</td>
                <td className="num">{formatCents(e.amount_cents)}</td>
                <td style={{ whiteSpace: 'normal', maxWidth: 440, color: 'var(--ink-2)' }}>{e.detail?.message ?? JSON.stringify(e.detail)}</td>
                <td className="muted">{e.opened_at?.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
