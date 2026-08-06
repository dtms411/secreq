import { parseCustody, type CustodyColumnMap, type CustodyRecord } from '../src/custody/parse.js';
import {
  masterAccountFloat, depositNotSentToBank, subaccountNotOpened, allocationPending,
  fundsReturnedNotRefunded, vacatedSubaccountOpen, runCustodyDetectors, DEFAULT_CUSTODY_OPTS,
} from '../src/custody/detectors.js';
import { custodyTotals, reconcileCustodyToBank, custodyBalanceRecon } from '../src/custody/totals.js';
import { makeChecker } from './_assert.js';

const { check, done } = makeChecker();
const TODAY = '2025-08-01';

// A minimal valid record; each test overrides only what it exercises.
function rec(over: Partial<CustodyRecord>): CustodyRecord {
  return {
    buildingKey: 'Property-020', unit: '1A', tenantName: 'Alvarez R',
    kind: 'initial', amountCents: 250000, inMasterCents: 0, stage: 'received', ...over,
  };
}

// ---------------------------------------------------------------- parser
console.log('parseCustody — tracker export → normalized records');
{
  const cm: CustodyColumnMap = {
    externalRef: 'Ref', buildingKey: 'Property', unit: 'Unit', tenantName: 'Tenant',
    kind: 'Type', amount: 'Deposit', receivedOn: 'Received', sentToBankOn: 'Sent',
    bankClearedOn: 'Cleared', inMaster: 'In Master', subaccountLast4: 'Subacct',
    subaccountOpenedOn: 'Subacct Opened', stage: 'Stage', responsibleEmployee: 'Owner',
    vacateDate: 'Vacated', fundsReturnedOn: 'Returned', refundedOn: 'Refunded',
  };
  const csv = [
    'Ref,Property,Unit,Tenant,Type,Deposit,Received,Sent,Cleared,In Master,Subacct,Subacct Opened,Stage,Owner,Vacated,Returned,Refunded',
    'R-1,Property-020,1A,Alvarez R,Initial,"$2,500.00",01/02/2025,01/03/2025,01/06/2025,"$2,500.00",,,In Master,J. Ruiz,,,',
    'R-2,Property-020,2B,"Okonkwo, A",Initial,"$2,650.00",02/01/2025,02/02/2025,02/05/2025,0,7788,02/20/2025,In Subaccount,J. Ruiz,,,',
    'R-3,Property-007,5C,Haley P,Additional,"1,800.00",03/01/2025,,,0,,,received,M. Diaz,,,',
  ].join('\n');
  const { records, problems, notes } = parseCustody(csv, cm);
  check('3 records parsed', records.length === 3, String(records.length));
  check('no problems', problems.length === 0, JSON.stringify(problems));
  check('amount is integer cents', records[0].amountCents === 250000, String(records[0].amountCents));
  check('in-master parsed', records[0].inMasterCents === 250000, String(records[0].inMasterCents));
  check('US date → ISO', records[0].bankClearedOn === '2025-01-06', String(records[0].bankClearedOn));
  check('kind normalized', records[2].kind === 'additional' && records[0].kind === 'initial');
  check('stage alias "In Subaccount" → in_subaccount', records[1].stage === 'in_subaccount', records[1].stage);
  check('stage lowercased "received"', records[2].stage === 'received', records[2].stage);
  check('external ref carried', records[0].externalRef === 'R-1', String(records[0].externalRef));
  check('blank optional cents → 0', records[1].inMasterCents === 0, String(records[1].inMasterCents));

  const bad = parseCustody('Property,Unit,Tenant,Deposit\nProperty-020,,X,100\nProperty-020,1A,,100\nProperty-020,1A,X,0', {
    buildingKey: 'Property', unit: 'Unit', tenantName: 'Tenant', amount: 'Deposit',
  });
  check('bad rows rejected, not loaded', bad.records.length === 0 && bad.problems.length === 3, JSON.stringify(bad.problems));
}

// -------------------------------------------------- master_account_float
console.log('\nmaster_account_float — pooled past the aging threshold');
{
  const stale = rec({ inMasterCents: 250000, bankClearedOn: '2025-06-01', stage: 'in_master' }); // 61d
  const fresh = rec({ unit: '2B', inMasterCents: 250000, bankClearedOn: '2025-07-25', stage: 'in_master' }); // 7d
  const allocated = rec({ unit: '3C', inMasterCents: 0, bankClearedOn: '2025-01-01', stage: 'in_subaccount' });
  const hits = masterAccountFloat([stale, fresh, allocated], TODAY, DEFAULT_CUSTODY_OPTS);
  check('only the stale, still-pooled deposit fires', hits.length === 1 && hits[0].detail.unit === '1A', String(hits.length));
  check('amount is the pooled balance', hits[0].amountCents === 250000);
  check('days_in_master computed', hits[0].detail.days_in_master === 61, String(hits[0].detail.days_in_master));
  const ancient = masterAccountFloat([rec({ inMasterCents: 100, bankClearedOn: '2024-01-01', stage: 'in_master' })], TODAY, DEFAULT_CUSTODY_OPTS);
  check('very old pool escalates to critical', ancient[0].severity === 'critical', ancient[0].severity);
}

