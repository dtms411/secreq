import { classify, extractPayer, nameSimilarity, type LedgerLike, type LeaseLike, type TxnLike } from '../src/match/rules.js';
import { makeChecker } from './_assert.js';

const { check, done } = makeChecker();

console.log('matching — tiered, proposal only');

const leases: LeaseLike[] = [
  { id: 'L1', tenantName: 'Rivera M', expectedDepositCents: 240000 },
  { id: 'L2', tenantName: 'Okonkwo A', expectedDepositCents: 265000 },
];

// ---- exact: amount + date window (+ check number in note strengthens it)
const ledger: LedgerLike[] = [
  { id: 'D1', leaseId: 'L1', amountCents: 240000, entryDate: '2025-04-03', note: null },
  { id: 'D2', leaseId: 'L2', amountCents: -215000, entryDate: '2025-04-09', note: 'ck 10442' },
];

const tExact: TxnLike = { id: 'T1', amountCents: 240000, postedOn: '2025-04-04', descriptor: 'DEPOSIT - RIVERA M UNIT 4B' };
const mExact = classify(tExact, ledger, leases);
check('exact match on amount + date window', mExact?.method === 'exact' && mExact.leaseId === 'L1');

const tCheck: TxnLike = { id: 'T2', amountCents: -215000, postedOn: '2025-04-09', descriptor: 'CHECK PAID - REFUND', checkNo: '10442' };
const mCheck = classify(tCheck, ledger, leases);
check('check number in note yields confidence 1', mCheck?.method === 'exact' && mCheck.confidence === 1);

// ---- fuzzy: payer name vs tenant, amount must still equal the expected deposit
const tFuzzy: TxnLike = { id: 'T3', amountCents: 265000, postedOn: '2025-08-01', descriptor: 'ACH DEPOSIT OKONKWO A UNIT 2R' };
const mFuzzy = classify(tFuzzy, [], leases);
check('fuzzy match on normalized payer', mFuzzy?.method === 'fuzzy' && mFuzzy.leaseId === 'L2');

// ---- name coincidence alone is not enough: wrong amount => no fuzzy match
const tWrongAmt: TxnLike = { id: 'T4', amountCents: 99999, postedOn: '2025-08-01', descriptor: 'ACH DEPOSIT OKONKWO A' };
check('name match with wrong amount does not match', classify(tWrongAmt, [], leases) === null);

// ---- ambiguity: two exact candidates do NOT produce an exact match
const dupLedger: LedgerLike[] = [
  { id: 'D3', leaseId: 'L1', amountCents: 240000, entryDate: '2025-04-03', note: null },
  { id: 'D4', leaseId: 'L2', amountCents: 240000, entryDate: '2025-04-03', note: null },
];
const mAmbig = classify(tExact, dupLedger, leases);
check('ambiguous exact candidates fall through', mAmbig?.method !== 'exact');

// ---- unmatched: nothing plausible
const tNone: TxnLike = { id: 'T5', amountCents: 5000, postedOn: '2025-04-30', descriptor: 'INTEREST CREDIT' };
check('no candidate => null (recorded as unmatched exception)', classify(tNone, [], leases) === null);

// helpers
check('extractPayer strips verbiage and unit', extractPayer('DEPOSIT - RIVERA M UNIT 4B') === 'rivera m');
check('nameSimilarity self is 1', Math.abs(nameSimilarity('okonkwo a', 'okonkwo a') - 1) < 1e-9);

done('match');
