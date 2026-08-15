# OCR statement extraction

Every escrow statement in this matter is a **scanned image** (no text layer), so
the machine-read `pdftotext` parsers in `../src/parsers/` do not apply. This
module renders each page, OCRs it, and extracts structured, **checksum-validated**
data for the five banks in the portfolio.

    ocrtext.py   render (pdftoppm) + auto-orient (tesseract OSD) + OCR, cached
    extract.py   bank detection, per-bank parsers, building match, validation, CLI

    python3 ocr/extract.py statement.pdf [more.pdf ...]   # prints JSON

Requires `poppler-utils`, `tesseract-ocr`, `tesseract-ocr-osd`, and `python3-pil`.

## The five formats

| Bank | Layout | What we extract |
|------|--------|-----------------|
| Capital One | "Escrow Express" | master + per-tenant subaccount table; printed grand total |
| Apple Bank | "Lease Security" + Landlord/Agent detail | 1-page master; **unit + tenant + deposit per building** |
| M&T | "Escrow Services" | master summary box + activity |
| Flagstar | "Lease Security" | master summary + activity |
| Santander | "Master Escrow Self-Service Checking" | balances box + activity |

Detection is multi-signal (the stylized logos often OCR to noise, so we also key
off distinctive layout text and each bank's address). Scans are auto-rotated via
tesseract OSD before OCR.

## The checksum gate — nothing is trusted on OCR alone

Each statement is validated against **its own printed totals**, exactly like the
machine-read pipeline:

- **Activity banks** (M&T, Flagstar, Santander, Apple-master): the printed
  summary box must satisfy `opening + credits − debits = closing`. The activity
  running balance is a cross-reference only — it is tautologically
  self-consistent (`first + Σdeltas ≡ last`), so it can never validate on its own.
- **Per-tenant banks** (Capital One, Apple-detail): the parsed subaccount
  balances must sum to the statement's printed grand total.

A statement that does not tie to the cent is marked `checksum_ok: false` so the
loader **quarantines** it for a review pass — it never posts a misread.

## Current validation status (July-2026 samples)

| Statement | Result | Note |
|-----------|--------|------|
| Flagstar — 477 3rd St | ✅ ties | 58.36 + 221.47 − 217.99 = 61.84 |
| Apple master — SYDNEY REALTY | ✅ ties | 412.18 + 8.97 − .00 = 421.15 |
| M&T — 530 East 88th | ⏸ quarantine | summary box OCR'd garbled |
| Santander — 5501/8760 | ⏸ quarantine | debit figure OCR'd garbled |
| Capital One — 109-20 71st | ⏸ quarantine | 54/67 tenants, Σ short of grand total |
| Apple detail — SYDNEY REALTY | ⏸ quarantine | 76 tenants (unit+name+balance), Σ ~97% of grand total |

The two that OCR cleanly validate to the cent; the rest **correctly quarantine**
— the gate is doing its job. Pushing the quarantined ones to a tie is an
OCR-hardening task (higher DPI, per-column crops / deskew, or a table-aware OCR
engine), plus capturing the Santander subaccount page (page 2) which was missing
from the sample. The extractor still emits the best-effort per-tenant roster for
review even when a statement is quarantined.

## Building match

`match_buildings()` resolves a statement's entity/label to portfolio buildings by
digit stream, so compressed forms resolve (`10920 71ST` → 109-20 71st Road;
`5501/8760` → both buildings). Address-less entities (`JPS 050 REALTY`,
`C A S LLC`) are placed via `ENTITY_OVERRIDES`, filled in as the office provides
the entity→building list.
