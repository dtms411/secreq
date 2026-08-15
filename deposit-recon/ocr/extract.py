"""Extract structured, checksum-validated data from scanned escrow statements.

Five bank formats appear in this matter, all scanned images:

  capital_one  Capital One "Escrow Express" — master + per-tenant subaccount
               table; a printed grand total lets us validate to the cent.
  apple        Apple Bank "Lease Security" — a 1-page master, plus a
               Landlord/Agent detail report giving unit + tenant + deposit,
               grouped by building, with a landlord grand total.
  mt           M&T "Escrow Services" — master summary box + activity.
  flagstar     Flagstar "Lease Security" — master summary + activity.
  santander    Santander "Master Escrow Self-Service Checking" — balances box
               + activity.

Money is ALWAYS integer cents. Nothing is trusted on OCR alone: each statement
is validated against its own printed totals (master: opening + credits − debits
= closing; Capital One / Apple: Σ subaccounts = printed grand total). A
statement that does not tie is marked checksum_ok=false so the downstream loader
quarantines it instead of posting wrong numbers — the same gate the machine-read
pipeline uses.

Usage:  python3 ocr/extract.py <statement.pdf> [more.pdf ...]   # prints JSON
"""

from __future__ import annotations
import json
import re
import sys
from ocrtext import ocr_pages

# Matches $1,234.56 | 1234.56 | .00 | (1,234.56) | 217.99-  (leading-dot amounts
# like ".00" are common in these statements and must not be dropped).
MONEY = re.compile(r"(?<![\d.])-?\$?\(?(?:\d{1,3}(?:,\d{3})*|\d+)?\.\d{2}\)?-?")
DATE = r"\d{1,2}[-/]\d{1,2}(?:[-/]\d{2,4})?"


# --------------------------------------------------------------- money
def to_cents(raw: str | None) -> int | None:
    if raw is None:
        return None
    s = raw.strip()
    if not s:
        return None
    neg = s.startswith("(") or s.endswith("-") or s.startswith("-")
    digits = re.sub(r"[^0-9.]", "", s)
    if not digits or digits == ".":
        return None
    if "." in digits:
        whole, frac = digits.split(".", 1)
        cents = int(whole or "0") * 100 + int((frac + "00")[:2])
    else:
        cents = int(digits) * 100
    return -cents if neg else cents


def fmt(cents: int | None) -> str:
    if cents is None:
        return "—"
    sign = "-" if cents < 0 else ""
    a = abs(cents)
    return f"{sign}${a // 100:,}.{a % 100:02d}"


def moneys(line: str) -> list[int]:
    return [c for c in (to_cents(m) for m in MONEY.findall(line)) if c is not None]


def amount_after(text: str, label: str, within: int = 60) -> int | None:
    """First money value appearing after a label (same or next line)."""
    m = re.search(label, text, re.I)
    if not m:
        return None
    tail = text[m.end(): m.end() + 400]
    mm = MONEY.search(tail[:within]) or MONEY.search(tail)
    return to_cents(mm.group(0)) if mm else None


# --------------------------------------------------------------- buildings
# The DITMAS portfolio (name only — enough to match a statement's entity/label).
BUILDINGS = [
    "120 East 89th Street", "160 E. 89th Street", "200 E. 15th St.", "211 West 102nd Street",
    "245 West 72nd Street", "245 West 75th Street", "247 West 72nd Street", "310 E. 75th Street",
    "347 East 58th St", "349 East 58th St", "351 East 58th St", "437 W. 48th Street",
    "4580 Broadway", "530 East 88th St", "534 East 88th St.", "676 Broadway",
    "68-70 Irving Place", "77 Irving Place", "3640 Johnson Avenue", "1279 E. 17 Street",
    "1654 E. 13th Street", "2126 Benson Avenue", "477 3rd St", "5501 15th Avenue",
    "8210 19th Avenue", "9269 Shore Road", "9281 Shore Road", "9747 Shore Road",
    "109-05 72nd Avenue", "109-20 71st Road", "111-10 76th Road", "111-20 76th Road",
    "111-50 76th Road", "111-55 77th Avenue", "143-25 41 Avenue", "35-53 82 Street",
    "35-54 83 Street", "65-41 Saunders Street", "68-60 108th Street", "69-81 108th Street",
    "70-11 108th Street", "72-17 34th Avenue", "72-38 113th Street", "72-72 112th Street",
    "77-44/54 Austin Street", "87-60 113th Street",
]
_DIGITS = [(b, re.sub(r"\D", "", b)) for b in BUILDINGS]

# Address-less entities → building(s). Filled in as the office provides the list.
ENTITY_OVERRIDES: dict[str, list[str]] = {
    # "JPS 050 REALTY LLC": ["<building name>"],
}


