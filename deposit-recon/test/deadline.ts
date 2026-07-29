import { computeDue, stageMessage, type OpenDeadline } from '../src/deadline/clock.js';
import { makeChecker } from './_assert.js';

const { check, done } = makeChecker();

console.log('14-day clock — stage computation');

const TODAY = '2025-08-20';
const mk = (leaseId: string, keys: string, due: string): OpenDeadline => ({
  leaseId, buildingId: 'B1', unit: '1', tenantName: `T-${leaseId}`, isRentStabilized: false,
  keysReturnedOn: keys, dueDate: due, expectedDepositCents: 200000,
});

// elapsed 8 -> only day7; elapsed 11 -> day7+day10; elapsed 20 -> all; elapsed 2 -> none.
const open: OpenDeadline[] = [
  mk('early', '2025-08-18', '2025-09-01'),  // 2 days
  mk('d7',    '2025-08-12', '2025-08-26'),  // 8 days
  mk('d10',   '2025-08-09', '2025-08-23'),  // 11 days
  mk('over',  '2025-07-31', '2025-08-14'),  // 20 days, past due
];

const due = computeDue(open, TODAY, new Set());
const stagesFor = (id: string) => due.filter(d => d.leaseId === id).map(d => d.stage).sort();

check('too early: no escalation', stagesFor('early').length === 0);
check('day 8: day7 only', JSON.stringify(stagesFor('d7')) === JSON.stringify(['day7']));
check('day 11: catches up day7 + day10', JSON.stringify(stagesFor('d10')) === JSON.stringify(['day10', 'day7']));
check('day 20: all four stages', JSON.stringify(stagesFor('over')) === JSON.stringify(['day10', 'day14', 'day7', 'overdue']));

// already-sent suppression: day7 sent for d10 -> only day10 remains.
const partial = computeDue(open, TODAY, new Set(['d10:day7']));
check('already-sent stage is suppressed', JSON.stringify(partial.filter(d => d.leaseId === 'd10').map(d => d.stage)) === JSON.stringify(['day10']));

// idempotency: everything sent -> nothing due.
const allSent = new Set(due.map(d => `${d.leaseId}:${d.stage}`));
check('all sent => nothing due (idempotent)', computeDue(open, TODAY, allSent).length === 0);

// urgency ordering: most-overdue first.
check('most urgent first', due[0].leaseId === 'over');

// message content
const overMsg = stageMessage(due.find(d => d.leaseId === 'over' && d.stage === 'overdue')!);
check('overdue message says PAST DUE', /PAST DUE/.test(overMsg.subject));
check('day7 message counts down', /due in \d+ day/.test(stageMessage(due.find(d => d.leaseId === 'd7' && d.stage === 'day7')!).body));

done('deadline');
