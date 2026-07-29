# deposit-recon

Forensic reconciliation of tenant security deposit escrow accounts.
Separate from BoroBeacon by design: separate Supabase project, separate keys,
separate access list.

## Invariants

These are not style preferences. Each one exists because breaking it produces
wrong numbers that look right.

1. **Money is integer cents.** Signed: credits positive, debits negative.
   No floats anywhere in the pipeline.
2. **Nothing enters without passing the checksum.** Opening + transactions
   must equal closing, to the cent. Failures quarantine for review; they are
   never partially ingested.
3. **Extracted and ledger tables are append-only**, enforced by database
   trigger. Corrections are contra-entries via `reverses_id`.
4. **Every figure traces to a source**: document sha256, page number, line
   number, and the parser id/version that produced it.
5. **Extraction method is recorded.** Machine-read (`pdftotext`, `csv`) and
   model-read (`llm`, `ocr`) numbers must always be distinguishable.

## Layout

    supabase/migrations/0001_init.sql   schema, triggers, tie-out views
    src/parsers/columns.ts              fixed-width column slicing
    src/parsers/escrow.ts               reference bank format
    src/parsers/registry.ts             format detection
    src/checksum.ts                     the gate
    src/pdf.ts                          text extraction, scan detection
    src/ingest.ts                       pipeline
    src/reports/tieout.ts               phase 1 report

## Use

    npm install
    cp .env.example .env          # investigation project only
    npx tsx test/run.ts           # verify parser + gate
    npm run cli -- ingest <bank_account_id> statements/*.pdf
    npm run cli -- tieout

Run the seven-year backfill locally. Vercel hosts the review UI and the
go-forward monthly ingest, where documents arrive one at a time.

## Adding a bank

One parser per bank format, not per building. Copy `src/parsers/escrow.ts`,
adjust the header regexes and column specs, register it. Never force an
existing parser onto an unrecognised layout -- a mis-detected format produces
plausible-looking wrong numbers, which is the failure this system exists to
prevent.

## Reading the tie-out

`ledger_variance` is bank balance against the books: money that left
improperly. `expected_variance` is bank balance against the lease universe,
built independently from lease files: money that never arrived. Only the
second one catches a deposit that was collected and never banked, which is
the more common pattern.
