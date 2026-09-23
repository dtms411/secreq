# SecReq — Local Backfill Runbook

This is the step-by-step for running the **bank-balance backfill** on your own
computer. It reads scanned per-tenant subaccount statements (Apple Bank
landlord/agent detail, Capital One Escrow Express), validates each one against
its own printed grand total, and posts the per-tenant **bank balances** into
SecReq — the bank side of the bank-vs-accounting comparison on the Custody page.

Everything here runs **locally**. Your two secrets (the Supabase service key and
the Anthropic key) live only on this machine, in a `.env` file. They are never
sent to Vercel or the website.

**The core promise:** a balance is posted only if the statement ties to the cent
*and* resolves to exactly one building. Anything that doesn't is **quarantined**
— never posted as a guess. You cannot create a wrong number by running this.

---

## 1. One-time setup

### a. Install the tools

You need **Node.js**, **Python 3**, **poppler**, and **tesseract**.

**macOS** (install [Homebrew](https://brew.sh) first if you don't have it):

```bash
brew install node python poppler tesseract
```

**Windows**: install [Node.js LTS](https://nodejs.org) and
[Python 3](https://www.python.org/downloads/) (check "Add python.exe to PATH"),
then install poppler and tesseract:

```powershell
winget install oschwartz10612.Poppler UB-Mannheim.TesseractOCR
```

Confirm they're found (open a fresh terminal after installing):

```bash
node --version && python3 --version && pdftoppm -h && tesseract --version
```

### b. Install the project dependencies

From inside the `deposit-recon` folder:

```bash
npm install
pip install -r ocr/requirements.txt
```

### c. Create your `.env`

```bash
cp .env.example .env
```

Open `.env` and fill in three values:

| Variable | Where to get it |
|---|---|
| `SUPABASE_URL` | Supabase → your SecReq project → Project Settings → Data API → Project URL |
| `SUPABASE_SERVICE_KEY` | Supabase → Project Settings → API Keys → **service_role** key (secret) |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys |

> **Never** put these in Vercel or anywhere near the website. This `.env` file is
> git-ignored and stays on this computer only.

The Anthropic key is what makes dense scanned tables read accurately. Without it
the run still works, but it will quarantine far more statements (it falls back to
OCR-only, which can't read crowded tables cleanly).

### d. (Optional) Entity map for address-less landlords

Some statements show a landlord/agent name with no street address the matcher can
resolve (e.g. `SYDNEY REALTY LLC`, `JPS 050 REALTY`, `C A S LLC`). Map those to
their building(s) once:

```bash
cp ocr/entitymap.example.json ocr/entitymap.json
```

Edit `ocr/entitymap.json` — keys are the entity text, values are building names
exactly as they appear in SecReq. You can also fill this in later; until an
entity is mapped, its statement simply quarantines with a message telling you
what to add.

---

## 2. Getting statements to the runner

Two options — use whichever is easier:

- **From the website:** on SecReq, go to **Upload evidence** and drag the PDFs
  in. They land in the private `statements` bucket. The runner pulls them with
  `--bucket` (below), and afterward moves each one into a `processed/` or
  `quarantine/` folder in that bucket so you can see what still needs a look.
- **From a local folder:** just point the runner at the PDF files on your disk.

---

## 3. Run it

**Always dry-run first.** A dry run reads and validates everything and writes
**nothing** — it shows you exactly what *would* post.

### Known-answer check (do this once)

Run the 70-11 108th Street Apple statement you already have. It should tie to
**$213,598.95** across 79 tenants. This proves your setup (keys, OCR, vision)
is working before you trust it on the rest:

```bash
npm run cli -- custody-balances /path/to/Apple_70-11.pdf --dry-run
```

You want to see `[posted]` (in a dry run this means "would post") with
`79 tenants` and an as-of date. If instead you see `[quarantined]`, your
Anthropic key isn't set or the scan is too poor — see Troubleshooting.

### Process the website inbox

```bash
# dry run first — nothing is written
npm run cli -- custody-balances --bucket --dry-run

# then for real
npm run cli -- custody-balances --bucket
```

### Process a local folder

```bash
# a shell glob expands to every PDF in the folder
npm run cli -- custody-balances /path/to/statements/*.pdf --dry-run
npm run cli -- custody-balances /path/to/statements/*.pdf
```

### Useful flags

- `--dry-run` — validate and report, write nothing.
- `--as-of YYYY-MM-DD` — set the balance date if a statement has no readable
  "Report Date" (the run will warn you when this is missing).
- `--bucket` — also pull and process the website's upload inbox.

### After a run

- Balances show up on the **Custody** page under *Bank vs. accounting — per
  tenant* (the "Bank says" column). The variance stays "needs both" until the
  accounting figures are entered — that's expected.
- See what still needs attention any time:

  ```bash
  npm run cli -- custody-balances-status
  ```

---

## 4. What each result means

| Result | Meaning | What to do |
|---|---|---|
| `posted` | Tied to the cent, resolved to one building, balances written. | Nothing. |
| `quarantined` | Didn't tie, or the building couldn't be resolved. **Nothing was posted.** | Read the message; usually add the entity to `entitymap.json`, or the scan needs a cleaner copy. |
| `skipped` | Not a per-tenant statement (e.g. an activity/master statement). | Nothing — those aren't handled by this command. |
| `errored` | The file couldn't be read at all. | Check it's a real statement PDF. |

Re-running is always safe: it updates the same subaccounts in place (matched by
account number), it never duplicates, and it never overwrites accounting figures
or other custody fields — only the bank column.

---

## 5. Troubleshooting

- **Everything quarantines with "sum … vs total …"** — your `ANTHROPIC_API_KEY`
  probably isn't set (OCR-only can't read dense tables). Confirm it's in `.env`.
- **"building unresolved — add … to ocr/entitymap.json"** — the statement's
  landlord/agent name has no resolvable address. Add it to `entitymap.json`
  (step 1d) and re-run.
- **"NO as-of date"** — the statement had no readable Report Date. Re-run that
  file with `--as-of YYYY-MM-DD`.
- **"tesseract"/"pdftoppm" not found** — re-open your terminal after installing,
  or reinstall per step 1a.
- **Windows: "python3 is not recognized"** — Windows often installs Python as
  `python`. Run the commands with `set PYTHON=python` first (or
  `$env:PYTHON="python"` in PowerShell), then the `npm run cli -- …` command.
- **"SUPABASE_URL and SUPABASE_SERVICE_KEY must be set"** — your `.env` is
  missing or incomplete (step 1c).
