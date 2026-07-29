import { parseLeases, type LeaseColumnMap } from '../src/leases/parse.js';
import { makeChecker } from './_assert.js';

const { check, done } = makeChecker();

console.log('lease loader — parse + expected universe');

const csv = [
  'Building,Unit,Tenant,Signed,TermStart,TermEnd,Vacated,KeysReturned,Rent,Deposit,RS',
  '9281 Shore Road,4B,Rivera M,2024-03-15,2024-04-01,2025-03-31,,,2400.00,2400.00,no',
  '9281 Shore Road,2R,Okonkwo A,2024-04-10,2024-05-01,,2025-06-30,2025-07-05,2650.00,2650.00,no',
  '9281 Shore Road,1A,Delacroix H,2023-01-05,2023-02-01,,,,3000.00,3300.00,yes',
  '9281 Shore Road,,BAD ROW,,,,,,,,',
].join('\n');

const map: LeaseColumnMap = {
  buildingKey: 'Building', unit: 'Unit', tenantName: 'Tenant', signedOn: 'Signed',
  termStart: 'TermStart', termEnd: 'TermEnd', vacatedOn: 'Vacated', keysReturnedOn: 'KeysReturned',
  monthlyRent: 'Rent', expectedDeposit: 'Deposit', rentStabilized: 'RS',
};

const { records, problems, notes } = parseLeases(csv, map);

check('three good rows parsed', records.length === 3, String(records.length));
check('one bad row reported', problems.length === 1, String(problems.length));

const okonkwo = records.find(r => r.tenantName === 'Okonkwo A')!;
check('money is integer cents', okonkwo.monthlyRentCents === 265000 && okonkwo.expectedDepositCents === 265000);

// keys_returned_on is kept distinct from vacated_on — it starts the 14-day clock.
check('keys_returned distinct from vacated', okonkwo.vacatedOn === '2025-06-30' && okonkwo.keysReturnedOn === '2025-07-05');

const delacroix = records.find(r => r.tenantName === 'Delacroix H')!;
check('rent-stabilized flag parsed', delacroix.isRentStabilized === true);
check('deposit-over-one-month noted (GOL §7-108)', notes.some(n => /exceeds one month/.test(n.note)));

// expected universe = sum of expected deposits for tenants not yet vacated.
// (Mirrors v_building_tieout.expected_cents, which filters vacated_on is null.)
const expectedUniverse = records
  .filter(r => !r.vacatedOn)
  .reduce((a, r) => a + r.expectedDepositCents, 0);
check('expected universe excludes vacated tenants', expectedUniverse === 240000 + 330000,
  String(expectedUniverse)); // Rivera (active) + Delacroix (active); Okonkwo vacated

done('leases');