def match_buildings(label: str) -> list[str]:
    """Best-effort building match from an entity name or in-statement building
    label. Matches on the digit stream so compressed forms resolve
    ('10920 71ST' → '109-20 71st Road', '5501/8760' → both buildings)."""
    key = label.strip().upper()
    for k, v in ENTITY_OVERRIDES.items():
        if k.upper() in key:
            return v
    hits: list[str] = []
    for run in re.findall(r"\d{3,}", label):
        for name, dig in _DIGITS:
            if dig.startswith(run) and name not in hits:
                hits.append(name)
    return hits


def find_entity(text: str) -> str | None:
    m = re.search(r"^\s*([A-Z0-9][A-Z0-9 &/#.'-]{3,}?\s+LLC)\b", text, re.M)
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else None


def find_period(text: str):
    m = re.search(r"(\d{2})[-/](\d{2})[-/](\d{2,4})\s*(?:TO|THROUGH|-)\s*(\d{2})[-/](\d{2})[-/](\d{2,4})", text, re.I)
    if not m:
        return None, None

    def iso(mm, dd, yy):
        yy = yy if len(yy) == 4 else "20" + yy
        return f"{yy}-{mm}-{dd}"
    return iso(m[1], m[2], m[3]), iso(m[4], m[5], m[6])


# --------------------------------------------------------------- detection
def detect_bank(text: str) -> str | None:
    """Identify the bank from several signals — the stylized logos often OCR to
    noise, so we also key off distinctive layout text and each bank's address."""
    t = text.upper()
    if "ESCROW EXPRESS" in t or "CAPITAL ONE" in t:
        return "capital_one"
    if "M&T" in t or "MANUFACTURERS AND TRADERS" in t or "M&T ESCROW" in t:
        return "mt"
    if "FLAGSTAR" in t or "LEASE SECURITY LANDLORD" in t:
        return "flagstar"
    if "SANTANDER" in t or "SELF-SERVICE CHECKING" in t:
        return "santander"
    if ("APPLE BANK" in t or "SCARSDALE" in t or "RECREDIT" in t
            or ("LANDLORD/AGENT" in t and "SECURITY DEP" in t)):
        return "apple"
    return None


# --------------------------------------------------------------- per-bank
def running_balances(text):
    """The balance column from the activity table — the last money on each line
    that begins with a date or a Beginning/Ending Balance marker. The sequence of
    running balances is what the transaction deltas are derived from."""
    bals = []
    for ln in text.splitlines():
        s = ln.strip()
        if re.match(rf"(?:{DATE}\b|Beginning|Ending)", s, re.I):
            ms = moneys(s)
            if ms:
                bals.append(ms[-1])
    return bals


def parse_activity_master(text, *, acct_re, period_text, opening_lbl, closing_lbl,
                          credit_lbl, debit_lbl, service_lbl=None):
    """Activity-style banks. Two independent reads that must agree: the printed
    summary box (opening/credits/debits/closing) and the activity running
    balance (opening=first, closing=last, credits/debits = ±deltas). When the
    scan garbles the summary box, the running balance carries it; when both read,
    they cross-check. checksum_ok only when opening + credits − debits = closing."""
    acct = None
    am = re.search(acct_re, text)
    if am:
        acct = am.group(1)
    ps, pe = find_period(period_text)

    # summary box (may be garbled by OCR)
    s_open = amount_after(text, opening_lbl)
    s_close = amount_after(text, closing_lbl)
    s_cred = amount_after(text, credit_lbl)
    s_deb = amount_after(text, debit_lbl)
    service = amount_after(text, service_lbl) if service_lbl else 0

    # activity running balance (independent)
    bals = running_balances(text)
    a_open = bals[0] if bals else None
    a_close = bals[-1] if len(bals) > 1 else None
    a_cred = a_deb = None
    if len(bals) > 1:
        deltas = [bals[i + 1] - bals[i] for i in range(len(bals) - 1)]
        a_cred = sum(d for d in deltas if d > 0)
        a_deb = -sum(d for d in deltas if d < 0)

    # THE checksum is the printed summary box: opening + credits − debits = closing.
    # (The activity running balance is tautologically self-consistent — first +
    # Σdeltas ≡ last — so it can cross-reference a value but can NEVER on its own
    # validate the statement.) A garbled/unreadable box → checksum_ok=False →
    # quarantine for a review pass, never a posted guess.
    box_delta = None
    if None not in (s_open, s_close, s_cred, s_deb):
        box_delta = s_open + abs(s_cred) - abs(s_deb) - abs(service or 0) - s_close
    ok = box_delta == 0

    # independent agreement between the two reads (evidence, not the gate)
    agree = None
    if s_open is not None and a_open is not None and s_close is not None and a_close is not None:
        agree = abs(s_open) == abs(a_open) and abs(s_close) == abs(a_close)

    return {
        "master_account": acct, "period_start": ps, "period_end": pe,
        "opening_cents": s_open if s_open is not None else a_open,
        "closing_cents": s_close if s_close is not None else a_close,
        "credit_cents": abs(s_cred) if s_cred is not None else None,
        "debit_cents": abs(s_deb) if s_deb is not None else None,
        "service_cents": service,
        "activity_open_cents": a_open, "activity_close_cents": a_close,
        "summary_box_read": None not in (s_open, s_close, s_cred, s_deb),
        "activity_agrees": agree,
        "checksum_ok": ok, "master_delta_cents": box_delta,
    }


