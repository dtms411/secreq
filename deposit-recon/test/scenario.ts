import { readFileSync } from 'node:fs';
import { escrowParser } from '../src/parsers/escrow.js';
import { harborParser } from '../src/parsers/harbor.js';
import { verify } from '../src/checksum.js';
import { classify, type LedgerLike, type LeaseLike, type TxnLike } from '../src/match/rules.js';
import { makeChecker } from './_assert.js';

// End-to-end: the engines wired together over one fabricated building with
// findings planted on purpose. Proves the pieces compose — parse clears the
// gate, the matcher tiers correctly, and the detectors surface exactly the
// planted issues and nothing else.

process.env.SUPABASE_URL ||= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'placeholder';
const d = await import('../src/exceptions/detectors.js');
type DS = import('../src/exceptions/detectors.js').Dataset;

const { check, done } = makeChecker();

console.log('scenario — parse → gate → match → detect');

// 1. Ingestion: both bank fixtures parse and clear the checksum gate.
const meridian = escrowParser.parse([readFileSync(new URL('./fixture.txt', import.meta.url), 'utf8')]);
const harbor = harborParser.parse([readFileSync(new URL('./fixture_harbor.txt', import.meta.url), 'utf8')]);
check('meridian statement clears the gate', verify(meridian).ok);
check('harbor statement clears the gate', verify(harbor).ok);

// 2. Matching tiers on synthetic candidates.
const leases: LeaseLike[] = [
  { id: 'L_over', tenantName: 'Marsh D', expectedDepositCents: 250000 },
  { id: 'L_ok', tenantName: 'Okonkwo A', expectedDepositCents: 265000 },
];
const ledger: LedgerLike[] = [{ id: 'D1', leaseId: 'L_over', amountCents: 250000, entryDate: '2024-02-05', note: null }];
const exact = classify({ id: 'T1', amountCents: 250000, postedOn: '2024-02-05', descriptor: 'DEPOSIT MARSH' } as TxnLike, ledger, leases);
const fuzzy = classify({ id: 'T2', amountCents: 265000, postedOn: '2024-08-01', descriptor: 'ACH DEPOSIT OKONKWO A' } as TxnLike, [], leases);
check('exact tier fires', exact?.method === 'exact');
check('fuzzy tier fires', fuzzy?.method === 'fuzzy' && fuzzy.leaseId === 'L_ok');

// 3. Detectors over a building with six planted findings and clean elsewhere.
const escrow = { id: 'A1', buildingId: 'B1', type: 'escrow' as const, last4: '0001', isInterestBearing: false };
const ds: DS = {
  accounts: [escrow],
  buildings: [{ id: 'B1', name: 'Maple Court', interestRequired: true }],
  txns: [
    { id: 'c_over', buildingId: 'B1', accountId: 'A1', accountType: 'escrow', amountCents: 250000, postedOn: '2024-02-05', descriptor: 'DEPOSIT MARSH D', checkNo: null, counterparty: null },
    { id: 'c_stale', buildingId: 'B1', accountId: 'A1', accountType: 'escrow', amountCents: 240000, postedOn: '2024-06-05', descriptor: 'DEPOSIT HALE P', checkNo: null, counterparty: null },
    { id: 'd_unexpl', buildingId: 'B1', accountId: 'A1', accountType: 'escrow', amountCents: -150000, postedOn: '2025-03-10', descriptor: 'CHECK PAID - REFUND', checkNo: '5510', counterparty: null },
  ],
  leases: [
    { id: 'L_never', buildingId: 'B1', unit: '1', tenantName: 'Nunez R', signedOn: '2024-01-01', termStart: '2024-01-01', vacatedOn: null, keysReturnedOn: null, monthlyRentCents: 300000, expectedDepositCents: 300000 },
    { id: 'L_over', buildingId: 'B1', unit: '2', tenantName: 'Marsh D', signedOn: '2024-02-01', termStart: '2024-02-01', vacatedOn: null, keysReturnedOn: null, monthlyRentCents: 200000, expectedDepositCents: 250000 },
    { id: 'L_stale', buildingId: 'B1', unit: '3', tenantName: 'Hale P', signedOn: '2024-06-01', termStart: '2024-06-01', vacatedOn: null, keysReturnedOn: '2025-01-01', monthlyRentCents: 240000, expectedDepositCents: 240000 },
  ],
  ledger: [{ id: 'e_stale', leaseId: 'L_stale', entryType: 'initial_deposit', amountCents: 240000, entryDate: '2024-06-05' }],
  matches: [],
  statements: [
    { bankAccountId: 'A1', periodStart: '2025-02-01', periodEnd: '2025-02-28', openingCents: 490000, closingCents: 490000 },
    { bankAccountId: 'A1', periodStart: '2025-04-01', periodEnd: '2025-04-30', openingCents: 600000, closingCents: 600000 },
  ],
};

const found = d.runAllDetectors(ds, d.DEFAULT_DETECTOR_OPTS);
const kinds = new Set(found.map(f => f.kind));

const expected = [
  'deposit_never_banked', 'deposit_exceeds_one_month', 'stale_credit',
  'unexplained_debit', 'missing_statement_period', 'interest_account_noncompliant',
];
for (const k of expected) check(`planted: ${k}`, kinds.has(k), [...kinds].join(','));

const notExpected = ['refund_payee_mismatch', 'refund_without_vacate', 'duplicate_refund', 'escrow_to_operating', 'inter_building_transfer', 'interest_not_allocated'];
for (const k of notExpected) check(`clean: no ${k}`, !kinds.has(k));

// deposit_never_banked must be the L_never lease, not the two that were banked.
const dnb = found.filter(f => f.kind === 'deposit_never_banked');
check('only the unbanked lease is flagged', dnb.length === 1 && dnb[0].leaseId === 'L_never');

done('scenario');
