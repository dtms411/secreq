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
    npm test                      # 8 unit suites, no DB required

    # 1. reference data
    npm run cli -- seed seeds/buildings.csv seeds/accounts.csv

    # 2. bank activity (local, long-running — never through Vercel)
    npm run cli -- ingest <bank_account_id> statements/*.pdf
    npm run cli -- backfill <root> --account <id>          # or --map <dirmap.json>
    npm run cli -- ingest-csv <bank_account_id> export.csv --format fmt.json
    npm run cli -- quarantine <root>                       # files needing review
    npm run cli -- continuity --write                      # gaps in the series

    # 3. independent lease universe (from lease files, NOT the books)
    npm run cli -- leases rentroll.csv --map leasemap.json

    # 3b. operational custody tracker (the office's Master/subaccount control system)
    npm run cli -- custody-import tracker.csv --map custodymap.json
    npm run cli -- custody-detect                          # lifecycle detectors into triage
    npm run cli -- custody-aging --master-balance <cents>  # Master-account aging + custody-vs-bank

    # 4. analysis
    npm run cli -- match                                   # rule-based proposals; a human decides
    npm run cli -- llm-match                               # LLM proposals for the unmatched (needs ANTHROPIC_API_KEY)
    npm run cli -- exceptions                              # run all 12 detectors
    npm run cli -- tieout                                  # phase-1 variance report
    npm run cli -- report recon-report                     # counsel-facing markdown + json

    # 5. daily, from cron
    npm run cli -- deadlines                               # 14-day refund clock

Scanned statements: add `--ocr` to `ingest`/`backfill` to OCR image-only PDFs
(tesseract + pdftoppm). OCR is model-read — recorded as `extract_method='ocr'`
and never conflated with the machine-read text path — and clears the same
checksum gate, so a misread scan quarantines rather than posting wrong numbers.

Run the seven-year backfill locally. Vercel hosts the review UI (`web/`) and the
go-forward monthly ingest, where documents arrive one at a time.

## The pipeline

Each stage writes only what it is entitled to. Bank activity and the tenant
sub-ledger are **independent sources**; their disagreement is the finding, so
nothing derives one from the other.

- **seed** — buildings + bank accounts (the only hand-entered reference data).
- **ingest / backfill / ingest-csv** — statements through the checksum gate.
  PDFs are auto-detected and self-proving (opening + txns = closing). CSVs carry
  no balances, so `ingest-csv` anchors the opening to the prior period's close
  and quarantines a continuity gap rather than bridging it.
- **leases** — the independent baseline, built from lease/rent-roll source
  documents. `keys_returned_on` is distinct from `vacated_on`; it starts the
  14-day clock.
- **match / llm-match** — tiered exact → fuzzy → unmatched, then an optional LLM
  pass over what's left. Every match is a *proposal* (`decided_by = null`, method
  `exact`/`fuzzy`/`llm_suggested`); it counts only once a human approves it. The
  LLM may propose, never post (invariant 6): it suggests a lease and a confidence
  and can reverse-engineer an unfamiliar layout for a human, but it never writes a
  ledger entry, resolves an exception, or sets `decided_by`.
- **exceptions** — twelve detectors (highest value first: `unexplained_debit`,
  `deposit_never_banked`, `refund_payee_mismatch`, …, plus `interest_account_`
  `noncompliant` for GOL §7-103) writing a triaged queue.
- **report** — a counsel-facing Markdown + JSON reconciliation. Machine-read
  (`pdftotext`/`csv`) and model-read (`ocr`/`llm`) figures are reported
  separately and never conflated (invariant 5).
- **deadlines** — the daily 14-day statutory clock, escalating at day 7 / 10 /
  14 and past due. Highest-dollar alert in the system: missing the window
  forfeits the whole deposit, and it runs daily precisely so a monthly cycle
  cannot discover the failure two weeks too late.

## Backfill

`backfill` walks a folder tree and runs every statement through the same
gate as `ingest`. It is resumable and idempotent: a `.backfill-journal.jsonl`
in the root records a terminal status per file, so an interrupted run resumes
without re-touching anything that already landed, and the `documents.sha256`
unique constraint makes re-running the whole tree safe regardless. Each file
must route to a bank account — `--account` for a single-account tree, or
`--map` (parent-directory name → account id) for a mixed one. A file that
cannot be routed errors and is surfaced, never guessed at.

The summary distinguishes ingested / duplicate / quarantined / errored, and
`quarantine <root>` re-prints everything a human still has to look at.

## Period continuity

`continuity` checks each account's statement series for two independent breaks:
a **calendar gap** (the next period does not begin the day after the previous
one ended — a statement is missing) and a **balance break** (the next opening
balance does not equal the previous closing — the running balance was not
carried forward). A missing month is as important as a variance; nothing else
detects it. Report-only by default; `--write` records each break as a
`missing_statement_period` exception. Like the checksum, it never fills a gap
or adjusts a balance — it only reports.

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

## Custody control (the office tracker, tied in)

A colleague's operational tracker — a *Tenant Security Deposit Control System* —
runs alongside this. The office banks with a Santander **Master** (pooled)
account and opens a **per-tenant subaccount** for each deposit, tracking every
deposit through its lifecycle: received → sent to bank → cleared → pooled in
Master → allocated into a subaccount → (on move-out) returned by the bank →
refunded to the tenant → closed. `custody-import` ingests that export into
`custody_deposits` (migration `0005`) through a stable column map, exactly like
leases.

It is a custody **source**, not a second baseline. The tie-out keeps its power
only because bank, sub-ledger, and lease files are independent — so custody rows
are the office's *claims* about where each deposit is, reconciled **against** the
bank, never substituted for the lease universe. `custody_deposits` is the one
mutable operational table (rows advance through stages); every write is still
audit-logged.

`custody-detect` runs six pure lifecycle detectors into the same triage queue:
`master_account_float` (dollars pooled in Master past the aging threshold —
the headline control), `deposit_not_sent_to_bank`, `subaccount_not_opened`,
`allocation_pending`, `funds_returned_not_refunded` (bank returned it, tenant
never paid — the 14-day clock is running), and `vacated_subaccount_open`.
`custody-aging` prints the Master-account aging report (every dollar still
pooled, oldest first) plus the portfolio roll-up, and — given the Santander
Master statement balance via `--master-balance` — reconciles the tracker's
pooled claim against the bank (their disagreement is the finding).

## Review UI (`web/`)

Next.js App Router, deployed on Vercel. Five screens — tie-out dashboard,
custody control (Master-account aging), quarantine queue, match approval,
exception triage — plus direct-to-Storage upload. The browser carries **only** the anon key; every request is `anon` or
`authenticated` and governed by RLS (migration `0003`). Unauthenticated users
see nothing; the set of people who can sign in is the investigation access
list. The **service key never reaches the deployment** — the backfill and all
ingest run locally on the CLI host. Files uploaded through the UI land in a
private Storage bucket; the CLI pulls, hashes, and gates them. See `web/README.md`.

## Migrations

    0001_init.sql   schema, append-only triggers, tie-out views
    0002_recon.sql  normalize_name(), deadline_notifications, open-deadline
                    and match-rate views
    0003_rls.sql    row-level security, security_invoker views, storage bucket
    0004_ingest_txn.sql  atomic ingest RPC (all-or-nothing statement load)
    0005_custody.sql     Master + per-tenant subaccounts, custody_deposits,
                         master-account aging + custody summary views

## Status

The pipeline is built and the pure logic is unit-tested (8 suites, no DB). Not
yet done, because each is blocked on real inputs: the two bank parsers are
fitted to **synthetic** fixtures and must be refitted to genuine PDFs; the
DB-backed runners (ingest, match, exceptions, deadlines) are wired but have not
been exercised against a live project. Load `0001`–`0003` into the investigation
Supabase project, `seed` the 45 buildings, then work `ingest`/`backfill` on the
pilot set to populate `bank_cents` before touching matching.