def parse_capital_one(pages):
    text = "\f".join(pages)
    acct = re.search(r"MASTER ACCOUNT (?:NUMBER|NBR)[:\s]*?(\d{6,})", text, re.I)
    ps, pe = find_period(text)
    sweep = amount_after(text, r"MASTER ESCROW BALANCE[^:]*:") or amount_after(text, r"CURRENT BALANCE:")
    dda = amount_after(text, r"DEMAND DEPOSIT ACCOUNT BALANCE SHOULD BE")
    gt = re.search(r"TOTALS FOR ALL SUB ACCOUNTS\s+(\d+)\s+SUB ACCOUNTS", text, re.I)
    n_reported = int(gt.group(1)) if gt else None
    grand = None
    if gt:
        after = text[gt.end(): gt.end() + 200]
        ms = moneys(after.splitlines()[1] if "\n" in after else after)
        grand = ms[-1] if ms else None

    subs = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        am = re.search(r"\b(1000\d{6})\b", lines[i])
        if am and "TOTALS" not in lines[i]:
            name = re.sub(r"\s+", " ", lines[i][:am.start()]).strip(" -")
            item = balance = initial = open_on = None
            closed = False
            for j in (i + 1, i + 2):
                if j >= len(lines):
                    break
                if "CLOSED" in lines[j].upper():
                    closed = True
                nums = moneys(lines[j])
                if nums:
                    tok = lines[j].split()
                    item = tok[0] if tok else None
                    initial, balance = nums[0], (0 if closed else nums[-1])
                    om = re.search(r"OPEN\s+(\d{2})/(\d{2})/(\d{2})", "\n".join(lines[j:j + 2]))
                    if om:
                        open_on = f"20{om[3]}-{om[1]}-{om[2]}"
                    i = j
                    break
            subs.append({"item": item, "unit": item, "tenant": name, "account": am.group(1),
                         "initial_cents": initial, "balance_cents": balance,
                         "open_on": open_on, "closed": closed})
        i += 1

    sub_total = sum(s["balance_cents"] or 0 for s in subs)
    tie = (grand is not None and sub_total == grand)
    entity = find_entity(text)
    return {
        "bank": "capital_one", "master_account": acct.group(1) if acct else None,
        "entity_name": entity, "buildings": match_buildings(entity or ""),
        "period_start": ps, "period_end": pe,
        "master_sweep_cents": sweep, "dda_should_be_cents": dda,
        "subaccounts": subs, "subaccount_count": len(subs), "reported_count": n_reported,
        "subaccount_total_cents": sub_total, "grand_total_cents": grand,
        "checksum_ok": bool(tie),
        "subaccount_delta_cents": (sub_total - grand) if grand is not None else None,
    }


def parse_apple(pages):
    text = "\f".join(pages)
    acct = re.search(r"Account number\s*[:\s]*?(\d{6,})", text, re.I)
    # Detail (Landlord/Agent) report if it has building sections.
    if re.search(r"Building Number", text, re.I):
        subs = []
        cur_building = None
        lines = text.splitlines()
        for idx, line in enumerate(lines):
            bm = re.search(r"Building Number\s+(.+?)\s*$", line, re.I)
            if bm:
                cur_building = bm.group(1).strip()
                continue
            # Each tenant spans two lines: "<acct#> <NAME…> <security-dep> <int>"
            # then "<apt#> … <balance> <last-dep>". Name + balance on line 1, the
            # apartment on line 2.
            rm = re.match(r"\s*(\d{8,})\s+(.+?)\s+(\d{1,3}(?:,\d{3})*\.\d{2})\b", line)
            if rm:
                unit = None
                if idx + 1 < len(lines):
                    um = re.match(r"\s*(\d{1,4}[A-Z]?|[A-Z]\d{1,3})\b", lines[idx + 1])
                    if um:
                        unit = um.group(1)
                subs.append({"account": rm[1], "unit": unit, "tenant": rm[2].strip(),
                             "balance_cents": to_cents(rm[3]),
                             "building_label": cur_building,
                             "buildings": match_buildings(cur_building or "")})
        grand = amount_after(text, r"Landlord Totals For All Buildings", within=400) \
            or amount_after(text, r"Security Dep\.")
        sub_total = sum(s["balance_cents"] or 0 for s in subs)
        return {
            "bank": "apple", "kind": "landlord_detail",
            "master_account": acct.group(1) if acct else None,
            "entity_name": find_entity(text),
            "buildings": sorted({b for s in subs for b in s["buildings"]}),
            "subaccounts": subs, "subaccount_count": len(subs),
            "subaccount_total_cents": sub_total, "grand_total_cents": grand,
            "checksum_ok": bool(grand is not None and sub_total == grand),
            "subaccount_delta_cents": (sub_total - grand) if grand is not None else None,
        }
    # Otherwise the 1-page master (daily activity).
    r = parse_activity_master(
        text, acct_re=r"Account number\s*[:\s]*?(\d{6,})", period_text=text,
        opening_lbl=r"Beginning balance", closing_lbl=r"Ending balance",
        credit_lbl=r"Total additions", debit_lbl=r"Total subtractions")
    r.update({"bank": "apple", "kind": "master", "entity_name": find_entity(text),
              "buildings": match_buildings(find_entity(text) or "")})
    return r


