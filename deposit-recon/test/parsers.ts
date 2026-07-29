import { readFileSync } from 'node:fs';
import { selectParser } from '../src/parsers/registry.js';
import { verify } from '../src/checksum.js';
import { makeChecker } from './_assert.js';

const { check, done } = makeChecker();

const meridian = readFileSync(new URL('./fixture.txt', import.meta.url), 'utf8');
const harbor = readFileSync(new URL('./fixture_harbor.txt', import.meta.url), 'utf8');

console.log('parser registry');

// Each fixture selects exactly one parser — no ambiguity, no misdetection.
const pM = selectParser(meridian);
const pH = selectParser(harbor);
check('meridian selects escrow parser', pM.id === 'escrow-columnar', pM.id);
check('harbor selects harbor parser', pH.id === 'harbor-trailing-minus', pH.id);

// Harbor: different layout (single amount column, trailing-minus debits, no
// year on dates) parses and clears the gate.
const sh = pH.parse([harbor]);
check('harbor account last4', sh.accountLast4 === '8830', sh.accountLast4);
check('harbor period', sh.periodStart === '2025-05-01' && sh.periodEnd === '2025-05-31');
check('harbor txn count', sh.transactions.length === 3, String(sh.transactions.length));
const debit = sh.transactions.find(t => t.amountCents < 0);
check('harbor trailing-minus debit parsed negative', debit?.amountCents === -180000, String(debit?.amountCents));
check('harbor checksum balances', verify(sh).ok);

// A deliberately corrupted copy must fail the gate (task 1 done-when).
const corrupted = harbor.replace('73,644.10\n\n  Page', '73,644.11\n\n  Page'); // closing balance tampered by 1c
const sc = pH.parse([corrupted]);
const rc = verify(sc);
check('corrupted harbor copy fails the gate', !rc.ok, rc.message.slice(0, 40));

// An unrecognised statement is refused, not force-fit.
let refused = false;
try { selectParser('FIRST NATIONAL OF NOWHERE — checking summary'); } catch { refused = true; }
check('unknown layout is refused', refused);

done('parsers');
