import { makeParser } from './template.js';
import type { StatementParser } from './types.js';

// Second bank format, expressed as a TemplateConfig rather than a bespoke
// parser -- most layouts are config, not code. Harbor differs from Meridian in
// every way that matters to a parser: a single Amount column with a trailing
// minus for debits (not separate debit/credit columns), dates without a year,
// and "Opening/Closing Balance" wording. Detection keys on the bank name, so it
// can never collide with Meridian's escrow-phrase detection.
//
// NOTE: this is fitted to a SYNTHETIC fixture, like Meridian's escrow parser.
// Neither has been validated against a real statement from these banks. Task 1
// is not done until each is refitted to genuine PDFs and every statement in the
// real sample set clears the checksum gate.

export const harborParser: StatementParser = makeParser({
  id: 'harbor-trailing-minus',
  version: '0.1.0',
  detect: /HARBOR NATIONAL BANK/i,
  period: /Statement Period:\s+(?<start>\d{2}\/\d{2}\/\d{4})\s+through\s+(?<end>\d{2}\/\d{2}\/\d{4})/i,
  opening: /Opening Balance:\s+\$?(?<amount>[\d,]+\.\d{2})/i,
  closing: /Closing Balance:\s+\$?(?<amount>[\d,]+\.\d{2})/i,
  accountLast4: /Account No:\s+[\*\dX]*?(?<last4>\d{4})\b/i,
  // A transaction row: MM/DD, description, an amount (optional trailing minus),
  // then the running balance. The two-space gap before the amount keeps a
  // description with internal spaces from being swallowed into it.
  txnLine: /^\s*(?<date>\d{2}\/\d{2})\s+(?<desc>.+?)\s{2,}(?<amount>[\d,]+\.\d{2}-?)\s+(?<balance>[\d,]+\.\d{2})\s*$/,
  ignore: [
    /Opening Balance|Closing Balance/i,
    /^\s*Date\s+Description/i,
    /^[\s\-=_]+$/,
    /^\s*Page\s+\d+/i,
  ],
  dateFormat: 'MM/DD',
  debitStyle: 'trailing_minus',
});