def parse_mt(pages):
    text = "\f".join(pages)
    r = parse_activity_master(
        text, acct_re=r"ACCOUNT NUMBER\s+(\d{6,})", period_text=text,
        opening_lbl=r"BEGINNING BALANCE", closing_lbl=r"ENDING BALANCE",
        credit_lbl=r"DEPOSITS & CREDITS", debit_lbl=r"LESS CHECKS & DEBITS",
        service_lbl=r"LESS SERVICE CHARGES")
    r.update({"bank": "mt", "entity_name": find_entity(text),
              "buildings": match_buildings(find_entity(text) or "")})
    return r


def parse_flagstar(pages):
    text = "\f".join(pages)
    acct = re.search(r"Account Number\s*(X*\d{3,})", text, re.I)
    r = parse_activity_master(
        text, acct_re=r"Account Number\s*(X*\d{3,})", period_text=text,
        opening_lbl=r"Beginning Balance", closing_lbl=r"Ending Balance",
        credit_lbl=r"Credit\(s\) This Period", debit_lbl=r"Debit\(s\) This Period")
    ps, pe = find_period(text)
    if not pe:
        em = re.search(r"Statement Ending\s+(\d{2})/(\d{2})/(\d{4})", text, re.I)
        if em:
            r["period_end"] = f"{em[3]}-{em[1]}-{em[2]}"
    r.update({"bank": "flagstar", "master_account": acct.group(1) if acct else None,
              "entity_name": find_entity(text), "buildings": match_buildings(find_entity(text) or "")})
    return r


def parse_santander(pages):
    text = "\f".join(pages)
    r = parse_activity_master(
        text, acct_re=r"Account #\s*(\d{6,})", period_text=text,
        opening_lbl=r"Beginning Balance", closing_lbl=r"Ending Balance",
        credit_lbl=r"Deposits/Credits", debit_lbl=r"Withdrawals/Debits")
    # account label often carries the building(s), e.g. "5501/8760 C A S LLC #1"
    lbl = re.search(r"^\s*(\d[\d/ ]*\d[A-Z0-9 &/#.'-]*LLC[^\n]*)", text, re.M)
    label = lbl.group(1).strip() if lbl else (find_entity(text) or "")
    r.update({"bank": "santander", "entity_name": label,
              "buildings": match_buildings(label)})
    return r


PARSERS = {"capital_one": parse_capital_one, "apple": parse_apple, "mt": parse_mt,
           "flagstar": parse_flagstar, "santander": parse_santander}


def extract(pdf_path: str) -> dict:
    # OCR page 1 first to detect the bank; only the per-tenant formats
    # (Capital One, Apple's landlord-detail) need every page — the activity-style
    # masters put their whole summary on page 1, so we skip OCR'ing the rest.
    first = ocr_pages(pdf_path, max_pages=1)
    bank = detect_bank("\f".join(first))
    full = None
    if bank is None:  # page-1 probe inconclusive (garbled logo) — try full doc
        full = ocr_pages(pdf_path)
        bank = detect_bank("\f".join(full))
    if not bank:
        return {"source_file": pdf_path, "bank": None, "error": "unrecognized bank format"}
    # Capital One and Apple carry per-tenant detail across all pages; Apple is
    # small, so always read it in full rather than trust a single-page probe.
    need_full = bank in ("capital_one", "apple")
    pages = full if full is not None else (ocr_pages(pdf_path) if need_full else first)
    result = PARSERS[bank](pages)
    result["source_file"] = pdf_path
    result["pages"] = len(pages)
    result["extract_method"] = "ocr"
    return result


if __name__ == "__main__":
    out = [extract(p) for p in sys.argv[1:]]
    print(json.dumps(out, indent=2, default=str))
