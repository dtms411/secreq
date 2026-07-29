'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCents, severityStyle } from '@/lib/format';
import { DemoBanner, demoExceptions } from '@/lib/demo';

interface Ex {
  id: string; kind: string; severity: string; status: string;
  amount_cents: number | null; detail: any; opened_at: string;
}

const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const NEXT: Record<string, string[]> = {
  open: ['investigating', 'resolved', 'escalated'],
  investigating: ['resolved', 'escalated'],
  escalated: ['resolved'],
  resolved: [],
};

export default function Exceptions() {
  const [rows, setRows] = useState<Ex[]>([]);
  const [demo, setDemo] = useState(false);
  const [showResolved, setShowResolved] = useState(false);

  const sortRows = (d: Ex[]) =>
    [...d].sort((a, b) => (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || a.kind.localeCompare(b.kind));

  const load = () => {
    let q = supabase.from('exceptions').select('id, kind, severity, status, amount_cents, detail, opened_at');
    if (!showResolved) q = q.neq('status', 'resolved');
    q.then(({ data, error }) => {
      if (error || !data || data.length === 0) {
        const dd = demoExceptions.filter((e) => showResolved || e.status !== 'resolved') as Ex[];
        setRows(sortRows(dd)); setDemo(true);
      } else {
        setRows(sortRows(data as Ex[]));
      }
    });
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [showResolved]);

  async function setStatus(id: string, status: string) {
    if (demo) {
      setRows((r) => sortRows(r.map((e) => (e.id === id ? { ...e, status } : e)).filter((e) => showResolved || e.status !== 'resolved')));
      return;
    }
    const patch: Record<string, unknown> = { status };
    if (status === 'resolved') {
      const { data: u } = await supabase.auth.getUser();
      patch.resolved_at = new Date().toISOString();
      patch.resolved_by = u.user?.email ?? 'unknown';
    }
    await supabase.from('exceptions').update(patch).eq('id', id);
    load();
  }

  return (
    <>
      <h1 className="page-title">Exception triage</h1>
      <p className="page-sub">Every detector finding, highest severity first. Triage moves status only — never the underlying figures.</p>
      {demo && <DemoBanner />}

      <div className="card">
        <div className="toolbar">
          <label><input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> show resolved</label>
        </div>
        <table>
          <thead><tr><th>Severity</th><th>Kind</th><th className="num">Amount</th><th>Detail</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td><span className="badge" style={severityStyle(e.severity)}>{e.severity}</span></td>
                <td className="name">{e.kind}</td>
                <td className="num">{formatCents(e.amount_cents)}</td>
                <td style={{ whiteSpace: 'normal', maxWidth: 400, color: 'var(--ink-2)' }}>{e.detail?.message ?? JSON.stringify(e.detail)}</td>
                <td className="muted">{e.status}</td>
                <td>
                  {(NEXT[e.status] ?? []).map((s) => (
                    <button key={s} className="btn" onClick={() => setStatus(e.id, s)}>{s}</button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
