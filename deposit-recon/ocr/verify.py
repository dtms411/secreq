"""Robust verification gate — makes a wrong number impossible to post.

No OCR is perfect, so "no errors" cannot come from trusting one read. It comes
from a gate that accepts a value ONLY when both of these hold:

  1. CONSENSUS  — two or more INDEPENDENT reads agree on it to the cent.
                  Independent reads = tesseract at several resolutions/segmentation
                  modes, plus (in production) a Claude-vision read of the page
                  image (vision.py). A garble would have to occur identically
                  across independent engines to slip through — vanishingly likely,
                  and still caught by (2).
  2. ARITHMETIC — the statement's own printed totals prove the set:
                  • activity banks: opening + credits − debits = closing (the box)
                  • per-tenant banks: Σ accepted balances = printed grand total,
                    and accepted count = printed sub-account count.

If EITHER fails, the statement is QUARANTINED and the exact offending rows are
flagged for a human. Nothing partial is ever posted. This mirrors the machine-read
pipeline's checksum gate; it is the same promise applied to model-read scans.

    python3 ocr/verify.py statement.pdf [more.pdf ...]
"""

from __future__ import annotations
import json
import sys

import extract
from extract import fmt, ocr_pages

# Independent tesseract reads: different resolution AND segmentation, so their
# error modes differ. Extend READERS with the Claude-vision reader in production.
TESSERACT_CONFIGS = [(300, 6), (400, 6), (300, 4)]
MIN_AGREE = 2  # a value must be seen identically by at least this many reads


def _tesseract_reads(pdf_path, need_full):
    reads = []
    for dpi, psm in TESSERACT_CONFIGS:
        pages = ocr_pages(pdf_path, dpi=dpi, psm=psm) if need_full \
            else ocr_pages(pdf_path, dpi=dpi, psm=psm, max_pages=1)
        reads.append((f"tesseract@{dpi}/psm{psm}", pages))
    return reads


def _consensus(values: dict[str, int | None]):
    """Given {reader: value}, return (agreed_value, [readers_agreeing]) if at
    least MIN_AGREE readers share one non-None value, else (None, [])."""
    tally: dict[int, list[str]] = {}
    for reader, v in values.items():
        if v is not None:
            tally.setdefault(v, []).append(reader)
    best = max(tally.items(), key=lambda kv: len(kv[1]), default=(None, []))
    return (best[0], best[1]) if len(best[1]) >= MIN_AGREE else (None, [])


# ---------------------------------------------------------- per-tenant banks
def verify_per_tenant(pdf_path, bank, vision_rows=None):
    reads = _tesseract_reads(pdf_path, need_full=True)
    parser = extract.PARSERS[bank]
    parsed = {name: parser(pages) for name, pages in reads}
    if vision_rows is not None:  # an independent Claude-vision read, keyed by account
        parsed["claude-vision"] = {"subaccounts": vision_rows,
                                   "grand_total_cents": None, "reported_count": None}

    # printed anchors: take the grand total / count the reads agree on
    grand, _ = _consensus({r: p.get("grand_total_cents") for r, p in parsed.items()})
    reported, _ = _consensus({r: p.get("reported_count") for r, p in parsed.items()})

    # union of all account keys seen by any reader
    keys = {s.get("account") for p in parsed.values() for s in p["subaccounts"] if s.get("account")}
    accepted, flagged = [], []
    for k in sorted(keys):
        seen = {}
        meta = {}
        for r, p in parsed.items():
            for s in p["subaccounts"]:
                if s.get("account") == k:
                    seen[r] = s.get("balance_cents")
                    meta.setdefault("tenant", s.get("tenant"))
                    meta.setdefault("unit", s.get("unit"))
        val, agree = _consensus(seen)
        if val is not None:
            accepted.append({"account": k, "tenant": meta.get("tenant"), "unit": meta.get("unit"),
                             "balance_cents": val, "confirmed_by": agree})
        else:
            flagged.append({"account": k, "tenant": meta.get("tenant"),
                            "reason": "no consensus on balance", "values_seen": seen})

    acc_total = sum(a["balance_cents"] for a in accepted)
    sum_ties = grand is not None and acc_total == grand
    count_ties = reported is not None and len(accepted) == reported
    consensus_ok = not flagged
    status = "accepted" if (consensus_ok and sum_ties and count_ties) else "quarantined"
    if grand is None:
        flagged.append({"reason": "grand total not read by consensus"})
    return {
        "bank": bank, "status": status,
        "reads": list(parsed.keys()),
        "grand_total_cents": grand, "accepted_total_cents": acc_total,
        "reported_count": reported, "accepted_count": len(accepted),
        "gates": {"row_consensus": consensus_ok, "sum_ties": sum_ties, "count_ties": count_ties},
        "accepted": accepted, "flagged": flagged,
    }


# ---------------------------------------------------------- activity banks
def verify_activity(pdf_path, bank):
    reads = _tesseract_reads(pdf_path, need_full=False)
    parsed = {name: extract.PARSERS[bank](pages) for name, pages in reads}
    fields = ("opening_cents", "closing_cents", "credit_cents", "debit_cents")
    agreed, prov = {}, {}
    for f in fields:
        v, who = _consensus({r: p.get(f) for r, p in parsed.items()})
        agreed[f], prov[f] = v, who
    box_ties = None
    if None not in (agreed["opening_cents"], agreed["closing_cents"],
                    agreed["credit_cents"], agreed["debit_cents"]):
        box_ties = (agreed["opening_cents"] + abs(agreed["credit_cents"])
                    - abs(agreed["debit_cents"]) - agreed["closing_cents"]) == 0
    consensus_ok = all(prov[f] for f in fields)
    status = "accepted" if (box_ties and consensus_ok) else "quarantined"
    return {
        "bank": bank, "status": status, "reads": list(parsed.keys()),
        "values": {f: fmt(agreed[f]) for f in fields},
        "gates": {"box_consensus": consensus_ok, "box_ties": bool(box_ties)},
        "provenance": prov,
    }


PER_TENANT = {"capital_one", "apple"}


def verify(pdf_path, vision_rows=None):
    first = ocr_pages(pdf_path, max_pages=1)
    bank = extract.detect_bank("\f".join(first))
    if bank is None:
        bank = extract.detect_bank(extract.ocr_text(pdf_path)) if hasattr(extract, "ocr_text") \
            else extract.detect_bank("\f".join(ocr_pages(pdf_path)))
    if bank is None:
        return {"source_file": pdf_path, "status": "quarantined", "error": "bank not identified"}
    # Apple's landlord-detail report is per-tenant; its 1-page master is activity.
    per_tenant = bank == "capital_one" or (bank == "apple" and "Building Number" in "\f".join(ocr_pages(pdf_path)))
    if per_tenant and vision_rows is None:
        try:
            import vision
            if vision.available():
                vision_rows = vision.vision_subaccounts(pdf_path)
        except Exception:
            vision_rows = None
    out = verify_per_tenant(pdf_path, bank, vision_rows) if per_tenant else verify_activity(pdf_path, bank)
    out["source_file"] = pdf_path
    out["extract_method"] = "ocr"
    return out


if __name__ == "__main__":
    for p in sys.argv[1:]:
        r = verify(p)
        print(json.dumps(r, indent=2, default=str))
