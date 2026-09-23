"""JSON bridge between the robust OCR gate and the TypeScript custody-balances
runner.

`verify.py` is the gate that decides whether a per-tenant statement's balances
can be trusted (multi-read consensus + the printed grand-total tie, with the
Claude-vision read added when ANTHROPIC_API_KEY is set). `extract.py` adds the
context the gate does not carry: which building each row belongs to, the entity
name, and the statement's report date. This module runs both, merges them, and
prints ONE clean JSON object per file for `src/custody/balancesRun.ts` to act on.

It never posts anything and never lowers the gate. A statement that `verify.py`
quarantines comes through here as status "quarantined" with the offending rows;
the runner posts nothing for it. Only per-tenant statements (Capital One,
Apple's landlord/agent detail) carry postable per-tenant balances — an
activity/master statement comes through as kind "activity" and the runner skips
it (its balance belongs to the master-account flow, not custody_deposits).

    python3 ocr/balancecli.py <statement.pdf> [more.pdf ...]
"""

from __future__ import annotations
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import extract  # noqa: E402
import verify  # noqa: E402
from ocrtext import ocr_pages  # noqa: E402


def _report_date(pdf_path: str) -> str | None:
    """The 'Report Date MM-DD-YY' on the statement header → ISO. This is the
    as-of date for a per-tenant balance snapshot (these reports carry no period
    range). Best-effort; the runner can always override with --as-of."""
    try:
        head = "\f".join(ocr_pages(pdf_path, max_pages=1))
    except Exception:
        return None
    m = re.search(r"Report\s*Date\s*[:\s]*?(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})", head, re.I)
    if not m:
        return None
    mm, dd, yy = m.group(1), m.group(2), m.group(3)
    yy = yy if len(yy) == 4 else "20" + yy
    return f"{yy}-{int(mm):02d}-{int(dd):02d}"


def _account_context(pdf_path: str):
    """From a single extract read: map account -> {building_label, unit}, plus the
    document's distinct building labels and entity name. Used only to attach
    context to the gated rows — never to decide a balance."""
    ctx: dict[str, dict] = {}
    labels: list[str] = []
    entity = None
    try:
        x = extract.extract(pdf_path)
    except Exception:
        return ctx, labels, entity, None
    entity = x.get("entity_name")
    period_end = x.get("period_end")
    for s in x.get("subaccounts", []) or []:
        acct = s.get("account")
        lbl = s.get("building_label")
        if acct:
            ctx[acct] = {"building_label": lbl, "unit": s.get("unit")}
        if lbl and lbl not in labels:
            labels.append(lbl)
    return ctx, labels, entity, period_end


def analyze(pdf_path: str) -> dict:
    try:
        v = verify.verify(pdf_path)
    except Exception as e:
        return {"source_file": pdf_path, "status": "error", "error": str(e)}

    bank = v.get("bank")
    if v.get("error"):
        return {"source_file": pdf_path, "bank": bank, "status": "error",
                "error": v["error"]}

    # Activity/master statements have no per-tenant rows to post here.
    if "accepted" not in v:
        return {"source_file": pdf_path, "bank": bank, "kind": "activity",
                "status": v.get("status"), "postable": False,
                "note": "activity/master statement — not a per-tenant balance report",
                "values": v.get("values"), "gates": v.get("gates")}

    ctx, labels, entity, period_end = _account_context(pdf_path)
    as_of = _report_date(pdf_path) or period_end

    rows = []
    for a in v.get("accepted", []):
        acct = a.get("account")
        c = ctx.get(acct, {})
        rows.append({
            "account": acct,
            "unit": a.get("unit") or c.get("unit"),
            "tenant": a.get("tenant"),
            "balance_cents": a.get("balance_cents"),
            "building_label": c.get("building_label"),
            "confirmed_by": a.get("confirmed_by"),
        })

    # Building labels: the per-row section headers (Apple detail) and the entity
    # name (Capital One has no in-statement building header). Scanned headers OCR
    # poorly, so resolution is NOT done off the raw label — it goes through the
    # curated resolver (digit-stream match + the office's entitymap.json), which
    # returns canonical building names the TS runner binds to building_ids. An
    # address-less landlord entity (e.g. SYDNEY REALTY LLC) resolves only once it
    # is in entitymap.json; until then the doc reports no building and the runner
    # quarantines rather than guessing.
    building_labels = labels or ([entity] if entity else [])
    resolved: list[str] = []
    for lbl in list(labels) + ([entity] if entity else []):
        for name in extract.match_buildings(lbl or ""):
            if name not in resolved:
                resolved.append(name)

    return {
        "source_file": pdf_path,
        "bank": bank,
        "kind": "per_tenant",
        "postable": True,
        "status": v.get("status"),
        "as_of": as_of,
        "entity_name": entity,
        "building_labels": building_labels,
        "buildings_resolved": resolved,
        "grand_total_cents": v.get("grand_total_cents"),
        "accepted_total_cents": v.get("accepted_total_cents"),
        "accepted_count": v.get("accepted_count"),
        "reported_count": v.get("reported_count"),
        "gates": v.get("gates"),
        "reads": v.get("reads"),
        "rows": rows,
        "flagged": v.get("flagged", []),
    }


if __name__ == "__main__":
    out = [analyze(p) for p in sys.argv[1:]]
    # One object per file; a single file still prints a one-element array so the
    # caller parses uniformly.
    print(json.dumps(out, default=str))
