import { db } from '../db.js';
import { computeDue, stageMessage, type OpenDeadline } from './clock.js';
import { sendEmail } from '../notify/resend.js';

// The daily run. Loads open deadlines (keys returned, deposit not refunded),
// works out which escalations are due and unsent, sends them via Resend, and
// records each in the append-only deadline_notifications table. The recipient
// is an internal ops/legal distribution (DEADLINE_ALERT_TO), not the tenant --
// this alerts the people who can still act before the window closes.
//
// Meant to be run from cron every morning:  npm run cli -- deadlines

export interface DeadlineRunResult {
  open: number;
  sent: number;
  byStage: Record<string, number>;
}

export async function runDeadlines(todayISO: string): Promise<DeadlineRunResult> {
  const to = (process.env.DEADLINE_ALERT_TO ?? '').split(',').map(s => s.trim()).filter(Boolean);

  const { data: openRows, error } = await db.from('v_open_deadlines').select('*');
  if (error) throw error;

  const open: OpenDeadline[] = (openRows ?? []).map((d: any) => ({
    leaseId: d.lease_id, buildingId: d.building_id, unit: d.unit, tenantName: d.tenant_name,
    isRentStabilized: d.is_rent_stabilized, keysReturnedOn: d.keys_returned_on,
    dueDate: d.due_date, expectedDepositCents: Number(d.expected_deposit_cents),
  }));

  const { data: sentRows } = await db.from('deadline_notifications').select('lease_id, stage');
  const alreadySent = new Set((sentRows ?? []).map((r: any) => `${r.lease_id}:${r.stage}`));

  const due = computeDue(open, todayISO, alreadySent);
  const byStage: Record<string, number> = {};
  let sent = 0;

  for (const e of due) {
    const msg = stageMessage(e);
    // No recipient configured -> do NOT record the notification. The row is
    // append-only with a unique (lease_id, stage) constraint, so recording it
    // now would permanently suppress this escalation once a recipient is finally
    // set — silently burning the highest-dollar alert in the system. Skip and
    // let a later, configured run send it.
    if (!to.length) {
      console.log(`  ⚠ ${e.stage} for ${e.deadline.tenantName}: no DEADLINE_ALERT_TO configured — NOT recorded, will retry`);
      continue;
    }
    const r = await sendEmail({ to, subject: msg.subject, text: msg.body });
    const recipients = to;
    const providerId = r.id;

    // Record after a successful send. The unique (lease_id, stage) constraint
    // prevents a second send; a genuine send failure throws above and the row is
    // not written, so the next run retries.
    const { error: insErr } = await db.from('deadline_notifications').insert({
      lease_id: e.leaseId, stage: e.stage, due_date: e.dueDate,
      recipient: recipients.join(',') || null, provider_id: providerId,
      detail: { days_elapsed: e.daysElapsed, days_to_deadline: e.daysToDeadline, subject: msg.subject },
    });
    if (insErr) throw insErr;

    byStage[e.stage] = (byStage[e.stage] ?? 0) + 1;
    sent++;
  }

  console.log(`deadlines: ${open.length} open, ${sent} escalation(s) this run`);
  for (const [stage, n] of Object.entries(byStage)) console.log(`  ${stage}: ${n}`);
  return { open: open.length, sent, byStage };
}
