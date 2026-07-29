'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCents } from '@/lib/format';

interface M {
  id: string; method: string; confidence: number | null; decided_by: string | null;
  bank_transactions: { descriptor: string; amount_cents: number; posted_on: string } | null;
  leases: { tenant_name: string; unit: string } | null;
}

// Match approval. Proposals arrive from the CLI matcher with decided_by = null.
// A match does not count until a human sets decided_by — that is the one write
// this screen makes (invariant 6: an LLM or rule may propose, never post).
export default function Matches() {
  const [rows, setRows] = useState<M[]>([]);
  const [busy, setBusy] = useState<string>();

  const load = () =>
    supabase.from('matches')
      .select('id, method, confidence, decided_by, bank_transactions(descriptor, amount_cents, posted_on), leases(tenant_name, unit)')
      .is('decided_by', null)
      .then(({ data }) => setRows((data ?? []) as unknown as M[]));

  useEffect(() => { load(); }, []);

  async function approve(id: string) {
    setBusy(id);
    const { data: u } = await supabase.auth.getUser();
    await supabase.from('matches').update({ decided_by: u.user?.email ?? 'unknown', decided_at: new Date().toISOString() }).eq('id', id);
    await load();
    setBusy(undefined);
  }

  return (
    <>
      <h2 style={{ fontSize: 16 }}>Match approval</h2>
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
        </tbody>
      </table>
    </>
  );
}
