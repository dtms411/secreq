"""Render a scanned statement PDF to text via poppler + tesseract.

Every bank statement in this matter is a SCANNED image (no text layer), so the
machine-read pdftotext path in src/ does not apply — these are model-read/OCR
(recorded downstream as extract_method='ocr'). This module renders each page to
a PNG (pdftoppm), auto-corrects orientation (some scans are rotated 90°) using
tesseract's OSD, and OCRs it. Text is cached so a statement is OCR'd once.

No numbers are trusted on OCR confidence alone: extract.py validates every
statement against its own printed totals and quarantines any that do not tie.
"""

from __future__ import annotations
import hashlib
import re
import subprocess
import tempfile
from pathlib import Path
from PIL import Image

CACHE = Path(tempfile.gettempdir()) / "secreq_ocr_cache"
CACHE.mkdir(exist_ok=True)


def _sha(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def _rotate_upright(png: Path) -> None:
    """Use tesseract OSD to detect rotation and correct it in place."""
    try:
        osd = subprocess.run(["tesseract", str(png), "stdout", "--psm", "0"],
                             capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return
    m = re.search(r"Rotate:\s*(\d+)", osd)
    deg = int(m.group(1)) if m else 0
    if deg % 360:
        img = Image.open(png)
        img.rotate(-deg, expand=True).save(png)  # OSD 'Rotate' is clockwise-to-correct


def ocr_pages(pdf_path: str, dpi: int = 300, psm: int = 6, max_pages: int | None = None,
              force: bool = False) -> list[str]:
    """Return one OCR'd text string per page (auto-oriented). Cached by content."""
    pdf = Path(pdf_path)
    key = f"{_sha(pdf)}-{dpi}-{psm}-{max_pages}"
    cache_file = CACHE / f"{key}.pages"
    if cache_file.exists() and not force:
        return cache_file.read_text().split("\f")

    with tempfile.TemporaryDirectory() as td:
        cmd = ["pdftoppm", "-png", "-r", str(dpi)]
        if max_pages:
            cmd += ["-f", "1", "-l", str(max_pages)]
        cmd += [str(pdf), f"{td}/p"]
        subprocess.run(cmd, check=True, capture_output=True)
        pages = []
        for png in sorted(Path(td).glob("p*.png")):
            _rotate_upright(png)
            out = subprocess.run(["tesseract", str(png), "stdout", "--psm", str(psm)],
                                 capture_output=True, text=True)
            pages.append(out.stdout)
    cache_file.write_text("\f".join(pages))
    return pages


if __name__ == "__main__":
    import sys
    for f in sys.argv[1:]:
        pages = ocr_pages(f)
        print(f"{f}: {len(pages)} page(s), {sum(len(p) for p in pages)} chars")
