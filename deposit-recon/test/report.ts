import { renderReport, type ReportData } from '../src/reports/report.js';
import { makeChecker } from './_assert.js';

const { check, done } = makeChecker();

console.log('report renderer — machine/model provenance, totals');

const data: ReportData = {
  generatedAt: '2026-07-29',
  buildings: [
    { name: '9281 Shore Road', asOf: '2025-04-30', checksumOk: true, bankCents: 4970625, ledgerCents: 4970625, expectedCents: 5100000, ledgerVarianceCents: 0, expectedVarianceCents: -129375 },
    { name: '114 Nostrand Ave', asOf: '2025-05-31', checksumOk: false, bankCents: 7364410, ledgerCents: 7364410, expectedCents: 7364410, ledgerVarianceCents: 0, expectedVarianceCents: 0 },
  ],
  exceptionsBySeverity: [{ severity: 'critical', count: 2 }, { severity: 'medium', count: 1 }],
  exceptionsByKind: [{ kind: 'deposit_never_banked', severity: 'critical', count: 2, amountCents: 480000 }],
  openDeadlines: 3,
  matchRate: { bankTxns: 100, suggested: 60, decided: 10, exact: 40, fuzzy: 20 },
  extractionMix: [{ method: 'pdftotext', count: 5 }, { method: 'ocr', count: 1 }, { method: 'csv', count: 2 }],
};

const { markdown, json } = renderReport(data);

check('distinguishes machine-read from model-read', /machine-read/.test(markdown) && /model-read/.test(markdown));
check('ocr labelled model-read', /ocr \| 1 \| model-read/.test(markdown));
check('csv labelled machine-read', /csv \| 2 \| machine-read/.test(markdown));
check('portfolio expected variance summed', markdown.includes('-$1,293.75'));
check('flags checksum failure count', /failed the checksum gate for \*\*1\*\*/.test(markdown));
check('auto-match rate shown', markdown.includes('60.0%'));
check('reminds that matches need approval', /requires human approval/.test(markdown));
check('json round-trips', JSON.parse(json).openDeadlines === 3);

done('report');
