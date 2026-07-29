import { readFileSync } from 'node:fs';
import { selectParser } from '../src/parsers/registry.js';
import { verify, diagnose } from '../src/checksum.js';
import { formatCents } from '../src/parsers/types.js';

const text = readFileSync(new URL('./fixture.txt', import.meta.url), 'utf8');

const parser = selectParser(text);
console.log(`parser: ${parser.id}@${parser.version}\n`);

const stmt = parser.parse([text]);

console.log(`account ....${stmt.accountLast4}   period ${stmt.periodStart} -> ${stmt.periodEnd}`);
console.log(`opening ${formatCents(stmt.openingBalanceCents)}   closing ${formatCents(stmt.closingBalanceCents)}\n`);

for (const t of stmt.transactions) {
  const amt = formatCents(t.amountCents).padStart(12);
  console.log(`  ${t.postedOn}  ${amt}  ${t.checkNo ? `#${t.checkNo} ` : '      '} ${t.descriptor}`);
}

const r = verify(stmt);
console.log(`\nchecksum: ${r.message}`);
if (!r.ok) diagnose(r, stmt).forEach(h => console.log(`  hint: ${h}`));

// A dropped row is the failure mode that matters. Prove the gate catches it
// rather than letting a plausible-looking short statement through.
console.log('\n--- tamper test: drop one transaction ---');
const tampered = { ...stmt, transactions: stmt.transactions.slice(0, -1) };
const r2 = verify(tampered);
console.log(`checksum: ${r2.message}`);
diagnose(r2, tampered).forEach(h => console.log(`  hint: ${h}`));

process.exit(r.ok && !r2.ok ? 0 : 1);
