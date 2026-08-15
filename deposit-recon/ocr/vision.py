"""Claude-vision reader — the accurate, table-aware primary read.

tesseract is cheap and independent but only ~97% on dense scanned tables. A
vision model reads these escrow tables far more accurately AND is an engine that
fails differently from tesseract, so it is the ideal second (or primary)
independent read for the consensus gate in verify.py.

This reader renders each page and asks Claude to transcribe the sub-account rows
as strict JSON — digits exactly as printed, no arithmetic, no guessing. It NEVER
decides what is trustworthy: its output is just one more independent read that
verify.py must reconcile against tesseract AND the statement's printed totals. A
value it reports is posted only if another independent read agrees and the
arithmetic ties; otherwise it is quarantined. So even a vision misread cannot
produce a wrong posted number.

Guarded on ANTHROPIC_API_KEY; returns [] when unset so the pipeline still runs on
tesseract consensus alone. No SDK dependency — talks to the Messages API over
https directly (api.anthropic.com is reachable through the agent proxy).
"""

from __future__ import annotations
import base64
import json
import os
import subprocess
import tempfile
import urllib.request
from pathlib import Path

MODEL = os.environ.get("SECREQ_VISION_MODEL", "claude-opus-4-8")
API = "https://api.anthropic.com/v1/messages"

PROMPT = (
    "This is one page of a bank ESCROW statement listing tenant sub-accounts. "
    "Transcribe EVERY sub-account row you can see. For each row output an object "
    "with: account (the account number digits, exactly as printed), unit (the "
    "apartment/item id if shown, else null), tenant (the name), balance_cents "
    "(the CURRENT BALANCE / security-deposit amount as an INTEGER number of cents, "
    "e.g. $2,498.75 -> 249875; a closed account -> 0). Transcribe digits EXACTLY; "
    "do NOT compute, round, or infer any value — if a digit is unreadable, set "
    "balance_cents to null. Also output grand_total_cents (the printed 'totals for "
    "all sub accounts' current-balance total for the page, else null) and "
    "reported_count (printed sub-account count, else null). "
    'Respond with ONLY JSON: {"rows":[...],"grand_total_cents":..,"reported_count":..}'
)


def available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def _render(pdf_path: str, dpi: int = 300) -> list[Path]:
    td = Path(tempfile.mkdtemp(prefix="secreq_vision_"))
    subprocess.run(["pdftoppm", "-png", "-r", str(dpi), pdf_path, str(td / "p")],
                   check=True, capture_output=True)
    return sorted(td.glob("p*.png"))


def _call(png: Path) -> dict:
    b64 = base64.b64encode(png.read_bytes()).decode()
    body = json.dumps({
        "model": MODEL,
        "max_tokens": 8000,
        "messages": [{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
            {"type": "text", "text": PROMPT},
        ]}],
    }).encode()
    req = urllib.request.Request(API, data=body, headers={
        "content-type": "application/json",
        "x-api-key": os.environ["ANTHROPIC_API_KEY"],
        "anthropic-version": "2023-06-01",
    })
    with urllib.request.urlopen(req, timeout=120) as resp:
        payload = json.load(resp)
    text = "".join(part.get("text", "") for part in payload.get("content", []))
    start, end = text.find("{"), text.rfind("}")
    return json.loads(text[start:end + 1]) if start >= 0 else {"rows": []}


def vision_subaccounts(pdf_path: str) -> list[dict]:
    """Independent per-tenant read of a scanned statement. [] if no API key."""
    if not available():
        return []
    rows: list[dict] = []
    for png in _render(pdf_path):
        try:
            page = _call(png)
        except Exception:
            continue  # a failed page just contributes no read; never a wrong one
        for r in page.get("rows", []):
            rows.append({"account": str(r.get("account") or "").strip() or None,
                         "unit": r.get("unit"), "tenant": r.get("tenant"),
                         "balance_cents": r.get("balance_cents")})
    return rows


if __name__ == "__main__":
    import sys
    print("ANTHROPIC_API_KEY:", "set" if available() else "unset")
    for f in sys.argv[1:]:
        rows = vision_subaccounts(f)
        print(f"{f}: {len(rows)} rows via claude-vision")
