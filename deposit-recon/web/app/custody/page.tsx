'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCents } from '@/lib/format';
import { DemoBanner, demoCustodySummary, demoMasterAging, demoMasterBankBalanceCents } from '@/lib/demo';

// The operational custody view — the office tracker, tied in. Where Tie-out
// asks "does the bank agree with the leases", this answers "where is each
// deposit right now": received, pooled in the Santander Master account, moved
// into a per-tenant subaccount, returned, refunded. The headline control is
// Master-account aging — money must not linger commingled in Master.

interface Summary {
  building_id: string; building?: string;
  total_received_cents: number; in_master_cents: number; in_subaccounts_cents: number;
  refund_pending: number; closed_records: number; master_aged_over_30: number;
}
interface Aging {
  id: string; building?: string; building_id?: string; unit: string; tenant_name: string;
  kind: string; in_master_cents: number; since: string | null; days_in_master: number | null;
  subaccount_last4: string | null; stage: string; responsible_employee: string | null; next_action: string | null;
}

const AGE_LIMIT = 30; // days a deposit may sit in Master before it ages

export default function Custody() {
  const [summary, setSummary] = useState<Summary[]>([]);
  const [aging, setAging] = useState<Aging[]>([]);
  const [masterBank, setMasterBank] = useState<number | null>(null);
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    Promise.all([
      supabase.from('v_custody_summary').select('*'),
      supabase.from('v_master_account_aging').select('*').order('days_in_master', { ascending: false }),
    ]).then(([s, a]) => {
      if (s.error || a.error || !s.data || s.data.length === 0) {
        setSummary(demoCustodySummary as Summary[]);
        setAging(demoMasterAging as Aging[]);
        setMasterBank(demoMasterBankBalanceCents);
        setDemo(true);
      } else {
        setSummary(s.data as Summary[]);
        setAging((a.data ?? []) as Aging[]);
      }
    });
  }, []);

  const received = summary.reduce((t, s) => t + s.total_received_cents, 0);
  const inMaster = summary.reduce((t, s) => t + s.in_master_cents, 0);
  const inSub = summary.reduce((t, s) => t + s.in_subaccounts_cents, 0);
  const refundPending = summary.reduce((t, s) => t + s.refund_pending, 0);
  const agedCount = summary.reduce((t, s) => t + s.master_aged_over_30, 0);

  // Custody claim vs the actual Santander Master statement balance. Kept
  // independent on purpose — their disagreement is the finding. bank − claim.
  const masterVariance = masterBank == null ? null : masterBank - inMaster;

  return (
    <>
      <h1 className="page-title">Custody control</h1>
      <p className="page-sub">
        The operational tracker, tied in. Every deposit&rsquo;s journey — received, pooled in the Santander
        <em> Master</em> account, allocated into the tenant&rsquo;s own subaccount, returned, refunded. Custody
        rows are the office&rsquo;s claims; they reconcile <em>against</em> the bank, never replacing the lease universe.
      </p>
      {demo && <DemoBanner />}

      <div className="stats">
        <div className="stat">
          <div className="stat-label">Total security received</div>
          <div className="stat-num">{formatCents(received)}</div>
          <div className="stat-sub">across {summary.length} building{summary.length === 1 ? '' : 's'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">In Master (pooled)</div>
          <div className={'stat-num' + (agedCount ? ' neg' : '')}>{formatCents(inMaster)}</div>
          <div className="stat-sub">{agedCount ? `${agedCount} aged past ${AGE_LIMIT} days` : 'none aged'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">In tenant subaccounts</div>
          <div className="stat-num pos">{formatCents(inSub)}</div>
          <div className="stat-sub">segregated, per tenant</div>
        </div>
        <div className="stat">
          <div className="stat-label">Refund pending</div>
          <div className={'stat-num' + (refundPending ? ' neg' : '')}>{refundPending}</div>
          <div className="stat-sub">returned by bank, tenant unpaid</div>
        </div>
      </div>

      {masterVariance != null && (
        <div className="card">
          <div className="card-title">Master account — custody vs bank</div>
          <div className="card-sub">
            What the tracker claims is pooled, against the actual Santander Master statement balance.
            A negative variance means the bank holds <em>less</em> than the tracker says is there.
          </div>
          <table>
            <tbody>
              <tr><td className="name">Tracker claims pooled in Master</td><td className="num">{formatCents(inMaster)}</td></tr>
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
    </>
  );
}
