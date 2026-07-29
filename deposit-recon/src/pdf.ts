import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const run = promisify(execFile);

export async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function pageCount(path: string): Promise<number> {
  const { stdout } = await run('pdfinfo', [path]);
  const m = stdout.match(/^Pages:\s+(\d+)/m);
  return m ? Number(m[1]) : 0;
}

/**
 * Extract text page by page. -layout preserves column alignment, which the
 * table regexes depend on; without it every row collapses into prose.
 * Pages are kept separate so every parsed figure retains a page number.
 */
export async function extractPages(path: string): Promise<string[]> {
  const n = await pageCount(path);
  const pages: string[] = [];
  for (let p = 1; p <= n; p++) {
    const { stdout } = await run('pdftotext', ['-layout', '-f', String(p), '-l', String(p), path, '-']);
    pages.push(stdout);
  }
  return pages;
}

/**
 * A PDF with almost no extractable text is a scan. That needs OCR, and OCR
 * output must clear the same checksum gate -- digit confusion (8/3, 5/6) is
 * exactly the error mode the gate exists to catch.
 */
export function looksScanned(pages: string[]): boolean {
  const chars = pages.join('').replace(/\s/g, '').length;
  return chars / Math.max(pages.length, 1) < 100;
}