// -------------------------------------------------- deposit_not_sent_to_bank
console.log('\ndeposit_not_sent_to_bank — collected, never deposited');
{
  const held = rec({ receivedOn: '2025-07-01', sentToBankOn: null }); // 31d, never sent
  const sent = rec({ unit: '2B', receivedOn: '2025-07-01', sentToBankOn: '2025-07-03' });
  const recent = rec({ unit: '3C', receivedOn: '2025-07-30', sentToBankOn: null }); // 2d, within window
  const hits = depositNotSentToBank([held, sent, recent], TODAY, DEFAULT_CUSTODY_OPTS);
  check('only the long-held, unsent deposit fires', hits.length === 1 && hits[0].detail.unit === '1A', String(hits.length));
  check('flags the full deposit amount', hits[0].amountCents === 250000);
}

// -------------------------------------------------- subaccount_not_opened
console.log('\nsubaccount_not_opened — cleared into Master, no subaccount');
{
  const noSub = rec({ bankClearedOn: '2025-06-01', subaccountLast4: null, subaccountOpenedOn: null, stage: 'in_master' });
  const withSub = rec({ unit: '2B', bankClearedOn: '2025-06-01', subaccountLast4: '7788', stage: 'in_subaccount' });
  const recent = rec({ unit: '3C', bankClearedOn: '2025-07-25', subaccountLast4: null }); // 7d
  const hits = subaccountNotOpened([noSub, withSub, recent], TODAY, DEFAULT_CUSTODY_OPTS);
  check('only the old, sub-less deposit fires', hits.length === 1 && hits[0].detail.unit === '1A', String(hits.length));
}

// -------------------------------------------------- allocation_pending
console.log('\nallocation_pending — subaccount open but funds still in Master');
{
  const pending = rec({ inMasterCents: 250000, subaccountLast4: '7788', subaccountOpenedOn: '2025-05-01', stage: 'subaccount_pending' });
  const done1 = rec({ unit: '2B', inMasterCents: 0, subaccountLast4: '7789', subaccountOpenedOn: '2025-05-01', stage: 'in_subaccount' });
  const noSub = rec({ unit: '3C', inMasterCents: 250000, bankClearedOn: '2025-06-01', subaccountLast4: null, stage: 'in_master' }); // float owns this
  const hits = allocationPending([pending, done1, noSub], TODAY, DEFAULT_CUSTODY_OPTS);
  check('only the open-subaccount-but-pooled record fires', hits.length === 1 && hits[0].detail.unit === '1A', String(hits.length));
  check('no double-count with master_account_float', masterAccountFloat([noSub], TODAY, DEFAULT_CUSTODY_OPTS).length === 1
    && allocationPending([noSub], TODAY, DEFAULT_CUSTODY_OPTS).length === 0);
}

// -------------------------------------------------- funds_returned_not_refunded
console.log('\nfunds_returned_not_refunded — bank returned it, tenant never paid');
{
  const overdue = rec({ stage: 'funds_returned', fundsReturnedOn: '2025-07-01', fundsReturnedCents: 240000, refundedOn: null }); // 31d
  const withinClock = rec({ unit: '2B', stage: 'funds_returned', fundsReturnedOn: '2025-07-28', fundsReturnedCents: 240000, refundedOn: null }); // 4d
  const refunded = rec({ unit: '3C', stage: 'refunded', fundsReturnedOn: '2025-07-01', refundedOn: '2025-07-05' });
  const hits = fundsReturnedNotRefunded([overdue, withinClock, refunded], TODAY, DEFAULT_CUSTODY_OPTS);
  check('both unrefunded returns fire, refunded one does not', hits.length === 2, String(hits.length));
  const od = hits.find(h => h.detail.unit === '1A')!;
  const wc = hits.find(h => h.detail.unit === '2B')!;
  check('past 14 days → critical + overdue', od.severity === 'critical' && od.detail.overdue === true);
  check('within 14 days → high, not overdue', wc.severity === 'high' && wc.detail.overdue === false);
  check('flags amount actually returned', od.amountCents === 240000);
}

