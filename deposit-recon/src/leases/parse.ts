import { parse } from 'csv-parse/sync';
import { toCents, ParseError } from '../parsers/types.js';

// The lease universe is the independent baseline. It is built from lease files
// and rent-roll history -- deliberately NOT from the accounting system, which
// is the thing under test. A deposit that was collected and never banked only
// shows up because this side was assembled from source documents.
//
// keys_returned_on is a first-class field, distinct from vacated_on: it starts
// the statutory 14-day clock. A tenant can vacate weeks before returning keys
// (or return keys without formally vacating). Collapsing the two would either
// start the clock early (false alarms) or late (missed the irreversible
// deadline). They are never merged.

export interface LeaseRecord {
  buildingKey: string;          // matched to buildings.name or buildings.bbl
  unit: string;
  tenantName: string;
  signedOn?: string;
  termStart: string;
  termEnd?: string;
  vacatedOn?: string;
  keysReturnedOn?: string;
  monthlyRentCents: number;
  expectedDepositCents: number;
  isRentStabilized: boolean;
  sourceRef?: string;           // e.g. lease filename / bates number
}

export interface LeaseParseResult {
  records: LeaseRecord[];
  problems: { line: number; reason: string }[];
  /** Non-fatal advisories a human should see (e.g. deposit over one month). */
  notes: { line: number; note: string }[];
}

export interface LeaseColumnMap {
  buildingKey: string;
  unit: string;
  tenantName: string;
  signedOn?: string;
  termStart: string;
  termEnd?: string;
  vacatedOn?: string;
  keysReturnedOn?: string;
  monthlyRent: string;
  expectedDeposit: string;
  rentStabilized?: string;
  sourceRef?: string;
}

function optDate(raw: string | undefined): string | undefined {
  const t = (raw ?? '').trim();
  if (!t) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const p = t.split(/[\/\-]/);
  if (p.length === 3) {
    let [mm, dd, yy] = p;
    if (yy.length === 2) yy = `20${yy}`;
    return `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  throw new ParseError(`unparseable date: ${raw}`);
}

function truthy(raw: string | undefined): boolean {
  return /^(y|yes|true|1|stabilized|rs)$/i.test((raw ?? '').trim());
}

export function parseLeases(text: string, cm: LeaseColumnMap): LeaseParseResult {
  const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  const records: LeaseRecord[] = [];
  const problems: { line: number; reason: string }[] = [];
  const notes: { line: number; note: string }[] = [];

  rows.forEach((row, i) => {
    const line = i + 2; // header is line 1
    const get = (k?: string) => (k ? (row[k] ?? '').trim() : '');
    try {
      const buildingKey = get(cm.buildingKey);
      const unit = get(cm.unit);
      const tenantName = get(cm.tenantName);
      const termStart = optDate(get(cm.termStart));
      if (!buildingKey || !unit || !tenantName) throw new ParseError('missing building, unit, or tenant');
      if (!termStart) throw new ParseError('missing term start');

      const monthlyRentCents = toCents(get(cm.monthlyRent));
      const expectedDepositCents = toCents(get(cm.expectedDeposit));
      if (monthlyRentCents <= 0) throw new ParseError('monthly rent must be positive');
      if (expectedDepositCents <= 0) throw new ParseError('expected deposit must be positive');

      const vacatedOn = optDate(get(cm.vacatedOn));
      const keysReturnedOn = optDate(get(cm.keysReturnedOn));

      // GOL §7-108 caps a security deposit at one month's rent. This is a note,
      // not a load failure -- deposit_exceeds_one_month is a detector that will
      // formalise it as an exception.
      if (expectedDepositCents > monthlyRentCents) {
        notes.push({ line, note: `deposit ${expectedDepositCents}c exceeds one month rent ${monthlyRentCents}c (GOL §7-108)` });
      }
      if (keysReturnedOn && vacatedOn && keysReturnedOn < vacatedOn) {
        notes.push({ line, note: `keys returned (${keysReturnedOn}) before vacate date (${vacatedOn}) — verify` });
      }

      records.push({
        buildingKey, unit, tenantName,
        signedOn: optDate(get(cm.signedOn)),
        termStart,
        termEnd: optDate(get(cm.termEnd)),
        vacatedOn,
        keysReturnedOn,
        monthlyRentCents,
        expectedDepositCents,
        isRentStabilized: truthy(get(cm.rentStabilized)),
        sourceRef: get(cm.sourceRef) || undefined,
      });
    } catch (e) {
      problems.push({ line, reason: (e as Error).message });
    }
  });

  return { records, problems, notes };
}
