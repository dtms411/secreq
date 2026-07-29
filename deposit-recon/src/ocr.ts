import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

// OCR for scanned statements. A scan has no text layer, so pdftotext returns
// nothing and the statement would quarantine. OCR renders each page to an image
// and reads it with tesseract. Crucially, OCR output clears the SAME checksum
// gate as everything else — digit confusion (8/3, 5/6, 1/7) is precisely the
// error mode the gate exists to catch, so a misread scan fails arithmetic and
// quarantines rather than posting wrong numbers. Extraction method is recorded
// as 'ocr' (model-read), never conflated with the machine-read pdftotext path.
//
// NOTE: tesseract does not preserve column alignment the way `pdftotext -layout`
// does, so the fixed-offset columnar parser may not align OCR'd tables. When it
// can't, the row is skipped or the gate fails — both safe. A bank with scanned
// statements will usually need a parser tuned to its OCR output specifically.

export async function ocrAvailable(): Promise<boolean> {
  try {
    await run('tesseract', ['--version']);
    await run('pdftoppm', ['-v']);
    return true;
  } catch {
    return false;
  }
}

/** Render each page to a PNG and OCR it, returning text per page (page numbers
 *  preserved so every figure keeps its provenance). */
export async function ocrPages(pdfPath: string, pageCount: number, dpi = 300): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-'));
  try {
    const pages: string[] = [];
    for (let p = 1; p <= pageCount; p++) {
      const prefix = join(dir, `p${p}`);
      await run('pdftoppm', ['-png', '-r', String(dpi), '-f', String(p), '-l', String(p), pdfPath, prefix]);
      const png = (await readdir(dir)).find(f => f.startsWith(`p${p}`) && f.endsWith('.png'));
      if (!png) { pages.push(''); continue; }
      // --psm 6: a uniform block of text. -c preserve_interword_spaces keeps as
      // much horizontal structure as tesseract can, to help the columnar parser.
      const { stdout } = await run('tesseract', [
        join(dir, png), 'stdout', '--psm', '6', '-c', 'preserve_interword_spaces=1',
      ]);
      pages.push(stdout);
    }
    return pages;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