// -------------------------------------------------- vacated_subaccount_open
console.log('\nvacated_subaccount_open — tenant gone, subaccount still open');
{
  const open = rec({ vacateDate: '2025-05-01', stage: 'active', subaccountLast4: '7788', bankAccountClosedOn: null }); // 92d
  const closed = rec({ unit: '2B', vacateDate: '2025-05-01', stage: 'closed', refundedOn: '2025-05-10' });
  const recent = rec({ unit: '3C', vacateDate: '2025-07-20', stage: 'active', subaccountLast4: '7790' }); // 12d
  const hits = vacatedSubaccountOpen([open, closed, recent], TODAY, DEFAULT_CUSTODY_OPTS);
  check('only the long-vacated open subaccount fires', hits.length === 1 && hits[0].detail.unit === '1A', String(hits.length));
}

// -------------------------------------------------- totals + reconciliation
console.log('\ncustodyTotals + reconcileCustodyToBank');
{
  const records = [
    rec({ amountCents: 250000, inMasterCents: 250000, bankClearedOn: '2025-06-01', stage: 'in_master' }),          // pooled, aged
    rec({ unit: '2B', amountCents: 265000, inMasterCents: 0, subaccountLast4: '7788', stage: 'in_subaccount' }),   // in subaccount
    rec({ unit: '3C', amountCents: 180000, inMasterCents: 0, stage: 'funds_returned', fundsReturnedOn: '2025-07-01', fundsReturnedCents: 180000, refundedOn: null }),
  ];
  const t = custodyTotals(records, TODAY, DEFAULT_CUSTODY_OPTS);
  check('total received = sum of deposits', t.totalReceivedCents === 695000, String(t.totalReceivedCents));
  check('in master = pooled sum', t.inMasterCents === 250000, String(t.inMasterCents));
  check('in subaccounts = amount − master, only where a sub exists', t.inSubaccountsCents === 265000, String(t.inSubaccountsCents));
  check('refund pending counted', t.refundPending === 1 && t.refundPendingCents === 180000);
  check('master aged over 30 counted', t.masterAgedOver30 === 1, String(t.masterAgedOver30));
  // held identity: master + subaccounts must not exceed total received
  check('held never exceeds received', t.inMasterCents + t.inSubaccountsCents <= t.totalReceivedCents);

  // custody claims $2,500 pooled; the bank Master shows only $2,000 → −$500 shortfall.
  const r = reconcileCustodyToBank(records, 200000);
  check('custody Master claim summed', r.custodyMasterCents === 250000, String(r.custodyMasterCents));
  check('variance = bank − claim', r.varianceCents === -50000 && r.varianceCents === r.bankMasterCents - r.custodyMasterCents, String(r.varianceCents));
}

// -------------------------------------------------- bank vs accounting recon
console.log('\ncustodyBalanceRecon — per-tenant bank vs accounting');
{
  const records = [
    rec({ bankBalanceCents: 250000, accountingBalanceCents: 250000 }),                 // agrees
    rec({ unit: '2B', bankBalanceCents: 260000, accountingBalanceCents: 265000 }),     // bank short $50
    rec({ unit: '3C', bankBalanceCents: 180000, accountingBalanceCents: null }),       // only bank entered
    rec({ unit: '4D', bankBalanceCents: null, accountingBalanceCents: 90000 }),        // only books entered
    rec({ unit: '5E' }),                                                               // neither
  ];
  const r = custodyBalanceRecon(records);
  check('bank stated sums entered figures', r.bankStatedCents === 690000, String(r.bankStatedCents));
  check('accounting expected sums entered figures', r.accountingExpectedCents === 605000, String(r.accountingExpectedCents));
  check('variance = bank − accounting', r.varianceCents === 85000 && r.varianceCents === r.bankStatedCents - r.accountingExpectedCents);
  check('only rows with BOTH are counted compared', r.comparedCount === 2, String(r.comparedCount));
  check('rows missing a figure are pending', r.pendingCount === 3, String(r.pendingCount));
  const empty = custodyBalanceRecon([rec({})]);
  check('no balances → all zero, one pending', empty.bankStatedCents === 0 && empty.varianceCents === 0 && empty.pendingCount === 1);
}

// -------------------------------------------------- runAll dispatch
console.log('\nrunCustodyDetectors — dispatches every detector, deterministic signatures');
{
  const r = rec({ externalRef: 'R-1', inMasterCents: 250000, bankClearedOn: '2025-01-01', stage: 'in_master', subaccountLast4: null });
  const all = runCustodyDetectors([r], TODAY);
  check('a badly-stuck deposit trips multiple detectors', all.length >= 2, String(all.length));
  const sigs = new Set(all.map(f => f.signature));
  check('signatures are unique per finding', sigs.size === all.length);
  check('signature keys on external ref', [...sigs].every(s => s.endsWith(':R-1')), [...sigs].join(','));
}

done('custody');
