// The daily 14-day clock. GOL §7-108 (and §7-107 as amended 15 Nov 2025,
// extending the return-and-itemize duty to rent-stabilized tenants) forfeits
// the landlord's right to retain ANY of a deposit if it is not returned with an
// itemized statement within 14 days of the tenant surrendering possession.
//
// keys_returned_on starts that clock. This is the highest-dollar alert in the
// system: once the window closes it is irreversible regardless of what the
// tenant owed, and a monthly reconciliation would only discover the failure two
// weeks after it became permanent. So this runs every morning, on its own
// cadence, escalating as the deadline approaches.
//
// This module is pure: given the open deadlines, today's date, and what has
// already been sent, it computes exactly which escalations are now due. Sending
// and recording live in run.ts.

export type Stage = 'day7' | 'day10' | 'day14' | 'overdue';

// Days elapsed since keys were returned at which each stage fires. Escalations
// at 7 and 10 (brief), the deadline itself at 14, and a past-due alert after.
export const STAGE_THRESHOLDS: Record<Stage, number> = {
  day7: 7,
  day10: 10,
  day14: 14,
  overdue: 15,
};

export const STAGE_ORDER: Stage[] = ['day7', 'day10', 'day14', 'overdue'];

export interface OpenDeadline {
  leaseId: string;
  buildingId: string | null;
  unit: string;
  tenantName: string;
  isRentStabilized: boolean;
  keysReturnedOn: string;      // YYYY-MM-DD
  dueDate: string;             // keys_returned_on + 14
  expectedDepositCents: number;
}

export interface DueEscalation {
  leaseId: string;
  stage: Stage;
  dueDate: string;
  daysElapsed: number;
  daysToDeadline: number;      // negative once past due
  deadline: OpenDeadline;
}

function daysSince(from: string, today: string): number {
  return Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Which escalations are due today and not already sent. Every stage whose
 * threshold has been reached but which has not gone out is returned -- so if
 * the clock missed a day (outage, weekend deferral), the next run catches up
 * and sends day7 and day10 together rather than skipping the earlier one. The
 * unique (lease_id, stage) constraint plus `alreadySent` guarantees each stage
 * fires exactly once.
 */
export function computeDue(
  open: OpenDeadline[],
  today: string,
  alreadySent: Set<string>,       // `${leaseId}:${stage}`
): DueEscalation[] {
  const due: DueEscalation[] = [];
  for (const d of open) {
    const elapsed = daysSince(d.keysReturnedOn, today);
    if (elapsed < STAGE_THRESHOLDS.day7) continue; // clock not yet at first escalation
    const daysToDeadline = -daysSince(d.dueDate, today); // positive before the deadline, negative after
    for (const stage of STAGE_ORDER) {
      if (elapsed < STAGE_THRESHOLDS[stage]) continue;
      if (alreadySent.has(`${d.leaseId}:${stage}`)) continue;
      due.push({ leaseId: d.leaseId, stage, dueDate: d.dueDate, daysElapsed: elapsed, daysToDeadline, deadline: d });
    }
  }
  // Most urgent first: closest to (or furthest past) the deadline.
  return due.sort((a, b) => a.daysToDeadline - b.daysToDeadline);
}

export function stageMessage(e: DueEscalation): { subject: string; body: string } {
  const dollars = `$${(e.deadline.expectedDepositCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  const stabilized = e.deadline.isRentStabilized ? ' (rent-stabilized — GOL §7-107, amended 15 Nov 2025)' : '';
  const when =
    e.daysToDeadline < 0 ? `PAST DUE by ${Math.abs(e.daysToDeadline)} day(s)`
    : e.daysToDeadline === 0 ? 'DUE TODAY (day 14 of 14)'
    : `due in ${e.daysToDeadline} day(s) (day ${e.daysElapsed} of 14)`;
  return {
    subject: `[deposit-recon] ${e.stage.toUpperCase()} — ${e.deadline.tenantName}, unit ${e.deadline.unit} — refund ${when}`,
    body:
      `Security deposit refund deadline${stabilized}\n\n` +
      `Tenant:   ${e.deadline.tenantName}\n` +
      `Unit:     ${e.deadline.unit}\n` +
      `Keys returned: ${e.deadline.keysReturnedOn}\n` +
      `Deadline (14 days): ${e.dueDate}\n` +
      `Status:   ${when}\n` +
      `Deposit:  ${dollars}\n\n` +
      (e.stage === 'overdue'
        ? 'The statutory window has closed. The right to retain any portion of this deposit may be forfeit. Escalate to counsel.\n'
        : 'Return the deposit with an itemized statement before the deadline to preserve any right to withhold.\n'),
  };
}
