import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '../db.js';

// Pull statements the office uploaded through the site (they land in the private
// `statements` bucket under `inbox/`) down to the local CLI host, where the
// service key lives and the OCR/gate runs. After a file is processed it is moved
// out of the inbox — to `processed/` if it posted, `quarantine/` if it did not —
// so a re-run never reprocesses the same file and a human can see at a glance
// what still needs attention. The bucket is the collection point; the CLI host
// is where anything is read or written.

const BUCKET = 'statements';
const INBOX = 'inbox';
export const PROCESSED = 'processed';
export const QUARANTINE = 'quarantine';

const SUPPORTED = new Set(['.pdf']);

export interface PulledFile {
  name: string;         // basename within the inbox
  storagePath: string;  // inbox/<name>
  localPath: string;    // where it was written on this host
}

function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

/** Download every supported file from the inbox to destDir. Non-PDFs are left in
 *  place (this runner posts per-tenant PDF statements; CSV/image handling is a
 *  separate path). */
export async function pullInbox(destDir: string): Promise<PulledFile[]> {
  const { data, error } = await db.storage.from(BUCKET).list(INBOX, {
    limit: 1000,
    sortBy: { column: 'name', order: 'asc' },
  });
  if (error) throw error;

  await mkdir(destDir, { recursive: true });
  const out: PulledFile[] = [];
  for (const obj of data ?? []) {
    if (!obj.name || !SUPPORTED.has(ext(obj.name))) continue;
    const storagePath = `${INBOX}/${obj.name}`;
    const dl = await db.storage.from(BUCKET).download(storagePath);
    if (dl.error) throw dl.error;
    const buf = Buffer.from(await dl.data.arrayBuffer());
    const localPath = join(destDir, obj.name);
    await writeFile(localPath, buf);
    out.push({ name: obj.name, storagePath, localPath });
  }
  return out;
}

/** Move a processed inbox object to a destination prefix (processed/quarantine),
 *  so the inbox always reflects only what is still pending. */
export async function moveFromInbox(name: string, destPrefix: string): Promise<void> {
  const from = `${INBOX}/${name}`;
  const to = `${destPrefix}/${name}`;
  const { error } = await db.storage.from(BUCKET).move(from, to);
  // A move failure must not lose the finding — surface it, but do not throw away
  // the posting result the caller already recorded.
  if (error) console.error(`  warning: could not move ${from} → ${to}: ${error.message}`);
}
