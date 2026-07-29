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

// Match approval. Proposals arrive from the CLI matcher with decided_by = null.
// A match does not count until a human sets decided_by.
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
      });

  useEffect(() => { load(); }, []);

  async function approve(id: string) {
    if (demo) { setRows((r) => r.filter((m) => m.id !== id)); return; } // preview: mutate locally
    setBusy(id);
    const { data: u } = await supabase.auth.getUser();
    await supabase.from('matches').update({ decided_by: u.user?.email ?? 'unknown', decided_at: new Date().toISOString() }).eq('id', id);
    await load();
    setBusy(undefined);
  }

  return (
    <>
      <h2 style={{ fontSize: 16 }}>Match approval</h2>
      {demo && <DemoBanner />}
      <p style={{ color: '#6b7280', fontSize: 13 }}>{rows.length} proposal(s) pending. Nothing counts until a human approves it.</p>
      <table>
        <thead><tr><th>Posted</th><th>Bank descriptor</th><th className="num">Amount</th><th>Proposed tenant</th><th>Method</th><th className="num">Conf.</th><th></th></tr></thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <td>{m.bank_transactions?.posted_on}</td>
              <td>{m.bank_transactions?.descriptor}</td>
              <td className="num">{formatCents(m.bank_transactions?.amount_cents ?? null)}</td>
              <td>{m.leases ? `${m.leases.tenant_name} (${m.leases.unit})` : '—'}</td>
              <td>{m.method}</td>
              <td className="num">{m.confidence ?? '—'}</td>
              <td><button className="act" disabled={busy === m.id} onClick={() => approve(m.id)}>Approve</button></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={7} style={{ color: '#6b7280' }}>no pending proposals</td></tr>}
        </tbody>
      </table>
    </>
  );
}
