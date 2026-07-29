import { toCents, formatCents } from '../src/parsers/types.js';
import { verify } from '../src/checksum.js';
import { reconcilePortfolio } from '../src/reports/report.js';
import { makeChecker } from './_assert.js';

const { check, done } = makeChecker();

// ---------------------------------------------------------------- toCents
console.log('toCents — string → integer cents');
const toCentsCases: [string, number][] = [
  ['$1,234.56', 123456],
  ['48,750.00', 4875000],
  ['31.25', 3125],
  ['1,234.56-', -123456],   // trailing minus
  ['(1,234.56)', -123456],  // parenthesised
  ['-5', -500],
  ['5', 500],
  ['.50', 50],
  ['1234.5', 123450],       // single decimal padded
  ['0.00', 0],
  ['1,800.00-', -180000],
  ['$0.05', 5],
  ['2,650.00', 265000],
  ['  49,706.25  ', 4970625], // whitespace
  ['1,234.05', 123405],       // leading-zero cents
];
for (const [input, expected] of toCentsCases) {
  check(`toCents("${input}") = ${expected}`, toCents(input) === expected, String(toCents(input)));
}
// Every result is an integer (no float cents ever).
check('toCents always returns an integer', toCentsCases.every(([i]) => Number.isInteger(toCents(i))));

// ---------------------------------------------------------------- formatCents
console.log('\nformatCents — integer cents → display');
const fmtCases: [number, string][] = [
  [123456, '$1,234.56'],
  [-129375, '-$1,293.75'],
  [0, '$0.00'],
  [-250000, '-$2,500.00'],
  [5, '$0.05'],
  [-5, '-$0.05'],
  [4970625, '$49,706.25'],
  [100, '$1.00'],
];
for (const [cents, expected] of fmtCases) {
  check(`formatCents(${cents}) = "${expected}"`, formatCents(cents) === expected, formatCents(cents));
}
// Round-trip: formatCents then toCents recovers the exact integer (incl. sign).
for (const c of [123456, -129375, 0, 5, -5, 4970625, -180000]) {
  check(`round-trip ${c}`, toCents(formatCents(c)) === c, String(toCents(formatCents(c))));
}

// ---------------------------------------------------------------- checksum
console.log('\nchecksum — opening + credits + debits = closing');
{
  const stmt = {
    periodStart: '2025-04-01', periodEnd: '2025-04-30', accountLast4: '0000',
    openingBalanceCents: 4875000,
    closingBalanceCents: 4903125,   // 4,875,000 + 240,000 − 215,000 + 3,125
    transactions: [
      { postedOn: '2025-04-03', amountCents: 240000, descriptor: 'deposit' },
      { postedOn: '2025-04-09', amountCents: -215000, descriptor: 'refund' },
      { postedOn: '2025-04-30', amountCents: 3125, descriptor: 'interest' },
    ],
  };
  const r = verify(stmt);
  check('balanced statement passes', r.ok && r.deltaCents === 0);
  check('credits summed correctly', r.creditCents === 243125, String(r.creditCents));
  check('debits summed correctly (signed)', r.debitCents === -215000, String(r.debitCents));

  const tampered = { ...stmt, transactions: stmt.transactions.slice(0, -1) }; // drop interest
  const rt = verify(tampered);
  check('dropped transaction fails the gate', !rt.ok);
  check('delta equals the removed amount', rt.deltaCents === -3125, String(rt.deltaCents));
}

// ---------------------------------------------- portfolio reconciliation identity
console.log('\nreconcilePortfolio — Escrow held − Lease universe = Expected variance');
{
  const buildings = [
    { bankCents: 4970625, expectedCents: 5100000, expectedVarianceCents: -129375 },
    { bankCents: 7514410, expectedCents: 7514410, expectedVarianceCents: 0 },
    { bankCents: 2400000, expectedCents: 2650000, expectedVarianceCents: -250000 },
    { bankCents: null, expectedCents: 1800000, expectedVarianceCents: null }, // no statement
  ];
  const p = reconcilePortfolio(buildings);
  check('escrow held sums only statements', p.bankTotal === 14885035, String(p.bankTotal));
  check('lease universe excludes no-statement building', p.expectedTotal === 15264410, String(p.expectedTotal));
  check('expected variance = −$3,793.75', p.expectedVar === -379375, String(p.expectedVar));
  // THE identity — the tiles must add up.
  check('IDENTITY: variance === held − universe', p.expectedVar === p.bankTotal - p.expectedTotal);
  check('reconciled count', p.reconciled === 3 && p.noStatement === 1);
}
{
  // Identity holds for any set where every reconciled building's variance is
  // bank − expected (which the tie-out view guarantees).
  const bs = [
    { bankCents: 100, expectedCents: 250, expectedVarianceCents: -150 },
    { bankCents: 900, expectedCents: 400, expectedVarianceCents: 500 },
  ];
  const p = reconcilePortfolio(bs);
  check('identity holds generally', p.expectedVar === p.bankTotal - p.expectedTotal && p.expectedVar === 350);
  check('empty portfolio is all zero', (() => { const z = reconcilePortfolio([]); return z.bankTotal === 0 && z.expectedVar === 0 && z.reconciled === 0; })());
}

done('math');
