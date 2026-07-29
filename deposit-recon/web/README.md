# deposit-recon — review UI

Next.js App Router. The reviewer-facing surface for the reconciliation: read
the tie-out, work the quarantine queue, approve matches, triage exceptions,
upload statements.

## Keys

The deployment carries only the two `NEXT_PUBLIC_*` values in `.env.example`:
the project URL and the **anon** (publishable) key. The service key stays on the
CLI host and never comes here — there is no server route in this app that needs
it. Access is entirely RLS-governed (migration `0003`): `anon` sees nothing,
`authenticated` users (the investigation access list, provisioned in Supabase
Auth) can read and make the two allowed writes — approving a match and triaging
an exception.

## Run

    cp .env.example .env.local     # fill in URL + anon key
    npm install
    npm run dev

## Screens

- `/` — tie-out dashboard (`v_building_tieout`), sorted by expected variance.
- `/quarantine` — statements that failed the checksum gate (`v_quarantine`) plus
  open critical/high exceptions.
- `/matches` — pending proposals; **Approve** sets `decided_by`. Nothing counts
  until a human approves it.
- `/exceptions` — the triage queue; status transitions only, never the figures.
- `/upload` — files go straight from the browser to the private `statements`
  Storage bucket. No file body passes through a Next route, and uploading does
  not ingest — the CLI does that locally.

## Deploy

Vercel, with the two env vars set in the project. Do **not** run the seven-year
backfill here; it is a local, long-running CLI job. This app hosts review and
the go-forward monthly ingest only.
