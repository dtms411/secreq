import { makeChecker } from './_assert.js';

// detectors.ts transitively imports ./db.js (via continuity). Give it harmless
// placeholders; no query runs — these are pure functions.
process.env.SUPABASE_URL ||= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'placeholder';

const d = await import('../src/exceptions/detectors.js');
const O = d.DEFAULT_DETECTOR_OPTS;
type DS = import('../src/exceptions/detectors.js').Dataset;

const { check, done } = makeChecker();

const base = (): DS => ({ accounts: [], txns: [], leases: [], ledger: [], matches: [], statements: [] });
const escrow = { id: 'A1', buildingId: 'B1', type: 'escrow' as const, last4: '4417' };
const oper = { id: 'A2', buildingId: 'B1', type: 'operating' as const, last4: '9999' };
const txn = (o: Partial<DS['txns'][0]>): DS['txns'][0] => ({
  id: 'T', buildingId: 'B1', accountId: 'A1', accountType: 'escrow',
  amountCents: 0, postedOn: '2025-04-09', descriptor: '', checkNo: null, counterparty: null, ...o,
});
const lease = (o: Partial<DS['leases'][0]>): DS['leases'][0] => ({
  id: 'L', buildingId: 'B1', unit: '1', tenantName: 'Rivera M', signedOn: '2024-04-01', termStart: '2024-04-01',
  vacatedOn: null, keysReturnedOn: null, monthlyRentCents: 240000, expectedDepositCents: 240000, ...o,
});

console.log('exception detectors — positive and negative per detector');

// 1. unexplained_debit
{
  const pos = { ...base(), accounts: [escrow], txns: [txn({ amountCents: -215000, descriptor: 'CHECK PAID - REFUND' })] };
  const neg = { ...pos, leases: [lease({ keysReturnedOn: '2025-04-05' })] };
  check('unexplained_debit +', d.unexplainedDebit(pos, O).length === 1);
  check('unexplained_debit -', d.unexplainedDebit(neg, O).length === 0);
}

// 2. deposit_never_banked
{
  const pos = { ...base(), accounts: [escrow], leases: [lease({})] };
  const neg = { ...pos, txns: [txn({ amountCents: 240000, postedOn: '2024-04-10', descriptor: 'DEPOSIT RIVERA' })] };
  check('deposit_never_banked +', d.depositNeverBanked(pos, O).length === 1);
  check('deposit_never_banked -', d.depositNeverBanked(neg, O).length === 0);
}

// 3. refund_payee_mismatch (needs a lease linkage)
{
  const t = txn({ id: 'TR', amountCents: -240000, descriptor: 'CHECK PAID - REFUND', counterparty: 'SMITH J' });
  const pos = { ...base(), accounts: [escrow], txns: [t], leases: [lease({})], matches: [{ bankTransactionId: 'TR', leaseId: 'L' }] };
  const neg = { ...pos, txns: [{ ...t, counterparty: 'Rivera M' }] };
  check('refund_payee_mismatch +', d.refundPayeeMismatch(pos, O).length === 1);
  check('refund_payee_mismatch -', d.refundPayeeMismatch(neg, O).length === 0);
}

// 4. refund_without_vacate
{
  const t = txn({ id: 'TR', amountCents: -240000, descriptor: 'REFUND' });
  const pos = { ...base(), txns: [t], leases: [lease({})], matches: [{ bankTransactionId: 'TR', leaseId: 'L' }] };
  const neg = { ...pos, leases: [lease({ keysReturnedOn: '2025-04-01' })] };
  check('refund_without_vacate +', d.refundWithoutVacate(pos, O).length === 1);
  check('refund_without_vacate -', d.refundWithoutVacate(neg, O).length === 0);
}

// 5. duplicate_refund
{
  const t1 = txn({ id: 'R1', amountCents: -240000, descriptor: 'REFUND' });
  const t2 = txn({ id: 'R2', amountCents: -240000, descriptor: 'REFUND' });
  const pos = { ...base(), txns: [t1, t2], leases: [lease({})], matches: [{ bankTransactionId: 'R1', leaseId: 'L' }, { bankTransactionId: 'R2', leaseId: 'L' }] };
  const neg = { ...pos, txns: [t1], matches: [{ bankTransactionId: 'R1', leaseId: 'L' }] };
  check('duplicate_refund +', d.duplicateRefund(pos, O).length === 1);
  check('duplicate_refund -', d.duplicateRefund(neg, O).length === 0);
}

// 6. escrow_to_operating
{
  const pos = { ...base(), accounts: [escrow, oper], txns: [txn({ amountCents: -500000, descriptor: 'TRANSFER TO OPERATING' })] };
  const neg = { ...base(), accounts: [escrow, oper], txns: [txn({ amountCents: -240000, descriptor: 'CHECK PAID - REFUND' })] };
  check('escrow_to_operating +', d.escrowToOperating(pos, O).length === 1);
  check('escrow_to_operating -', d.escrowToOperating(neg, O).length === 0);
}

