import type { StatementParser } from './types.js';
import { escrowParser } from './escrow.js';

// One entry per bank format. Tune against a real statement before use.

const PARSERS: StatementParser[] = [escrowParser];

export function register(p: StatementParser) {
  PARSERS.push(p);
}

export function selectParser(firstPage: string): StatementParser {
  const hits = PARSERS.filter(p => p.detect(firstPage));
  if (hits.length === 0) {
    throw new Error(
      'no parser matched this statement. Add a TemplateConfig for this bank ' +
      'rather than forcing an existing one -- a mis-detected format produces ' +
      'plausible-looking wrong numbers.'
    );
  }
  if (hits.length > 1) {
    throw new Error(`ambiguous format, matched: ${hits.map(h => h.id).join(', ')}`);
  }
  return hits[0];
}

export function listParsers() {
  return PARSERS.map(p => ({ id: p.id, version: p.version }));
}
