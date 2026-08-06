'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCents } from '@/lib/format';
import { DemoBanner, demoMatches } from '@/lib/demo';

interface M {
  id: string; method: string; confidence: number | null; decided_by: string | null;
  bank_transactions: { descriptor: string; amount_cents: number; posted_on: string } | null;
  leases: { tenant_name: string; unit: string } | null;
}

export default function Matches() {
  const [rows, setRows] = useState<M[]>([]);
  const [demo, setDemo] = useState(false);
  const [busy, setBusy] = useState<string>();

  const load = () =>
    supabase.from('matches')
      .select('id, method, confidence, decided_by, bank_transactions(descriptor, amount_cents, posted_on), leases(tenant_name, unit)')
      .is('decided_by', null)
      .then(({ data, error }) => {
        if (error || !data || data.length === 0) { setRows(demoMatches as unknown as M[]); setDemo(true); }
        else setRows(data as unknown as M[]);
      }, () => { setRows(demoMatches as unknown as M[]); setDemo(true); });

  useEffect(() => { load(); }, []);

  async function approve(id: string) {
    if (demo) { setRows((r) => r.filter((m) => m.id !== id)); return; }
    setBusy(id);
    const { data: u } = await supabase.auth.getUser();
    await supabase.from('matches').update({ decided_by: u.user?.email ?? 'unknown', decided_at: new Date().toISOString() }).eq('id', id);
    await load();
    setBusy(undefined);
  }

  return (
    <>
      <h1 className="page-title">Match approval</h1>
      <p className="page-sub">
        Proposals from the matcher (exact, fuzzy, and LLM-suggested). A match counts for nothing until a human
        approves it — that is the one write this screen makes.
      </p>
      {demo && <DemoBanner />}

      <div className="card">
        <div className="card-title">{rows.length} proposal{rows.length === 1 ? '' : 's'} pending</div>
        <div className="card-sub">Review the bank descriptor against the proposed tenant, then approve.</div>
        <table>
          <thead><tr><th>Posted</th><th>Bank descriptor</th><th className="num">Amount</th><th>Proposed tenant</th><th>Method</th><th className="num">Conf.</th><th></th></tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <td className="muted">{m.bank_transactions?.posted_on}</td>
                <td className="name">{m.bank_transactions?.descriptor}</td>
                <td className="num">{formatCents(m.bank_transactions?.amount_cents ?? null)}</td>
                <td>{m.leases ? `${m.leases.tenant_name} · ${m.leases.unit}` : '—'}</td>
                <td className="muted">{m.method}</td>
                <td className="num">{m.confidence != null ? m.confidence.toFixed(2) : '—'}</td>
                <td><button className="btn btn-primary" disabled={busy === m.id} onClick={() => approve(m.id)}>Approve</button></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="muted">no pending proposals</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