// 7. inter_building_transfer (lapping)
{
  const debit = txn({ id: 'DB', buildingId: 'B1', amountCents: -300000, postedOn: '2025-04-10', descriptor: 'TRANSFER' });
  const credit = txn({ id: 'CR', buildingId: 'B2', accountId: 'A3', amountCents: 300000, postedOn: '2025-04-12', descriptor: 'TRANSFER IN' });
  const pos = { ...base(), txns: [debit, credit] };
  const neg = { ...base(), txns: [debit, { ...credit, buildingId: 'B1' }] }; // same building = not inter-building
  check('inter_building_transfer +', d.interBuildingTransfer(pos, O).length === 1);
  check('inter_building_transfer -', d.interBuildingTransfer(neg, O).length === 0);
}

// 8. interest_not_allocated
{
  const t = txn({ amountCents: 3125, descriptor: 'INTEREST CREDIT' });
  const pos = { ...base(), accounts: [escrow], txns: [t], leases: [lease({})] };
  const neg = { ...pos, ledger: [{ id: 'E1', leaseId: 'L', entryType: 'interest_credit', amountCents: 3125, entryDate: '2025-04-30' }] };
  check('interest_not_allocated +', d.interestNotAllocated(pos, O).length === 1);
  check('interest_not_allocated -', d.interestNotAllocated(neg, O).length === 0);
}

// 9. deposit_exceeds_one_month
{
  const pos = { ...base(), leases: [lease({ monthlyRentCents: 300000, expectedDepositCents: 330000 })] };
  const neg = { ...base(), leases: [lease({ monthlyRentCents: 300000, expectedDepositCents: 300000 })] };
  check('deposit_exceeds_one_month +', d.depositExceedsOneMonth(pos, O).length === 1);
  check('deposit_exceeds_one_month -', d.depositExceedsOneMonth(neg, O).length === 0);
}

// 10. stale_credit
{
  const st = [{ bankAccountId: 'A1', periodStart: '2025-06-01', periodEnd: '2025-06-30', openingCents: 0, closingCents: 0 }];
  const pos = { ...base(), statements: st, leases: [lease({ keysReturnedOn: '2025-01-01' })], ledger: [{ id: 'E1', leaseId: 'L', entryType: 'initial_deposit', amountCents: 240000, entryDate: '2024-04-01' }] };
  const neg = { ...pos, ledger: [...pos.ledger, { id: 'E2', leaseId: 'L', entryType: 'refund', amountCents: -240000, entryDate: '2025-01-05' }] };
  check('stale_credit +', d.staleCredit(pos, O).length === 1);
  check('stale_credit -', d.staleCredit(neg, O).length === 0);
}

// 11. missing_statement_period
{
  const gap = [
    { bankAccountId: 'A1', periodStart: '2025-02-01', periodEnd: '2025-02-28', openingCents: 50000, closingCents: 52500 },
    { bankAccountId: 'A1', periodStart: '2025-04-01', periodEnd: '2025-04-30', openingCents: 60000, closingCents: 61000 },
  ];
  const contiguous = [
    { bankAccountId: 'A1', periodStart: '2025-02-01', periodEnd: '2025-02-28', openingCents: 50000, closingCents: 52500 },
    { bankAccountId: 'A1', periodStart: '2025-03-01', periodEnd: '2025-03-31', openingCents: 52500, closingCents: 52500 },
  ];
  check('missing_statement_period +', d.missingStatementPeriod({ ...base(), accounts: [escrow], statements: gap }, O).length >= 1);
  check('missing_statement_period -', d.missingStatementPeriod({ ...base(), accounts: [escrow], statements: contiguous }, O).length === 0);
}

// 12. interest_account_noncompliant (GOL §7-103)
{
  const bldg = [{ id: 'B1', name: '9281 Shore Road', interestRequired: true }];
  const pos = { ...base(), accounts: [{ ...escrow, isInterestBearing: false }], buildings: bldg };
  const neg = { ...base(), accounts: [{ ...escrow, isInterestBearing: true }], buildings: bldg };
  const small = { ...base(), accounts: [{ ...escrow, isInterestBearing: false }], buildings: [{ id: 'B1', name: 'x', interestRequired: false }] };
  check('interest_account_noncompliant +', d.interestAccountNoncompliant(pos, O).length === 1);
  check('interest_account_noncompliant - (interest-bearing)', d.interestAccountNoncompliant(neg, O).length === 0);
  check('interest_account_noncompliant - (under 6 units)', d.interestAccountNoncompliant(small, O).length === 0);
}

// full sweep produces a triaged queue (severities present, ordered)
{
  const ds = { ...base(), accounts: [escrow], txns: [txn({ amountCents: -215000, descriptor: 'CHECK PAID - REFUND' })], leases: [lease({})] };
  const all = d.runAllDetectors(ds, O);
  check('full sweep yields findings with severities', all.length > 0 && all.every(f => ['critical', 'high', 'medium', 'low'].includes(f.severity)));
}

done('exceptions');
